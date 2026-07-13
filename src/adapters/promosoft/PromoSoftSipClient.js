/**
 * PromoSoftSipClient
 *
 * SIP/UDP client for PromoSoft / GUC Contact Center.
 * Target: prelabel2.guccontactcenter.com · port 5060 · UDP.
 *
 * Implements RFC 3261 SIP REGISTER with RFC 2617 digest authentication.
 * Uses Node.js built-in `dgram` (no external SIP library required).
 *
 * Registration flow:
 *   1. REGISTER (unauthenticated) → 401 Unauthorized with digest challenge
 *   2. REGISTER (Authorization header with MD5 digest) → 200 OK
 *   3. Re-REGISTER timer fires (EXPIRES - 60s) to keep the binding alive
 *
 * NAT traversal:
 *   The Via header includes ;rport so the server responds to the actual
 *   source address/port rather than what the client advertises.
 *   STUN is read from config (PROMOSOFT_STUN_SERVER) but not yet implemented —
 *   rport handles symmetric NAT for most environments.
 *
 * Security:
 *   The password is stored in _session only for keepalive re-REGISTER.
 *   It is never logged. It is cleared when destroy() or unregister() is called.
 */

const dgram = require("node:dgram");
const crypto = require("node:crypto");
const path   = require("node:path");
const appConfig = require("../../config/config");
const logger = require("../../utils/logger").child({ module: "SIP" });
const rtpLogger = logger.child({ module: "RTP" });
const { PromoSoftSipError } = require("./PromoSoftErrors");
const SipDumper = require("./SipDumper");
const eventLoopMonitor = require("../../utils/eventLoopMonitor");

const EXPIRES_SEC = 3600; // requested registration lifetime
const REREGISTER_LEAD_SEC = 60; // refresh this many seconds before expiry
const TRANSACTION_TIMEOUT = 32_000; // RFC 3261 Timer B (max wait for response)

// --- TEMPORARY diagnostic: backend-only RTP test-signal injection ---
// Lets startAudioTest()/stopAudioTest() override _startRtpMediaLoop's outgoing
// payload with a fixed, independently-verified buffer, bypassing the browser
// microphone, resampler, encoder, and WebSocket entirely. Not wired into any
// SIP/call-control path -- only reachable via the explicit debug commands.
const SILENCE_FRAME = Buffer.alloc(160, 0xD5); // PCMA silence (160 bytes = 20ms @ 8kHz)

// Reference A-law encoder used ONLY to build the fixed test tone below.
// Deliberately structurally different (clz32-based segment search) from the
// shift-loop search in LabelPhone/js/audio/g711.js, so this cannot silently
// share the bug under investigation there. Self-verified at module load
// against the ITU-T reference vectors -- throws immediately if wrong rather
// than shipping a bad test signal.
function _alawEncodeIndependent(sample) {
  let pcm = sample | 0;
  const mask = pcm >= 0 ? 0xD5 : 0x55;
  if (pcm < 0) pcm = -pcm - 1;
  if (pcm > 32635) pcm = 32635;

  let seg = 0;
  if (pcm >= 256) {
    seg = 32 - Math.clz32(pcm >> 8); // highest set bit position (1-based) -> segment 1..7
  }
  const mantissaShift = seg === 0 ? 4 : seg + 3;
  const aval = (seg << 4) | ((pcm >> mantissaShift) & 0x0F);
  return (aval ^ mask) & 0xFF;
}

(function _verifyIndependentEncoder() {
  const vectors = [
    [0, 0xD5], [1, 0xD5], [-1, 0x55], [100, 0xD3], [-100, 0x53],
    [1000, 0xFA], [-1000, 0x7A], [5000, 0x86], [-5000, 0x06],
    [10000, 0xB6], [-10000, 0x36], [30000, 0xA8], [-30000, 0x28],
    [32767, 0xAA], [-32768, 0x2A],
  ];
  for (const [input, expected] of vectors) {
    const actual = _alawEncodeIndependent(input);
    if (actual !== expected) {
      throw new Error(
        `PromoSoftSipClient: independent A-law test-tone encoder failed self-check ` +
        `(input=${input} expected=0x${expected.toString(16)} actual=0x${actual.toString(16)}) -- refusing to build test tone`,
      );
    }
  }
})();

// Decoder counterpart of _alawEncodeIndependent, used ONLY for packet-loss
// concealment (see _buildConcealmentFrame): decoding the last real frame to
// PCM before attenuating it lets concealment fade in the linear domain
// instead of scaling A-law bytes directly, which would distort the
// logarithmic encoding. Self-verified by round-tripping through the already
// -verified encoder rather than a second hand-typed vector table.
function _alawDecodeIndependent(alaw) {
  const a = (alaw & 0xFF) ^ 0x55;
  const sign = a & 0x80;
  const seg = (a & 0x70) >> 4;
  const mantissa = a & 0x0F;
  const sample = seg === 0 ? (mantissa << 4) + 8 : ((mantissa << 4) + 0x108) << (seg - 1);
  return sign ? sample : -sample;
}

(function _verifyIndependentDecoder() {
  for (const pcm of [0, 1, -1, 100, -100, 1000, -1000, 5000, -5000, 10000, -10000, 30000, -30000, 32767, -32768]) {
    const decoded = _alawDecodeIndependent(_alawEncodeIndependent(pcm));
    // A-law quantization error grows with segment size; tolerate up to ~10%
    // of magnitude (plus a small floor) rather than expecting exact round-trip.
    const tolerance = Math.max(48, Math.abs(pcm) * 0.1);
    if (Math.abs(decoded - pcm) > tolerance) {
      throw new Error(
        `PromoSoftSipClient: independent A-law decoder failed round-trip self-check ` +
        `(pcm=${pcm} decoded=${decoded} tolerance=${tolerance}) -- refusing to enable concealment`,
      );
    }
  }
})();

/**
 * Decode a 160-byte A-law RTP payload to linear PCM (Int16Array), retained
 * only so packet-loss concealment has something to attenuate/replay across
 * consecutive underruns. Never used on the RTP send path for real frames —
 * those are forwarded byte-for-byte from the browser encoder unchanged.
 */
function _alawFrameToPcm(buf) {
  const out = new Int16Array(buf.length);
  for (let i = 0; i < buf.length; i++) out[i] = _alawDecodeIndependent(buf[i]);
  return out;
}

function _pcmToAlawFrame(pcm) {
  const out = Buffer.alloc(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = _alawEncodeIndependent(pcm[i]);
  return out;
}

/**
 * Packet-loss concealment for a single missing 20ms frame: replays the last
 * real PCM frame received before the underrun, attenuated further on every
 * consecutive lost frame so a run of losses fades toward silence instead of
 * looping unattenuated voiced audio indefinitely. Resets to full gain the
 * next time a real frame is consumed (see the `fromQueue` branch in tick()).
 * Capped at RTP_AUDIO_CONCEALMENT_MAX_FRAMES consecutive frames, after which
 * it falls back to true silence until real audio resumes.
 *
 * Sets session.concealmentActive to tell the caller whether this frame was
 * genuine concealment (for windowed/lifetime concealment counters) or the
 * true-silence fallback beyond the cap (counted as silenceFramesSent instead).
 */
function _buildConcealmentFrame(session, silenceByte) {
  const FRAME_SAMPLES = 160;
  const maxFrames = appConfig.RTP_AUDIO_CONCEALMENT_MAX_FRAMES;
  if (!session.lastRealFramePcm || maxFrames <= 0 || session.concealmentFramesUsed >= maxFrames) {
    session.concealmentActive = false;
    return Buffer.alloc(FRAME_SAMPLES, silenceByte);
  }

  session.concealmentActive = true;
  session.concealmentFramesUsed++;
  session.concealmentFramesTotal++;

  const gain = Math.max(0, 1 - session.concealmentFramesUsed / maxFrames);
  const sourcePcm = session.lastRealFramePcm;
  const outPcm = new Int16Array(FRAME_SAMPLES);
  for (let i = 0; i < FRAME_SAMPLES; i++) {
    outPcm[i] = Math.round(sourcePcm[i] * gain);
  }
  return _pcmToAlawFrame(outPcm);
}

// 1s (50 frames) of a 440Hz/8kHz A-law tone at amplitude 0.25, generated once
// at module load from the verified independent encoder above.
const TEST_TONE_FRAMES = (() => {
  const SR = 8000;
  const FREQ = 440;
  const AMP = 0.25;
  const bytes = Buffer.alloc(SR);
  for (let i = 0; i < SR; i++) {
    const f = Math.sin((2 * Math.PI * FREQ * i) / SR) * AMP;
    let pcm = Math.round(f * 32767);
    if (pcm > 32767) pcm = 32767;
    if (pcm < -32768) pcm = -32768;
    bytes[i] = _alawEncodeIndependent(pcm);
  }
  const frames = [];
  for (let i = 0; i < bytes.length; i += 160) {
    frames.push(bytes.subarray(i, i + 160));
  }
  return frames;
})();

class PromoSoftSipClient {
  constructor(config) {
    this._config = config;
    this._socket = null;
    this._localIp = null;
    this._localPort = null;
    this._rinstance = null; // stable per-session Contact rinstance, set in _openSocket()
    this._registered = false;
    // session: extension + password kept for re-REGISTER keepalive only.
    // password is NEVER logged. Cleared on destroy/unregister.
    this._session = null;
    this._keepaliveTimer = null;
    this._calls = new Map();
    // pendingKey `${callId}:${cseq}` → { resolve, reject, timer }
    this._pending = new Map();
    // INVITE transactions: sipCallId → { fromExtension, targetNumber, fromTag, domain, onProvisional, resolve, reject, timer }
    this._invites = new Map();
    // Callback registered by the adapter to be notified of incoming INVITEs and cancellations.
    // Inbound calls are tracked in _calls (direction:"inbound") for their full lifetime.
    this._onIncomingCall = null;
    // Recently-ended sipCallIds (TTL 30s) used to suppress duplicate-BYE warnings.
    this._endedCallIds = new Set();
    // Per-call RTP media sessions: sipCallId → { socket, localPort, remoteIp, remotePort, ... }
    this._rtpSessions = new Map();
    // Callback invoked with each received RTP payload (media bytes, header stripped) for relay to the browser.
    this._onAudioFrame = null;
    // Rolling cursor into [config.rtpPortMin, config.rtpPortMax] for port allocation.
    this._rtpPortCursor = null;
    // Stable SDP session-id/version for this process lifetime (RFC 4566 §5.2 o= line).
    // Using an NTP-epoch second avoids the invalid "0 0" that some Asterisk versions reject.
    this._sdpSessionId = Math.floor(Date.now() / 1000);
    // Raw SIP message dumper — only active when PROMOSOFT_SIP_DUMP=true.
    this._dumper = config.sipDump
      ? new SipDumper(path.resolve(process.cwd(), appConfig.LOG_DIR, "sip"))
      : null;
  }

  get isRegistered() {
    return this._registered;
  }

  /* ── Registration ────────────────────────────────────────────────────── */

  /**
   * Perform SIP REGISTER. Handles the 401 digest challenge cycle automatically.
   * @param {{ extension: string, password: string }} credentials
   * @returns {Promise<{ extension: string }>}
   */
  async register({ extension, password }) {
    await this._openSocket();

    const domain = this._config.serverDomain;
    const host = this._config.sipServer;
    const port = this._config.sipPort;
    const callId = this._newCallId();
    const tag = this._newTag();

    const registerContact = `<${this._contactUri(extension)}>`;
    logger.info(
      { extension, sipLocal: `${this._localIp}:${this._localPort}`, rinstance: this._rinstance, registerContact },
      "PromoSoftSipClient: REGISTER Contact",
    );

    // ── Step 1: Unauthenticated REGISTER ────────────────────────────────
    logger.info(
      { extension, host, port },
      "PromoSoftSipClient: REGISTER (unauthenticated)",
    );
    const res1 = await this._sendAndWait(
      this._buildRegister({ extension, domain, callId, tag, seq: 1 }),
      host,
      port,
      `${callId}:1`,
    );
    if (this._config.debug)
      logger.debug({ extension }, "PromoSoftSipClient: REGISTER #1 sent");

    // No-challenge 200 (unusual but valid)
    if (res1.status === 200) {
      const expiresIn = this._parseExpiresIn(res1.headers);
      this._registered = true;
      this._session = { extension, callId, tag, domain, password };
      this._scheduleReRegister(expiresIn);
      logger.info(
        {
          extension,
          activeCalls: this._calls.size,
          dialogs: this._invites.size,
          rtpSessions: this._rtpSessions.size,
          emittedEvents: ["registered"],
        },
        `PromoSoftSipClient: REGISTER complete - activeCalls=${this._calls.size} dialogs=${this._invites.size} rtpSessions=${this._rtpSessions.size} emitted=registered`,
      );
      logger.info(
        { extension },
        "PromoSoftSipClient: 200 OK - registered (no challenge)",
      );
      if (this._config.debug)
        logger.debug(
          { extension },
          `PromoSoftSipClient: registered extension ${extension}`,
        );
      return { extension, expiresIn };
    }

    // ── Step 2: Digest challenge (401/407) ──────────────────────────────
    if (res1.status !== 401 && res1.status !== 407) {
      throw new PromoSoftSipError(
        `SIP REGISTER unexpected response: ${res1.status} ${res1.reason}`,
        null,
        res1.status,
      );
    }

    if (this._config.debug)
      logger.debug({ extension }, "PromoSoftSipClient: 401 challenge received");

    const wwwAuth =
      res1.headers["www-authenticate"] || res1.headers["proxy-authenticate"];
    if (!wwwAuth) {
      throw new PromoSoftSipError(
        `SIP ${res1.status} but no WWW-Authenticate header`,
        null,
        res1.status,
      );
    }

    const challenge = this._parseDigestChallenge(wwwAuth);
    if (this._config.debug) {
      logger.debug(
        {
          extension,
          realm: challenge.realm,
          qop: challenge.qop || "none",
          algorithm: "MD5",
        },
        `PromoSoftSipClient: realm="${challenge.realm}" qop=${challenge.qop || "none"} algorithm=MD5`,
      );
    }

    // password never appears in any log — only used for the HMAC computation below
    const authz = this._computeDigestAuth({
      extension,
      password,
      realm: challenge.realm,
      nonce: challenge.nonce,
      qop: challenge.qop, // null when server does not offer qop (Asterisk default)
      uri: `sip:${domain}`,
    });

    logger.info(
      { extension },
      "PromoSoftSipClient: : REGISTER (authenticated, password redacted)",
    );
    if (this._config.debug)
      logger.debug(
        { extension },
        "PromoSoftSipClient: REGISTER #2 sent with digest auth",
      );

    const res2 = await this._sendAndWait(
      this._buildRegister({
        extension,
        domain,
        callId,
        tag,
        seq: 2,
        authorization: authz,
      }),
      host,
      port,
      `${callId}:2`,
    );

    // ── Step 3: Final response ───────────────────────────────────────────
    if (res2.status === 200) {
      const expiresIn = this._parseExpiresIn(res2.headers);
      this._registered = true;
      this._session = { extension, callId, tag, domain, password };
      this._scheduleReRegister(expiresIn);
      logger.info(
        {
          extension,
          activeCalls: this._calls.size,
          dialogs: this._invites.size,
          rtpSessions: this._rtpSessions.size,
          emittedEvents: ["registered"],
        },
        `PromoSoftSipClient: REGISTER complete - activeCalls=${this._calls.size} dialogs=${this._invites.size} rtpSessions=${this._rtpSessions.size} emitted=registered`,
      );
      logger.info({ extension }, "PromoSoftSipClient: 200 OK - registered");
      if (this._config.debug) {
        logger.debug(
          { extension },
          "PromoSoftSipClient: REGISTER #2 received 200 OK",
        );
        logger.debug(
          { extension },
          `PromoSoftSipClient: registered extension ${extension}`,
        );
      }
      return { extension, expiresIn };
    }

    throw new PromoSoftSipError(
      `SIP REGISTER failed: ${res2.status} ${res2.reason}`,
      null,
      res2.status,
    );
  }

  /**
   * Unregister by sending REGISTER with Expires: 0.
   *
   * Most SIP servers (including Asterisk/GUC) require digest authentication even
   * for de-registration. We mirror the register() two-step flow:
   *   1. Send REGISTER Expires:0 (unauthenticated).
   *   2. If the server returns 401/407, compute digest from the stored session
   *      password and send an authenticated REGISTER Expires:0.
   *
   * @returns {Promise<void>}
   */
  async unregister() {
    this._clearKeepalive();
    if (!this._registered || !this._session) {
      this._closeSocket();
      return;
    }
    const { extension, callId, tag, domain, password } = this._session;

    logger.info(
      { extension },
      "PromoSoftSipClient: unregister - sending REGISTER Expires: 0",
    );

    try {
      // ── Step 1: Unauthenticated REGISTER Expires:0 ──────────────────────
      const msg1 = this._buildRegister({
        extension,
        domain,
        callId,
        tag,
        seq: 99,
        expires: 0,
      });
      if (this._config.debug) {
        logger.debug(
          { extension, direction: "OUT" },
          `PromoSoftSipClient: UNREGISTER step1 SIP packet:\n${msg1}`,
        );
      }

      const res1 = await this._sendAndWait(
        msg1,
        this._config.sipServer,
        this._config.sipPort,
        `${callId}:99`,
      );

      logger.info(
        { extension, status: res1.status, reason: res1.reason },
        "PromoSoftSipClient: unregister step 1 response",
      );
      if (this._config.debug) {
        logger.debug(
          { extension, headers: res1.headers },
          "PromoSoftSipClient: UNREGISTER step1 response headers",
        );
      }

      if (res1.status === 200) {
        logger.info(
          { extension },
          "PromoSoftSipClient: unregistered (Expires: 0 accepted without auth)",
        );
      } else if (res1.status === 401 || res1.status === 407) {
        // Server requires digest auth — same challenge/response flow as register()
        logger.info(
          { extension, status: res1.status },
          "PromoSoftSipClient: unregister auth challenge received - retrying with digest",
        );

        const wwwAuth =
          res1.headers["www-authenticate"] ||
          res1.headers["proxy-authenticate"];
        if (!wwwAuth) {
          logger.warn(
            { extension, status: res1.status },
            "PromoSoftSipClient: unregister challenge missing WWW-Authenticate header - server may retain binding until expiry",
          );
        } else {
          const challenge = this._parseDigestChallenge(wwwAuth);
          if (this._config.debug) {
            logger.debug(
              {
                extension,
                realm: challenge.realm,
                qop: challenge.qop || "none",
              },
              "PromoSoftSipClient: unregister digest challenge",
            );
          }

          // password is used here only for the MD5 digest computation — never logged
          const authz = this._computeDigestAuth({
            extension,
            password,
            realm: challenge.realm,
            nonce: challenge.nonce,
            qop: challenge.qop,
            uri: `sip:${domain}`,
          });

          // ── Step 2: Authenticated REGISTER Expires:0 ────────────────────
          const msg2 = this._buildRegister({
            extension,
            domain,
            callId,
            tag,
            seq: 100,
            expires: 0,
            authorization: authz,
          });
          logger.info(
            { extension },
            "PromoSoftSipClient: unregister - sending authenticated REGISTER Expires: 0",
          );
          if (this._config.debug) {
            logger.debug(
              { extension, direction: "OUT", realm: challenge.realm },
              `PromoSoftSipClient: UNREGISTER step2 SIP packet:\n${msg2}`,
            );
          }

          const res2 = await this._sendAndWait(
            msg2,
            this._config.sipServer,
            this._config.sipPort,
            `${callId}:100`,
          );

          logger.info(
            { extension, status: res2.status, reason: res2.reason },
            "PromoSoftSipClient: unregister step 2 response",
          );
          if (res2.status === 200) {
            logger.info(
              { extension },
              "PromoSoftSipClient: unregistered (Expires: 0 authenticated - server confirmed)",
            );
          } else {
            logger.warn(
              { extension, status: res2.status, reason: res2.reason },
              "PromoSoftSipClient: unregister authenticated request rejected - server may retain binding until natural expiry",
            );
          }
        }
      } else {
        logger.warn(
          { extension, status: res1.status, reason: res1.reason },
          "PromoSoftSipClient: unregister unexpected response",
        );
      }
    } catch (err) {
      logger.warn(
        { extension, err: err.message },
        "PromoSoftSipClient: REGISTER Expires=0 error (ignored)",
      );
    }

    this._registered = false;
    this._session = null;
    this._closeSocket();
  }

  /* ── UDP socket ──────────────────────────────────────────────────────── */

  async _openSocket() {
    if (this._socket) return;

    const sock = dgram.createSocket("udp4");
    sock.on("message", (buf, rinfo) => this._onMessage(buf, rinfo));
    sock.on("error", (err) =>
      logger.error({ err: err.message }, "PromoSoftSipClient: socket error"),
    );

    const bindPort = this._config.sipBindPort || 0;
    await new Promise((resolve, reject) => {
      sock.bind(bindPort, (err) => (err ? reject(err) : resolve()));
    });

    this._socket = sock;
    this._localPort = sock.address().port;
    this._localIp = await this._probeLocalIp();
    // Stable per-session rinstance (RFC-adjacent convention used by 3CX/softphones):
    // identifies this UA instance across re-REGISTERs so the PBX's Contact binding
    // stays anchored to the exact URI used in every subsequent 200 OK.
    this._rinstance = crypto.randomBytes(4).toString("hex");

    logger.info(
      {
        localIp:   this._localIp,
        localPort: this._localPort,
        stable:    bindPort > 0 ? `${this._localIp}:${bindPort}` : "(dynamic)",
        rinstance: this._rinstance,
      },
      "PromoSoftSipClient: SIP socket bound",
    );
  }

  /**
   * Build the Contact URI (no angle brackets, no header params) for this UA,
   * using the last-known-stable UDP REGISTER shape.
   *
   * Keep REGISTER/OPTIONS Contact deliberately plain. PromoSoft's dashboard
   * derives endpoint presence from registration/qualify traffic, and URI
   * parameters here can confuse device-state presentation even though they are
   * legal SIP syntax.
   */
  _contactUri(user) {
    return `sip:${user}@${this._localIp}:${this._localPort}`;
  }

  /**
   * Discover the local IP that can reach the SIP server by using a temporary
   * connected UDP socket (OS routing fills in the right interface — no packets sent).
   */
  async _probeLocalIp() {
    return new Promise((resolve) => {
      const tmp = dgram.createSocket("udp4");
      tmp.connect(this._config.sipPort, this._config.sipServer, () => {
        const ip = tmp.address().address;
        tmp.close();
        resolve(ip);
      });
    });
  }

  _closeSocket() {
    if (!this._socket) return;
    try {
      this._socket.close();
    } catch (_) {}
    this._socket = null;
    this._localIp = null;
    this._localPort = null;
    this._rinstance = null;
  }

  /* ── Incoming message routing ────────────────────────────────────────── */

  _onMessage(buf, rinfo) {
    const text = buf.toString("utf8");
    if (this._config.debug) {
      logger.debug(
        { bytes: buf.length, from: `${rinfo.address}:${rinfo.port}` },
        "PromoSoftSipClient: raw",
      );
      logger.debug(
        { direction: "IN", from: `${rinfo.address}:${rinfo.port}` },
        `PromoSoftSipClient: SIP IN:\n${text}`,
      );
    }

    const parsed = this._parseMessage(text);

    const cseq = parsed.headers?.cseq || "";

    logger.info(
      {
        ...(parsed.status !== null ? { status: parsed.status, reason: parsed.reason } : { method: parsed.method }),
        cseq,
        callId: parsed.headers?.["call-id"],
        ...(parsed.method ? {
          from:    parsed.headers?.["from"],
          to:      parsed.headers?.["to"],
          contact: parsed.headers?.["contact"],
          hasBody: !!parsed.body,
        } : {}),
      },
      "PromoSoftSipClient: ← SIP",
    );

    if (parsed.status !== null) {
      const h = parsed.headers;
      const sipCallId = h["call-id"] || "";
      const cseqFull = h["cseq"] || "";
      const cseqMethod = (cseqFull.match(/\d+\s+(\S+)/) || [])[1] || "";
      const cseqNum = (cseqFull.match(/^(\d+)/) || [])[1] || "0";
      const key = `${sipCallId}:${cseqNum}`;

      if (cseqMethod === "INVITE") {
        const inv = this._invites.get(sipCallId);
        if (inv) {
          const status = parsed.status;
          if (status >= 100 && status <= 199) {
            // Provisional (progress): 100 Trying, 180 Ringing, 183 Session Progress
            logger.info(
              {
                status,
                reason: parsed.reason,
                sipCallId,
                from: inv.fromExtension,
                to: inv.targetNumber,
              },
              "PromoSoftSipClient: ← INVITE progress",
            );
            try {
              inv.onProvisional(status, parsed.reason, h);
            } catch (_) {}
          } else if (status >= 200 && status <= 299) {
            // Final 2xx: accepted — send ACK, resolve, clean up
            clearTimeout(inv.timer);
            this._invites.delete(sipCallId);
            const toTag = (h["to"] || "").match(/tag=([^\s;]+)/i)?.[1] || null;
            // Extract Contact URI from 200 OK for ACK routing (RFC 3261 §13.2.2.4)
            const contactHeader = h["contact"] || "";
            const contactUri    = (contactHeader.match(/<([^>]+)>/) || [])[1] || null;
            // Build Route set from Record-Route reversed (RFC 3261 §12.1.2)
            const recordRoute  = h["record-route"] || "";
            const routeHeaders = recordRoute
              ? recordRoute.split(",").map((r) => r.trim()).reverse()
              : [];
            logger.info(
              {
                status,
                sipCallId,
                from: inv.fromExtension,
                to: inv.targetNumber,
                fromTag: inv.fromTag,
                toTag,
                cseq: inv.cseq,
                contactUri,
                routeCount: routeHeaders.length,
              },
              "PromoSoftSipClient: ← INVITE accepted (2xx)",
            );
            this._sendAck({
              fromExtension: inv.fromExtension,
              targetNumber: inv.targetNumber,
              domain: inv.domain,
              sipCallId,
              fromTag: inv.fromTag,
              toTag,
              cseq: inv.cseq,
              contactUri,
              routeHeaders,
            });
            if (inv.cancelRequested) {
              // RFC 3261 §9.1 glare: the 2xx arrived after we already sent
              // CANCEL. The dialog is now established server-side — ACK it
              // (above), then immediately BYE to tear it down instead of
              // surfacing it as an answered call.
              logger.info(
                { sipCallId, from: inv.fromExtension, to: inv.targetNumber },
                "PromoSoftSipClient: ← INVITE 2xx after CANCEL (glare) — sending BYE to tear down",
              );
              this.bye({
                fromExtension: inv.fromExtension,
                targetNumber: inv.targetNumber,
                sipCallId,
                fromTag: inv.fromTag,
                toTag,
                cseq: inv.cseq + 1,
              }).catch((err) =>
                logger.warn({ sipCallId, err: err.message }, "PromoSoftSipClient: glare BYE error (ignored)"),
              );
              inv.reject(new PromoSoftSipError("SIP INVITE cancelled", null, 487));
              return;
            }
            // Track the established dialog so an incoming remote BYE can be matched
            this._calls.set(sipCallId, {
              fromExtension: inv.fromExtension,
              targetNumber: inv.targetNumber,
              fromTag: inv.fromTag,
              toTag,
              domain: inv.domain,
              onRemoteBye: inv.onRemoteBye,
            });
            // Parse the 200 OK's SDP answer to learn the remote RTP endpoint and
            // negotiated codec, then start the outbound audio relay loop.
            const rtpSession = this._rtpSessions.get(sipCallId);
            if (rtpSession && parsed.body) {
              const answeredCodecs = this._parseSdpCodecs(parsed.body);
              const { remoteIp: sdpRemoteIp, remotePort: sdpRemotePort } = this._parseSdpRemoteRtp(parsed.body);
              const selected = this._selectCodec(answeredCodecs);
              // Browser encoder is A-law-only — accept PCMA only. A PCMU answer
              // would otherwise get A-law bytes mislabeled as mu-law downstream.
              if (sdpRemoteIp && sdpRemotePort && selected.name === "PCMA") {
                rtpSession.remoteIp = sdpRemoteIp;
                rtpSession.remotePort = sdpRemotePort;
                rtpSession.payloadType = selected.payloadType;
                logger.info(
                  { sipCallId, remoteRtp: `${sdpRemoteIp}:${sdpRemotePort}`, selected },
                  "PromoSoftSipClient: outbound RTP — remote endpoint learned from 200 OK",
                );
                this._startRtpMediaLoop(sipCallId);
              } else {
                logger.warn(
                  { sipCallId, sdpRemoteIp, sdpRemotePort, selected },
                  "PromoSoftSipClient: outbound 200 OK — unusable SDP answer (non-PCMA codec or missing RTP endpoint), audio relay skipped",
                );
              }
            } else if (rtpSession) {
              logger.warn({ sipCallId }, "PromoSoftSipClient: outbound 200 OK had no SDP body — audio relay skipped");
            }
            inv.resolve({ status, sipCallId, fromTag: inv.fromTag, toTag, cseq: inv.cseq });
          } else if ((status === 401 || status === 407) && !inv.authAttempted) {
            // Authentication challenge — retry INVITE with digest (same flow as REGISTER)
            inv.authAttempted = true;
            logger.info(
              {
                status,
                sipCallId,
                from: inv.fromExtension,
                to: inv.targetNumber,
              },
              "PromoSoftSipClient: ← INVITE auth challenge — retrying with digest",
            );
            if (!this._session) {
              clearTimeout(inv.timer);
              this._invites.delete(sipCallId);
              inv.reject(
                new PromoSoftSipError(
                  `SIP INVITE ${status}: no session credentials for auth`,
                  null,
                  status,
                ),
              );
              return;
            }
            const wwwAuth = h["www-authenticate"] || h["proxy-authenticate"];
            if (!wwwAuth) {
              clearTimeout(inv.timer);
              this._invites.delete(sipCallId);
              inv.reject(
                new PromoSoftSipError(
                  `SIP INVITE ${status}: missing WWW-Authenticate header`,
                  null,
                  status,
                ),
              );
              return;
            }
            const { extension, password } = this._session;
            const inviteUri = `sip:${inv.targetNumber}@${inv.domain}`;
            const challenge = this._parseDigestChallenge(wwwAuth);
            if (this._config.debug) {
              logger.debug(
                {
                  sipCallId,
                  realm: challenge.realm,
                  qop: challenge.qop || "none",
                },
                "PromoSoftSipClient: INVITE auth challenge params",
              );
            }
            if (inv.cancelRequested) {
              // Hangup was clicked while we were mid-challenge — don't start a
              // fresh transaction we'd immediately have to cancel again.
              clearTimeout(inv.timer);
              this._invites.delete(sipCallId);
              logger.info(
                { sipCallId },
                "PromoSoftSipClient: INVITE auth retry skipped — CANCEL already requested",
              );
              inv.reject(new PromoSoftSipError("SIP INVITE cancelled", null, 487));
              return;
            }
            const authz = this._computeDigestAuth({
              extension,
              password,
              realm: challenge.realm,
              nonce: challenge.nonce,
              qop: challenge.qop,
              uri: inviteUri,
              method: "INVITE",
            });
            inv.cseq += 1;
            inv.branch = this._newBranch();
            const retryMsg = this._buildInvite({
              fromExtension: inv.fromExtension,
              targetNumber: inv.targetNumber,
              domain: inv.domain,
              sipCallId,
              fromTag: inv.fromTag,
              sdp: inv.sdp,
              cseq: inv.cseq,
              authorization: authz,
              branch: inv.branch,
            });
            logger.info(
              {
                sipCallId,
                from: inv.fromExtension,
                to: inv.targetNumber,
                realm: challenge.realm,
                cseq: inv.cseq,
                branch: inv.branch,
              },
              "PromoSoftSipClient: → INVITE (authenticated retry)",
            );
            if (this._config.debug) {
              logger.debug(
                { direction: "OUT", sipCallId },
                `PromoSoftSipClient: INVITE auth retry packet:\n${retryMsg}`,
              );
            }
            const buf = Buffer.from(retryMsg, "utf8");
            this._socket.send(
              buf,
              0,
              buf.length,
              this._config.sipPort,
              this._config.sipServer,
              (err) => {
                if (err) {
                  clearTimeout(inv.timer);
                  this._invites.delete(sipCallId);
                  inv.reject(
                    new PromoSoftSipError(
                      `UDP send failed on INVITE auth retry: ${err.message}`,
                      err,
                    ),
                  );
                }
              },
            );
          } else {
            // 3xx–6xx: final failure (or second 401 — auth gave up).
            // Includes 487 Request Terminated, the PBX's response to our CANCEL.
            clearTimeout(inv.timer);
            this._invites.delete(sipCallId);
            logger.warn(
              {
                status,
                reason: parsed.reason,
                sipCallId,
                from: inv.fromExtension,
                to: inv.targetNumber,
                cancelRequested: inv.cancelRequested,
              },
              "PromoSoftSipClient: ← INVITE failed",
            );
            // RFC 3261 §17.1.1.3: ACK to a non-2xx final response is part of
            // the SAME transaction as the INVITE — reuse its branch and CSeq
            // (not a new transaction like the 2xx-ACK case above).
            const toTag = (h["to"] || "").match(/tag=([^\s;]+)/i)?.[1] || null;
            this._sendAck({
              fromExtension: inv.fromExtension,
              targetNumber: inv.targetNumber,
              domain: inv.domain,
              sipCallId,
              fromTag: inv.fromTag,
              toTag,
              cseq: inv.cseq,
              branch: inv.branch,
              host: this._config.sipServer,
              port: this._config.sipPort,
            });
            logger.info(
              { sipCallId, status, cseq: inv.cseq, branch: inv.branch },
              "PromoSoftSipClient: → ACK sent for non-2xx final response",
            );
            this._closeRtpSession(sipCallId);
            inv.reject(
              new PromoSoftSipError(
                `SIP INVITE failed: ${status} ${parsed.reason}`,
                null,
                status,
              ),
            );
          }
        } else {
          logger.debug(
            { status: parsed.status, sipCallId },
            "PromoSoftSipClient: INVITE response for unknown call ignored",
          );
        }
      } else {
        // Non-INVITE response — single-shot _pending waiter
        const w = this._pending.get(key);
        if (w) {
          clearTimeout(w.timer);
          this._pending.delete(key);
          w.resolve({
            status: parsed.status,
            reason: parsed.reason,
            headers: h,
          });
        } else {
          logger.debug(
            { status: parsed.status, key },
            "PromoSoftSipClient: unsolicited response ignored",
          );
        }
      }
    } else if (parsed.method) {
      if (parsed.method === "OPTIONS") {
        this._replyOptions(parsed.headers, rinfo);
      } else if (parsed.method === "INVITE") {
        if (this._dumper) {
          const f = this._dumper.dump(parsed.headers?.["call-id"] || "noid", "inbound-invite", text);
          if (f) logger.info({ dump: f }, "PromoSoftSipClient: SIP dump → inbound-invite");
        }
        this._handleIncomingInvite(parsed.headers, parsed.body, rinfo);
      } else if (parsed.method === "ACK") {
        // ACK for our 200 OK (inbound call confirmed) — no reply needed
        const ackSipCallId = parsed.headers?.["call-id"] || "";
        const ackCall = this._calls.get(ackSipCallId);
        if (ackCall && ackCall.direction === "inbound") {
          ackCall.status = "confirmed";
          ackCall.ackReceivedAt = Date.now();
          if (typeof ackCall.stopRetx === "function") ackCall.stopRetx();
          logger.info(
            { callId: ackCall.callId, sipCallId: ackSipCallId, from: ackCall.callerNumber, to: ackCall.targetNumber },
            "PromoSoftSipClient: ← ACK (inbound call confirmed)",
          );
          if (this._dumper) {
            const f = this._dumper.dump(ackSipCallId, "ack", text);
            if (f) logger.info({ dump: f }, "PromoSoftSipClient: SIP dump → ack");
          }
          // RTP silence stream was already started immediately after 200 OK was sent
        } else {
          logger.debug({ sipCallId: ackSipCallId }, "PromoSoftSipClient: ← ACK (no matching inbound call)");
        }
      } else if (parsed.method === "CANCEL") {
        this._handleIncomingCancel(parsed.headers, rinfo);
      } else if (parsed.method === "BYE") {
        logger.info(
          { from: `${rinfo.address}:${rinfo.port}` },
          `PromoSoftSipClient: ← raw BYE\n${text}`,
        );
        if (this._dumper) {
          const f = this._dumper.dump(parsed.headers?.["call-id"] || "noid", "bye", text);
          if (f) logger.info({ dump: f }, "PromoSoftSipClient: SIP dump → bye");
        }
        this._handleIncomingBye(parsed.headers, rinfo);
      } else {
        logger.debug({ method: parsed.method }, "PromoSoftSipClient: unhandled server request");
      }
    }
  }

  /* ── Send and await matching response ───────────────────────────────── */

  _sendAndWait(msg, host, port, key) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(key);
        reject(
          new PromoSoftSipError(
            `SIP transaction timeout after ${TRANSACTION_TIMEOUT / 1000}s - no response from ${host}:${port}`,
          ),
        );
      }, TRANSACTION_TIMEOUT);

      this._pending.set(key, { resolve, reject, timer });

      const buf = Buffer.from(msg, "utf8");
      this._socket.send(buf, 0, buf.length, port, host, (err) => {
        if (err) {
          clearTimeout(timer);
          this._pending.delete(key);
          reject(new PromoSoftSipError(`UDP send failed: ${err.message}`, err));
        }
      });
    });
  }

  /* ── SIP message construction ────────────────────────────────────────── */

  _buildRegister({
    extension,
    domain,
    callId,
    tag,
    seq,
    expires = EXPIRES_SEC,
    authorization,
  }) {
    const lines = [
      `REGISTER sip:${domain} SIP/2.0`,
      // rport: ask the server to use the actual source address in its response (RFC 3581 NAT traversal)
      `Via: SIP/2.0/UDP ${this._localIp}:${this._localPort};branch=${this._newBranch()};rport`,
      `From: <sip:${extension}@${domain}>;tag=${tag}`,
      `To: <sip:${extension}@${domain}>`,
      `Call-ID: ${callId}`,
      `CSeq: ${seq} REGISTER`,
      `Contact: <${this._contactUri(extension)}>;expires=${expires}`,
      `Expires: ${expires}`,
      `Max-Forwards: 70`,
      `User-Agent: LabelGateway/1.0`,
    ];
    if (authorization) lines.push(`Authorization: ${authorization}`);
    lines.push("Content-Length: 0", "", "");
    return lines.join("\r\n");
  }

  /**
   * Reply to a server-initiated OPTIONS with 200 OK so the PBX knows we are alive.
   * Many PBXes send periodic OPTIONS as a keepalive probe and deregister if no reply.
   *
   * The 200 OK must carry a full, well-formed header set — a bare To/From/Call-ID/CSeq
   * response was showing up in Wireshark as [Malformed Packet]. Mirrors the same
   * Contact (with rinstance) used in REGISTER/200 OK-to-INVITE, and only appends a
   * To tag when the request's To didn't already carry one (avoids ";tag=" duplication).
   */
  _replyOptions(headers, rinfo) {
    const toHasTag = /;tag=/i.test(headers["to"] || "");
    const lines = [
      "SIP/2.0 200 OK",
      headers["via"]     ? `Via: ${headers["via"]}`         : null,
      headers["from"]    ? `From: ${headers["from"]}`       : null,
      headers["to"]      ? `To: ${headers["to"]}${toHasTag ? "" : `;tag=${this._newTag()}`}` : null,
      headers["call-id"] ? `Call-ID: ${headers["call-id"]}` : null,
      headers["cseq"]    ? `CSeq: ${headers["cseq"]}`       : null,
      "Content-Length: 0",
    ].filter(Boolean);

    // Header section must end in a blank line (CRLF CRLF) per RFC 3261 §7.5 —
    // omitting it left this reply showing as [Malformed Packet] in Wireshark.
    const msg = lines.join("\r\n") + "\r\n\r\n";
    logger.info(
      {
        to: `${rinfo.address}:${rinfo.port}`,
        activeCalls: this._calls.size,
        activeRtpSessions: this._rtpSessions.size,
      },
      `PromoSoftSipClient: → 200 OK (OPTIONS)\n${msg}`,
    );

    const buf = Buffer.from(msg, "utf8");
    this._socket.send(buf, 0, buf.length, rinfo.port, rinfo.address, (err) => {
      if (err)
        logger.warn(
          { err: err.message },
          "PromoSoftSipClient: OPTIONS reply failed",
        );
    });
  }

  /**
   * Handle an incoming BYE from the remote endpoint (remote hangup).
   *
   * Replies with 200 OK (RFC 3261 §15.1.2), removes the call from _calls,
   * and fires the onRemoteBye callback registered by the adapter at call setup.
   */
  _handleIncomingBye(headers, rinfo) {
    const sipCallId = headers["call-id"] || "";
    const fromFull = headers["from"] || "";
    const toFull = headers["to"] || "";
    const cseq = headers["cseq"] || "";
    const fromTag = (fromFull.match(/tag=([^\s;]+)/i) || [])[1] || null;
    const toTag = (toFull.match(/tag=([^\s;]+)/i) || [])[1] || null;

    logger.info(
      { sipCallId, fromTag, toTag, cseq, method: "BYE" },
      "PromoSoftSipClient: ← BYE received (remote hangup)",
    );

    this._replyBye(headers, rinfo);

    const call = this._calls.get(sipCallId);
    if (call) {
      // Log RTP counters before closing the session so txCount/rxCount are still readable
      const byeRtpSession = this._rtpSessions.get(sipCallId);
      const byeAt         = Date.now();
      const byeRef        = call.ackReceivedAt || call.answer200SentAt;
      logger.info(
        {
          sipCallId,
          elapsedMsSinceAck: byeRef ? (byeAt - byeRef) : null,
          refPoint:          call.ackReceivedAt ? "ack" : (call.answer200SentAt ? "200ok" : null),
          txCount:           byeRtpSession ? byeRtpSession.txCount : 0,
          rxCount:           byeRtpSession ? byeRtpSession.rxCount : 0,
          remoteRtp:         byeRtpSession ? `${byeRtpSession.remoteIp}:${byeRtpSession.remotePort}` : null,
          direction:         call.direction || "unknown",
        },
        "PromoSoftSipClient: ← BYE — RTP diagnostic at hangup",
      );
      if (typeof call.stopRetx === "function") call.stopRetx();
      this._calls.delete(sipCallId);
      this._closeRtpSession(sipCallId);
      // Track for 30 s so a duplicate BYE (Asterisk retransmit) doesn't produce a spurious warn
      this._endedCallIds.add(sipCallId);
      setTimeout(() => this._endedCallIds.delete(sipCallId), 30_000);

      if (call.direction === "inbound" && call.status === "ringing") {
        // Caller hung up before we answered (BYE instead of CANCEL — handle defensively)
        logger.info(
          { callId: call.callId, sipCallId, from: call.callerNumber, to: call.targetNumber },
          "PromoSoftSipClient: BYE for unanswered inbound call — notifying adapter (cancelled)",
        );
        if (typeof this._onIncomingCall === "function") {
          try {
            this._onIncomingCall({
              callId:    call.callId,
              sipCallId,
              from:      call.callerNumber,
              to:        call.targetNumber,
              cancelled: true,
            });
          } catch (_) {}
        }
      } else {
        logger.info(
          {
            callId:    call.callId || null,
            sipCallId,
            from:      call.fromExtension || call.callerNumber,
            to:        call.targetNumber,
            direction: call.direction || "outbound",
            status:    call.status || null,
          },
          "PromoSoftSipClient: BYE matched active call — notifying adapter",
        );
        try {
          if (call.onRemoteBye) call.onRemoteBye({ sipCallId, fromTag, toTag });
        } catch (_) {}
      }
    } else if (this._endedCallIds.has(sipCallId)) {
      // Duplicate BYE (Asterisk retransmission after the first was already processed)
      logger.info(
        { sipCallId },
        "PromoSoftSipClient: ← duplicate BYE for already-ended call — 200 OK replied, no event emitted",
      );
    } else {
      logger.warn(
        {
          sipCallId,
          activeCalls: this._calls.size,
          activeKeys:  Array.from(this._calls.keys()),
        },
        "PromoSoftSipClient: ← BYE for unknown call — no active session found",
      );
    }
  }

  /**
   * Send 200 OK in response to an incoming BYE (RFC 3261 §15.1.2).
   */
  _replyBye(headers, rinfo) {
    const sipCallId = headers["call-id"] || "";
    const lines = [
      "SIP/2.0 200 OK",
      headers["via"] ? `Via: ${headers["via"]}` : null,
      headers["from"] ? `From: ${headers["from"]}` : null,
      headers["to"] ? `To: ${headers["to"]}` : null,
      headers["call-id"] ? `Call-ID: ${headers["call-id"]}` : null,
      headers["cseq"] ? `CSeq: ${headers["cseq"]}` : null,
      "Content-Length: 0",
    ].filter(Boolean);

    // Header section must end in a blank line (CRLF CRLF) per RFC 3261 §7.5 —
    // omitting it left this reply showing as [Malformed Packet] in Wireshark,
    // which can prevent Asterisk from cleanly closing the dialog on its side.
    const msg = lines.join("\r\n") + "\r\n\r\n";
    logger.info(
      { sipCallId, sendTo: `${rinfo.address}:${rinfo.port}` },
      `PromoSoftSipClient: → raw 200 OK (BYE)\n${msg}`,
    );
    const buf = Buffer.from(msg, "utf8");
    this._socket.send(buf, 0, buf.length, rinfo.port, rinfo.address, (err) => {
      if (err) {
        logger.warn(
          { err: err.message, sipCallId, sendTo: `${rinfo.address}:${rinfo.port}` },
          "PromoSoftSipClient: BYE 200 OK send failed",
        );
      } else {
        logger.info({ sipCallId, sendTo: `${rinfo.address}:${rinfo.port}` }, "PromoSoftSipClient: → 200 OK (BYE)");
      }
    });
  }

  /* ── Incoming call handler registration ─────────────────────────────── */

  /**
   * Register the adapter callback invoked when an incoming INVITE arrives.
   * @param {(info: { callId, sipCallId, from, to }) => void} fn
   */
  setIncomingCallHandler(fn) {
    this._onIncomingCall = fn;
  }

  /* ── Incoming INVITE ─────────────────────────────────────────────────── */

  /**
   * Handle an incoming SIP INVITE (inbound call from the PBX).
   *
   * Replies 100 Trying + 180 Ringing, stores the pending dialog, and fires
   * the onIncomingCall callback so the adapter can notify LabelPhone.
   */
  _handleIncomingInvite(headers, body, rinfo) {
    const sipCallId    = headers["call-id"] || "";
    const fromFull     = headers["from"]    || "";
    const toFull       = headers["to"]      || "";
    const cseqFull     = headers["cseq"]   || "";
    const contactFull  = headers["contact"] || "";

    const callerNumber = (fromFull.match(/sip:([^@>;]+)@/) || [])[1] || fromFull;
    const targetNumber = (toFull.match(/sip:([^@>;]+)@/) || [])[1] || toFull;
    const callerTag    = (fromFull.match(/tag=([^\s;]+)/i) || [])[1] || null;

    // RFC 4028 session timers — extract from INVITE to echo in 200 OK.
    const sessionExpiresHeader = headers["session-expires"] || null;
    const minSeHeader          = headers["min-se"]          || null;
    const requireHeader        = headers["require"]         || "";
    const requiresTimer        = requireHeader.toLowerCase().split(",").map(s => s.trim()).includes("timer");
    // Record-Route — must be mirrored verbatim in the 200 OK (RFC 3261 §12.1.1)
    const recordRoute          = headers["record-route"]    || null;

    // Guard against INVITE retransmissions — RFC 3261 §17.2.1: the UAS MUST retransmit
    // whatever final response it has already sent when it sees a retransmitted request.
    const existing = this._calls.get(sipCallId);
    if (existing && existing.direction === "inbound") {
      if (existing.status === "ringing") {
        logger.debug({ sipCallId }, "PromoSoftSipClient: INVITE retransmit — re-sending 100/180");
        this._reply1xx(100, "Trying", headers, rinfo);
        const retxContact = `<sip:${existing.targetNumber}@${this._localIp}:${this._localPort}>`;
        this._reply1xx(180, "Ringing", headers, rinfo, { localTag: existing.localTag, contact: retxContact });
      } else if (existing.response200) {
        // Already answered — retransmit our 200 OK so Asterisk can resend ACK
        logger.debug({ sipCallId, status: existing.status }, "PromoSoftSipClient: INVITE retransmit — re-sending 200 OK");
        const buf = Buffer.from(existing.response200, "utf8");
        this._socket.send(buf, 0, buf.length, rinfo.port, rinfo.address, (err) => {
          if (err) logger.warn({ err: err.message, sipCallId }, "PromoSoftSipClient: 200 OK retransmit (on INVITE) failed");
        });
      }
      return;
    }

    const localTag    = this._newTag();
    const callId      = `call-${Date.now()}`;
    const contactLine = `<sip:${targetNumber}@${this._localIp}:${this._localPort}>`;

    logger.info(
      {
        callId,
        sipCallId,
        from:       callerNumber,
        to:         targetNumber,
        toUri:      toFull,
        callerTag,
        localTag,
        cseq:       cseqFull,
        theirContact: contactFull,
        ourContact: contactLine,
        hasBody:    !!body,
        rinfo:      `${rinfo.address}:${rinfo.port}`,
      },
      "PromoSoftSipClient: ← INVITE received (incoming call)",
    );

    this._reply1xx(100, "Trying", headers, rinfo);
    this._reply1xx(180, "Ringing", headers, rinfo, { localTag, contact: contactLine });

    // Store directly in _calls (primary tracking map) so BYE/CANCEL matching is unified.
    // The call stays in _calls for its entire lifetime: ringing → answered → confirmed → ended.
    this._calls.set(sipCallId, {
      callId,
      sipCallId,
      callerNumber,
      targetNumber,
      callerTag,
      localTag,
      fromHeader:          fromFull,
      toHeader:            toFull,
      viaHeader:           headers["via"] || "",
      cseq:                cseqFull,
      sdp:                 body || null,
      rinfo,
      sessionExpiresHeader,
      minSeHeader,
      requiresTimer,
      recordRoute,
      response200:         null, // set by answerIncoming(); used to retransmit on INVITE retransmit
      stopRetx:            null, // set by answerIncoming(); cancels Timer G when ACK/BYE arrives
      answer200SentAt:     null, // set when 200 OK is successfully sent; RTP reference if ACK never arrives
      ackReceivedAt:       null, // set when ACK arrives; primary reference for BYE elapsed-time log
      status:              "ringing",
      direction:           "inbound",
      onRemoteBye:         null,
    });

    logger.info(
      { callId, sipCallId, from: callerNumber, to: targetNumber, localTag, callerTag },
      "PromoSoftSipClient: incoming call stored in _calls (key=sipCallId) — notifying adapter",
    );

    if (typeof this._onIncomingCall === "function") {
      try {
        this._onIncomingCall({ callId, sipCallId, from: callerNumber, to: targetNumber });
      } catch (_) {}
    }
  }

  /**
   * Send a SIP provisional (1xx) response to an incoming INVITE.
   * Adds a local To tag for 180+ (early dialog). Optionally includes Contact.
   */
  _reply1xx(status, reason, headers, rinfo, { localTag = null, contact = null } = {}) {
    const sipCallId = headers["call-id"] || "";
    const toValue   = headers["to"] || "";
    const toLine    = (localTag && status >= 180)
      ? `To: ${toValue};tag=${localTag}`
      : `To: ${toValue}`;

    const lines = [
      `SIP/2.0 ${status} ${reason}`,
      headers["via"]     ? `Via: ${headers["via"]}`         : null,
      headers["from"]    ? `From: ${headers["from"]}`       : null,
      toLine,
      headers["call-id"] ? `Call-ID: ${headers["call-id"]}` : null,
      headers["cseq"]    ? `CSeq: ${headers["cseq"]}`       : null,
      contact            ? `Contact: ${contact}`             : null,
      "Content-Length: 0",
      "",
      "",
    ].filter(Boolean);

    const buf = Buffer.from(lines.join("\r\n"), "utf8");
    this._socket.send(buf, 0, buf.length, rinfo.port, rinfo.address, (err) => {
      if (err) {
        logger.warn(
          { err: err.message, sipCallId, status },
          "PromoSoftSipClient: provisional reply send failed",
        );
      } else {
        logger.info({ sipCallId, status }, `PromoSoftSipClient: → ${status} ${reason}`);
      }
    });
  }

  /**
   * Handle an incoming CANCEL for a pending (unanswered) INVITE.
   *
   * RFC 3261 §9.2: reply 200 OK to the CANCEL, then send 487 Request
   * Terminated in response to the original INVITE, and clean up.
   */
  _handleIncomingCancel(headers, rinfo) {
    const sipCallId = headers["call-id"] || "";
    logger.info({ sipCallId }, "PromoSoftSipClient: ← CANCEL received");

    // 200 OK for the CANCEL itself
    const lines = [
      "SIP/2.0 200 OK",
      headers["via"]     ? `Via: ${headers["via"]}`         : null,
      headers["from"]    ? `From: ${headers["from"]}`       : null,
      headers["to"]      ? `To: ${headers["to"]}`           : null,
      headers["call-id"] ? `Call-ID: ${headers["call-id"]}` : null,
      headers["cseq"]    ? `CSeq: ${headers["cseq"]}`       : null,
      "Content-Length: 0",
      "",
      "",
    ].filter(Boolean);
    const buf = Buffer.from(lines.join("\r\n"), "utf8");
    this._socket.send(buf, 0, buf.length, rinfo.port, rinfo.address, (err) => {
      if (err) logger.warn({ err: err.message, sipCallId }, "PromoSoftSipClient: CANCEL 200 OK send failed");
      else      logger.info({ sipCallId }, "PromoSoftSipClient: → 200 OK (CANCEL)");
    });

    // Clean up the pending incoming call (tracked in _calls with status "ringing")
    const cancelledCall = this._calls.get(sipCallId);
    if (cancelledCall && cancelledCall.direction === "inbound" && cancelledCall.status === "ringing") {
      if (typeof cancelledCall.stopRetx === "function") cancelledCall.stopRetx();
      this._calls.delete(sipCallId);
      logger.info(
        { callId: cancelledCall.callId, sipCallId, from: cancelledCall.callerNumber, to: cancelledCall.targetNumber },
        "PromoSoftSipClient: incoming call cancelled — notifying adapter",
      );
      if (typeof this._onIncomingCall === "function") {
        try {
          this._onIncomingCall({
            callId:    cancelledCall.callId,
            sipCallId,
            from:      cancelledCall.callerNumber,
            to:        cancelledCall.targetNumber,
            cancelled: true,
          });
        } catch (_) {}
      }
    } else {
      logger.warn({ sipCallId }, "PromoSoftSipClient: CANCEL for unknown incoming call");
    }
  }

  /* ── SIP message parser ──────────────────────────────────────────────── */

  /**
   * Minimal SIP message parser that extracts what we need for REGISTER flow.
   * Returns { status, reason, method, headers }.
   * status/reason are set for responses; method is set for requests.
   */
  _parseMessage(text) {
    const [firstLine, ...rest] = text.split("\r\n");
    let status = null,
      reason = null,
      method = null;

    const statusM = firstLine.match(/^SIP\/2\.0\s+(\d+)\s*(.*)/);
    if (statusM) {
      status = parseInt(statusM[1], 10);
      reason = statusM[2] || "";
    } else {
      const reqM = firstLine.match(/^([A-Z]+)\s+/);
      if (reqM) method = reqM[1];
    }

    const headers = {};
    let body = null;
    let bodyIdx = rest.length;
    for (let i = 0; i < rest.length; i++) {
      if (!rest[i]) { bodyIdx = i + 1; break; } // empty line = header/body separator
      const colon = rest[i].indexOf(":");
      if (colon < 0) continue;
      const name = rest[i].slice(0, colon).trim().toLowerCase();
      const value = rest[i].slice(colon + 1).trim();
      // Accumulate Via headers to preserve multi-hop chains (RFC 3261: echo all Vias in responses).
      // Last value wins for all other duplicate headers.
      if (name === "via") {
        headers["via"] = headers["via"]
          ? headers["via"] + "\r\nVia: " + value
          : value;
      } else {
        headers[name] = value;
      }
    }
    const bodyLines = rest.slice(bodyIdx);
    if (bodyLines.some((l) => l.length > 0)) body = bodyLines.join("\r\n");

    return { status, reason, method, headers, body };
  }

  /* ── Digest authentication (RFC 2617 / RFC 3261 §22.4) ──────────────── */

  _parseDigestChallenge(header) {
    const pick = (name) => {
      const m = header.match(
        new RegExp(`${name}=(?:"([^"]*)"|([^,\\s]+))`, "i"),
      );
      return m ? (m[1] !== undefined ? m[1] : m[2]) : null;
    };
    return {
      realm: pick("realm") || "",
      nonce: pick("nonce") || "",
      qop: pick("qop") || null,
    };
  }

  _computeDigestAuth({
    extension,
    password,
    realm,
    nonce,
    qop,
    uri,
    method = "REGISTER",
  }) {
    const md5 = (s) => crypto.createHash("md5").update(s).digest("hex");
    const ha1 = md5(`${extension}:${realm}:${password}`);
    const ha2 = md5(`${method}:${uri}`);

    const params = [
      `username="${extension}"`,
      `realm="${realm}"`,
      `nonce="${nonce}"`,
      `uri="${uri}"`,
      `algorithm=MD5`,
    ];

    if (qop) {
      const nc = "00000001";
      const cnonce = crypto.randomBytes(8).toString("hex");
      params.push(
        `cnonce="${cnonce}"`,
        `nc=${nc}`,
        `qop=auth`,
        `response="${md5(`${ha1}:${nonce}:${nc}:${cnonce}:auth:${ha2}`)}"`,
      );
    } else {
      params.push(`response="${md5(`${ha1}:${nonce}:${ha2}`)}"`);
    }

    return `Digest ${params.join(", ")}`;
  }

  /* ── Expires parsing ─────────────────────────────────────────────────── */

  /**
   * Extract the negotiated registration lifetime from a 200 OK response.
   * Prefers the Contact header's expires parameter (server may shorten the
   * requested value), falls back to the Expires header, then the local default.
   */
  _parseExpiresIn(headers) {
    const contact = headers["contact"] || "";
    const cm = contact.match(/expires=(\d+)/i);
    if (cm) return parseInt(cm[1], 10);
    const exp = headers["expires"];
    if (exp) {
      const n = parseInt(exp, 10);
      if (!isNaN(n) && n > 0) return n;
    }
    return EXPIRES_SEC;
  }

  /* ── Re-REGISTER keepalive ───────────────────────────────────────────── */

  _scheduleReRegister(expiresIn = EXPIRES_SEC) {
    this._clearKeepalive();
    // Guard against PBX returning a very short expiry that would fire immediately.
    const effectiveExpiry = Math.max(expiresIn, REREGISTER_LEAD_SEC + 10);
    const ms = (effectiveExpiry - REREGISTER_LEAD_SEC) * 1000;
    this._keepaliveTimer = setTimeout(() => {
      if (!this._session) return;
      const { extension, password } = this._session;
      logger.debug(
        { extension, expiresIn },
        "PromoSoftSipClient: re-REGISTER (keepalive)",
      );
      this.register({ extension, password }).catch((err) =>
        logger.error(
          { extension, err: err.message },
          "PromoSoftSipClient: re-REGISTER failed",
        ),
      );
    }, ms);
  }

  _clearKeepalive() {
    if (this._keepaliveTimer) {
      clearTimeout(this._keepaliveTimer);
      this._keepaliveTimer = null;
    }
  }

  /* ── SIP INVITE (outgoing call) ─────────────────────────────────────── */

  /**
   * Send SIP INVITE and handle provisional/final responses.
   *
   * Handles the 401/407 digest challenge automatically (same two-step flow as
   * register()), so the caller does not need to manage authentication.
   *
   * @param {{ fromExtension: string, targetNumber: string, onProvisional?: Function, onRemoteBye?: Function }} params
   *   onProvisional(status, reason, headers) — called for each 1xx response.
   *   onRemoteBye({ sipCallId, fromTag, toTag }) — called when the remote endpoint sends BYE.
   * @returns {Promise<{ status, sipCallId, fromTag, toTag }>}
   */
  async invite({ fromExtension, targetNumber, onProvisional, onRemoteBye, onInviteCreated }) {
    if (!this._registered || !this._socket) {
      throw new PromoSoftSipError(
        "SIP client not registered — send login command first",
      );
    }

    const domain = this._config.serverDomain;
    const host = this._config.sipServer;
    const port = this._config.sipPort;
    const sipCallId = this._newCallId();
    const fromTag = this._newTag();
    const branch = this._newBranch();

    // Equivalent of JsSIP "newRTCSession" — log sipCallId so every subsequent
    // event can be correlated back to this call. Includes branch/CSeq/domain
    // so this can be compared side-by-side against the CANCEL that may follow.
    logger.info(
      { fromExtension, targetNumber, domain, sipCallId, fromTag, cseq: 1, branch, host, port },
      "PromoSoftSipClient: → INVITE (newRTCSession)",
    );

    // Let the caller learn the sipCallId as soon as it exists, so hangup()
    // during ringing (before this promise settles) can still target this
    // transaction with a CANCEL.
    try {
      (onInviteCreated || (() => {}))({ sipCallId });
    } catch (_) {}

    // Open the local RTP socket before building the SDP offer so we can
    // advertise the real bound port (audio relay). Remote endpoint is learned
    // later from the 200 OK's SDP answer. Falls back to a placeholder port
    // (silence-only, matches prior behavior) if binding fails.
    let rtpPort = 20000;
    try {
      rtpPort = await this._openRtpSocket({ sipCallId, remoteIp: null, remotePort: null, payloadType: 8 });
    } catch (err) {
      logger.warn(
        { sipCallId, err: err.message },
        "PromoSoftSipClient: outbound RTP socket open failed — audio relay will be unavailable for this call",
      );
    }
    const sdp = this._buildSdp({ port: rtpPort });

    const msg = this._buildInvite({
      fromExtension,
      targetNumber,
      domain,
      sipCallId,
      fromTag,
      sdp,
      cseq: 1,
      branch,
    });
    if (this._config.debug) {
      logger.debug(
        { fromExtension, targetNumber, sipCallId },
        `PromoSoftSipClient: SDP offer:\n${sdp}`,
      );
      logger.debug(
        { direction: "OUT", sipCallId },
        `PromoSoftSipClient: INVITE packet:\n${msg}`,
      );
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._invites.delete(sipCallId);
        this._closeRtpSession(sipCallId);
        logger.warn(
          { fromExtension, targetNumber, sipCallId },
          `PromoSoftSipClient: INVITE timeout after ${TRANSACTION_TIMEOUT / 1000}s (failed)`,
        );
        reject(
          new PromoSoftSipError(
            `SIP INVITE timeout after ${TRANSACTION_TIMEOUT / 1000}s`,
          ),
        );
      }, TRANSACTION_TIMEOUT);

      // sdp, cseq, branch, and onRemoteBye are stored for the 401 retry handler,
      // CANCEL (while ringing), and post-answer BYE dispatch. `branch` is
      // updated on each authenticated retry to track whichever INVITE
      // transaction is currently outstanding.
      this._invites.set(sipCallId, {
        fromExtension,
        targetNumber,
        fromTag,
        domain,
        sdp,
        cseq: 1,
        branch,
        authAttempted: false,
        cancelRequested: false,
        onProvisional: onProvisional || (() => {}),
        onRemoteBye: onRemoteBye || (() => {}),
        resolve,
        reject,
        timer,
      });

      const buf = Buffer.from(msg, "utf8");
      this._socket.send(buf, 0, buf.length, port, host, (err) => {
        if (err) {
          clearTimeout(timer);
          this._invites.delete(sipCallId);
          this._closeRtpSession(sipCallId);
          reject(new PromoSoftSipError(`UDP send failed: ${err.message}`, err));
        }
      });
    });
  }

  /**
   * Send SIP BYE to end an established dialog.
   * Only valid after INVITE 200 OK (i.e. call is answered).
   */
  async bye({ fromExtension, targetNumber, sipCallId, fromTag, toTag, cseq = 2 }) {
    if (!this._socket) return;
    // Remove from active call tracking before sending BYE to prevent a
    // simultaneous remote BYE from firing onRemoteBye after local hangup.
    this._calls.delete(sipCallId);
    this._closeRtpSession(sipCallId);
    const domain = this._config.serverDomain;
    const host = this._config.sipServer;
    const port = this._config.sipPort;
    const msg = this._buildBye({
      fromExtension,
      targetNumber,
      domain,
      sipCallId,
      fromTag,
      toTag,
      cseq,
    });
    logger.info(
      { fromExtension, targetNumber, sipCallId, cseq },
      "PromoSoftSipClient: → BYE built and sending",
    );
    return this._sendAndWait(msg, host, port, `${sipCallId}:${cseq}`)
      .then((res) => {
        logger.info(
          { sipCallId, cseq, status: res?.status, reason: res?.reason },
          "PromoSoftSipClient: ← BYE response received",
        );
        return res;
      })
      .catch((err) => {
        logger.warn(
          { sipCallId, cseq, err: err.message },
          "PromoSoftSipClient: BYE — no response / transaction failed",
        );
        throw err;
      });
  }

  /**
   * Send SIP CANCEL for an INVITE transaction that is still pending (not yet
   * answered with a final 2xx). Only valid while the call is ringing/early.
   */
  async cancel({ sipCallId }) {
    if (!this._socket) return;
    const inv = this._invites.get(sipCallId);
    if (!inv) {
      logger.warn({ sipCallId }, "PromoSoftSipClient: cancel — no pending INVITE transaction found");
      return;
    }
    inv.cancelRequested = true;

    const host = this._config.sipServer;
    const port = this._config.sipPort;
    const msg = this._buildCancel({
      fromExtension: inv.fromExtension,
      targetNumber: inv.targetNumber,
      domain: inv.domain,
      sipCallId,
      fromTag: inv.fromTag,
      cseq: inv.cseq,
      branch: inv.branch,
    });
    logger.info(
      {
        fromExtension: inv.fromExtension,
        targetNumber: inv.targetNumber,
        domain: inv.domain,
        sipCallId,
        fromTag: inv.fromTag,
        cseq: inv.cseq,
        branch: inv.branch,
        host,
        port,
      },
      "PromoSoftSipClient: → CANCEL built and sending",
    );
    if (this._config.debug) {
      logger.debug(
        { direction: "OUT", sipCallId },
        `PromoSoftSipClient: CANCEL packet:\n${msg}`,
      );
    }
    return this._sendAndWait(msg, host, port, `${sipCallId}:${inv.cseq}`)
      .then((res) => {
        logger.info(
          { sipCallId, cseq: inv.cseq, status: res?.status, reason: res?.reason },
          "PromoSoftSipClient: ← CANCEL response received",
        );
        return res;
      })
      .catch((err) => {
        logger.warn(
          { sipCallId, cseq: inv.cseq, err: err.message },
          "PromoSoftSipClient: CANCEL — no response / transaction failed (ignored)",
        );
      });
  }

  /* ── SIP INVITE message builders ─────────────────────────────────────── */

  _buildInvite({
    fromExtension,
    targetNumber,
    domain,
    sipCallId,
    fromTag,
    sdp,
    cseq = 1,
    authorization = null,
    branch = null,
  }) {
    const bodyLen = Buffer.byteLength(sdp, "utf8");
    const lines = [
      `INVITE sip:${targetNumber}@${domain} SIP/2.0`,
      `Via: SIP/2.0/UDP ${this._localIp}:${this._localPort};branch=${branch || this._newBranch()};rport`,
      `From: <sip:${fromExtension}@${domain}>;tag=${fromTag}`,
      `To: <sip:${targetNumber}@${domain}>`,
      `Call-ID: ${sipCallId}`,
      `CSeq: ${cseq} INVITE`,
      `Contact: <sip:${fromExtension}@${this._localIp}:${this._localPort}>`,
      `Max-Forwards: 70`,
      `Allow: INVITE, ACK, BYE, CANCEL, OPTIONS`,
      `Content-Type: application/sdp`,
      `Content-Length: ${bodyLen}`,
    ];
    if (authorization) lines.push(`Authorization: ${authorization}`);
    lines.push("", sdp);
    return lines.join("\r\n");
  }

  _buildAck({
    fromExtension,
    targetNumber,
    domain,
    sipCallId,
    fromTag,
    toTag,
    cseq = 1,
    requestUri = null,
    routeHeaders = [],
    branch = null,
  }) {
    const uri = requestUri || `sip:${targetNumber}@${domain}`;
    const toLine = toTag
      ? `To: <sip:${targetNumber}@${domain}>;tag=${toTag}`
      : `To: <sip:${targetNumber}@${domain}>`;
    const lines = [
      `ACK ${uri} SIP/2.0`,
      `Via: SIP/2.0/UDP ${this._localIp}:${this._localPort};branch=${branch || this._newBranch()};rport`,
      `From: <sip:${fromExtension}@${domain}>;tag=${fromTag}`,
      toLine,
      `Call-ID: ${sipCallId}`,
      `CSeq: ${cseq} ACK`,
      `Max-Forwards: 70`,
    ];
    for (const route of routeHeaders) {
      lines.push(`Route: ${route}`);
    }
    lines.push("Content-Length: 0", "", "");
    return lines.join("\r\n");
  }

  _buildBye({
    fromExtension,
    targetNumber,
    domain,
    sipCallId,
    fromTag,
    toTag,
    cseq = 2,
  }) {
    const toLine = toTag
      ? `To: <sip:${targetNumber}@${domain}>;tag=${toTag}`
      : `To: <sip:${targetNumber}@${domain}>`;
    const fromLine = fromTag
      ? `From: <sip:${fromExtension}@${domain}>;tag=${fromTag}`
      : `From: <sip:${fromExtension}@${domain}>`;
    return [
      `BYE sip:${targetNumber}@${domain} SIP/2.0`,
      `Via: SIP/2.0/UDP ${this._localIp}:${this._localPort};branch=${this._newBranch()};rport`,
      fromLine,
      toLine,
      `Call-ID: ${sipCallId}`,
      `CSeq: ${cseq} BYE`,
      `Max-Forwards: 70`,
      `Content-Length: 0`,
      "",
      "",
    ].join("\r\n");
  }

  /**
   * Build a CANCEL for a pending INVITE transaction (RFC 3261 §9.1).
   * MUST reuse the exact same Call-ID, From tag, To (no tag yet), numeric
   * CSeq, and Via branch as the INVITE it targets.
   */
  _buildCancel({
    fromExtension,
    targetNumber,
    domain,
    sipCallId,
    fromTag,
    cseq,
    branch,
  }) {
    return [
      `CANCEL sip:${targetNumber}@${domain} SIP/2.0`,
      `Via: SIP/2.0/UDP ${this._localIp}:${this._localPort};branch=${branch};rport`,
      `From: <sip:${fromExtension}@${domain}>;tag=${fromTag}`,
      `To: <sip:${targetNumber}@${domain}>`,
      `Call-ID: ${sipCallId}`,
      `CSeq: ${cseq} CANCEL`,
      `Max-Forwards: 70`,
      `Content-Length: 0`,
      "",
      "",
    ].join("\r\n");
  }

  _buildSdp({ port = 20000 } = {}) {
    // Outgoing INVITE offer — PCMA only. The LabelPhone browser encoder is
    // A-law-only, so offering PCMU here would let the remote answer with a
    // codec the browser can never actually produce.
    const advertiseIp = this._config.publicRtpIp || this._localIp;
    return [
      "v=0",
      `o=- 0 0 IN IP4 ${advertiseIp}`,
      "s=LabelGateway",
      `c=IN IP4 ${advertiseIp}`,
      "t=0 0",
      `m=audio ${port} RTP/AVP 8 101`,
      "a=rtpmap:8 PCMA/8000",
      "a=rtpmap:101 telephone-event/8000",
      "a=fmtp:101 0-16",
      "a=sendrecv",
      "",
    ].join("\r\n");
  }

  /**
   * Parse audio codec list from an SDP body.
   * Returns [{payloadType, name, rate}] in offer order.
   */
  _parseSdpCodecs(sdp) {
    if (!sdp) return [];
    const lines = sdp.split(/\r?\n/);
    let audioPayloads = [];
    const rtpmap = {};

    for (const line of lines) {
      const mAudio = line.match(/^m=audio\s+\d+\s+RTP\/AVP\s+(.+)/i);
      if (mAudio) {
        audioPayloads = mAudio[1].trim().split(/\s+/).map(Number).filter(n => !isNaN(n));
      }
      const aMap = line.match(/^a=rtpmap:(\d+)\s+([^/\s]+)\/(\d+)/i);
      if (aMap) {
        rtpmap[parseInt(aMap[1], 10)] = { name: aMap[2].toUpperCase(), rate: parseInt(aMap[3], 10) };
      }
    }

    // RFC 3551 static payload types — no rtpmap required
    const STATIC = { 0: { name: "PCMU", rate: 8000 }, 3: { name: "GSM", rate: 8000 }, 8: { name: "PCMA", rate: 8000 } };

    return audioPayloads.map(pt => {
      const c = rtpmap[pt] || STATIC[pt] || { name: `PT${pt}`, rate: 8000 };
      return { payloadType: pt, name: c.name, rate: c.rate };
    });
  }

  _selectCodec(offeredCodecs) {
    const PREFER = ["PCMA", "PCMU"];
    for (const name of PREFER) {
      const c = offeredCodecs.find(c => c.name === name);
      if (c) return c;
    }
    return offeredCodecs[0] || { payloadType: 8, name: "PCMA", rate: 8000 };
  }

  /**
   * Build a SDP answer body echoing every offered payload that the observed
   * working 3CX answer against this same Asterisk carries: PCMA, GSM (if
   * offered), and telephone-event (if offered) — in that fixed order.
   * Returns { sdp: string, selected: {payloadType, name, rate} }.
   */
  _buildSdpAnswer({ offeredCodecs, localPort = 20000, advertiseIp = null }) {
    const selected  = this._selectCodec(offeredCodecs);
    const mediaIp   = advertiseIp || this._localIp;
    const sessionId = this._sdpSessionId;

    const pcma   = offeredCodecs.find(c => c.name === "PCMA");
    const gsm    = offeredCodecs.find(c => c.name === "GSM");
    const telEvt = offeredCodecs.find(c => c.name === "TELEPHONE-EVENT");

    const answerCodecs = [pcma, gsm, telEvt].filter(Boolean);
    // Defensive fallback: if PCMA wasn't offered, still answer with whatever _selectCodec chose.
    if (!pcma) answerCodecs.unshift(selected);

    const mPayloads = answerCodecs.map(c => c.payloadType).join(" ");

    const lines = [
      "v=0",
      `o=- ${sessionId} ${sessionId} IN IP4 ${mediaIp}`,
      "s=-",
      `c=IN IP4 ${mediaIp}`,
      "t=0 0",
      `m=audio ${localPort} RTP/AVP ${mPayloads}`,
    ];

    for (const c of answerCodecs) {
      lines.push(`a=rtpmap:${c.payloadType} ${c.name}/${c.rate}`);
      if (c.name === "TELEPHONE-EVENT") lines.push(`a=fmtp:${c.payloadType} 0-16`);
    }

    lines.push("");

    return { sdp: lines.join("\r\n"), selected };
  }

  /**
   * Extract remote RTP IP and port from the SDP body of an INVITE.
   * Returns { remoteIp, remotePort } (either may be null if not found).
   */
  _parseSdpRemoteRtp(sdp) {
    if (!sdp) return { remoteIp: null, remotePort: null };
    let remoteIp   = null;
    let remotePort = null;
    for (const line of sdp.split(/\r?\n/)) {
      const cMatch = line.match(/^c=IN IP4 (\S+)/i);
      if (cMatch) remoteIp = cMatch[1];
      const mMatch = line.match(/^m=audio (\d+)/i);
      if (mMatch) remotePort = parseInt(mMatch[1], 10);
    }
    return { remoteIp, remotePort };
  }

  /**
   * Open and bind a UDP RTP socket for an inbound call.
   * Binds to port 0 so the OS picks a free port.
   * Resolves with the bound local port number.
   * The session object is stored in _rtpSessions keyed by sipCallId.
   */
  _openRtpSocket({ sipCallId, remoteIp, remotePort, payloadType }) {
    const portMin     = this._config.rtpPortMin;
    const portMax     = this._config.rtpPortMax;
    const advertiseIp = this._config.publicRtpIp || this._localIp;

    // Initialise or reset cursor when out of range (e.g. config changed)
    if (this._rtpPortCursor === null || this._rtpPortCursor < portMin || this._rtpPortCursor > portMax) {
      this._rtpPortCursor = portMin;
    }

    const rangeSize = portMax - portMin + 1;
    let attempts = 0;

    return new Promise((resolve, reject) => {
      const tryPort = (port) => {
        if (attempts++ >= rangeSize) {
          reject(new Error(`RTP: all ${rangeSize} ports in range ${portMin}–${portMax} are occupied`));
          return;
        }

        const sock = dgram.createSocket("udp4");
        const session = {
          socket:      sock,
          localPort:   null,
          advertiseIp,
          remoteIp,
          remotePort,
          payloadType,
          seqNum:      (Math.random() * 65535 | 0),
          timestamp:   (Math.random() * 0xFFFFFFFF | 0) >>> 0,
          ssrc:        (Math.random() * 0xFFFFFFFF | 0) >>> 0,
          sendTimer:   null,
          rxCount:     0,
          txCount:     0,
          outQueue:    [], // entries: { frame: Buffer, arrivalHr: bigint }
          // TEMPORARY diagnostic — RTP pacing instrumentation (see _startRtpMediaLoop)
          rtpLoopStopped: false,
          loopStartHr:    null,
          nextDeadline:   null,
          lastSentAtHr:   null,
          pacingWindow:   [],
          sendAttempts:   0,
          sendSyncErrors: 0,
          sendCbOk:       0,
          sendCbErrors:   0,
          toneIndexLog:   [],
          // TEMPORARY diagnostic — RTP audio jitter-buffer instrumentation (see
          // sendAudioFrame() / tick() / _closeRtpSession())
          audioFramesReceived:  0,
          audioFramesQueued:    0,
          audioFramesConsumed:  0,
          audioFramesDropped:   0,
          queueOverflowEvents:  0,
          queueUnderruns:       0,
          silenceFramesSent:    0,
          staleFramesDiscarded: 0,
          maxQueueDepth:        0,
          sumQueueDepth:        0,
          queueDepthSamples:    0,
          queuePrimed:          false,
          // TEMPORARY diagnostic — mid-call underrun recovery hysteresis and
          // G.711 packet-loss concealment state (see tick() / _buildConcealmentFrame).
          queueRecovering:          false,
          consecutiveUnderruns:     0,
          maxConsecutiveUnderruns:  0,
          lastRealFramePcm:         null, // Int16Array(160), retained pre-encoding for concealment
          concealmentActive:        false,
          concealmentFramesUsed:    0, // consecutive, resets when a real frame is consumed
          concealmentFramesTotal:   0, // lifetime, for the close-session summary
          // Per-pacing-window (reset every 500 packets) — feeds the extended
          // [RTP PACING STATS] log without requiring per-packet logging.
          queueDepthWindow:         [],
          windowUnderruns:          0,
          windowConcealmentFrames:  0,
          windowMaxConsecutiveUnderruns: 0,
        };

        const onBindError = (err) => {
          try { sock.close(); } catch (_) {}
          if (err.code === "EADDRINUSE") {
            const next = port >= portMax ? portMin : port + 1;
            this._rtpPortCursor = next;
            tryPort(next);
          } else {
            reject(err);
          }
        };

        sock.once("error", onBindError);

        sock.bind(port, () => {
          sock.removeListener("error", onBindError);

          sock.on("message", (msg, rinfo) => {
            session.rxCount++;
            const payloadType = msg.length > 1 ? (msg[1] & 0x7f) : null;
            if (session.rxCount === 1) {
              rtpLogger.info(
                {
                  sipCallId,
                  payloadType,
                  bytes: msg.length,
                  sourceAddress: rinfo.address,
                  sourcePort: rinfo.port,
                  rxCount: session.rxCount,
                },
                "[RTP IN] packet received",
              );
            } else if (appConfig.LOG_RTP && session.rxCount % 50 === 0) {
              rtpLogger.debug(
                {
                  sipCallId,
                  payloadType,
                  bytes: msg.length,
                  sourceAddress: rinfo.address,
                  sourcePort: rinfo.port,
                  rxCount: session.rxCount,
                },
                "[RTP IN] packet received",
              );
            }
            if (this._onAudioFrame && payloadType === session.payloadType && msg.length > 12) {
              this._onAudioFrame(msg.subarray(12));
            }
          });

          sock.on("error", (err) => {
            rtpLogger.warn({ sipCallId, err: err.message }, "PromoSoftSipClient: RTP socket error");
          });

          const { port: boundPort } = sock.address();
          session.localPort = boundPort;
          this._rtpPortCursor = boundPort >= portMax ? portMin : boundPort + 1;
          this._rtpSessions.set(sipCallId, session);

          rtpLogger.info(
            {
              sipCallId,
              localRtp:      `${this._localIp}:${boundPort}`,
              advertisedRtp: `${advertiseIp}:${boundPort}`,
              remoteRtp:     `${remoteIp}:${remotePort}`,
              payloadType,
            },
            "PromoSoftSipClient: RTP socket bound",
          );
          resolve(boundPort);
        });
      };

      tryPort(this._rtpPortCursor);
    });
  }

  /**
   * Start the 20 ms RTP send loop to the remote endpoint. Sends whatever the
   * browser has queued via sendAudioFrame(); when the queue is empty (mic
   * not yet started, or gaps between frames) it falls back to a silence
   * frame in the negotiated codec so Asterisk never times out waiting for
   * media. Called after ACK confirms the dialog (inbound) or once the 200 OK
   * SDP answer has been parsed (outbound).
   */
  _startRtpMediaLoop(sipCallId) {
    const session = this._rtpSessions.get(sipCallId);
    if (!session || session.sendTimer) return;

    const FRAME_SAMPLES = 160; // 20 ms at 8 kHz
    const FRAME_NS       = 20_000_000n;
    const SILENCE        = session.payloadType === 0 ? 0xff : 0xd5; // PCMU vs PCMA silence byte

    rtpLogger.info(
      {
        sipCallId,
        remoteRtp: `${session.remoteIp}:${session.remotePort}`,
        ssrc:      session.ssrc,
        pt:        session.payloadType,
      },
      "PromoSoftSipClient: RTP → starting media loop",
    );

    // TEMPORARY diagnostic — drift-corrected scheduler. A recursive
    // setTimeout(20)/setInterval(20) accumulates the time spent doing work
    // inside each tick (header build, Buffer.concat, socket.send, logging)
    // as drift, so real-world cadence creeps away from 20ms. Scheduling
    // against an absolute next-deadline (monotonic clock) cancels that
    // drift: each tick's delay is computed from how far the deadline
    // actually is from now, not a fixed 20ms from "whenever the last tick
    // happened to run".
    session.loopStartHr = process.hrtime.bigint();
    session.nextDeadline = session.loopStartHr + FRAME_NS;

    const tick = () => {
      if (session.rtpLoopStopped) return;

      const scheduledAt = session.nextDeadline;
      const sentAtHr    = process.hrtime.bigint();
      const latenessMs  = Number(sentAtHr - scheduledAt) / 1e6;
      const deltaMs      = session.lastSentAtHr === null
        ? null
        : Number(sentAtHr - session.lastSentAtHr) / 1e6;
      session.lastSentAtHr = sentAtHr;

      if (!session.socket || !session.remotePort || !session.remoteIp) {
        session.nextDeadline += FRAME_NS;
        scheduleNext();
        return;
      }

      const isMark    = session.txCount === 0;
      const seqCandidate = (session.seqNum + 1) & 0xFFFF;
      const tsCandidate  = session.timestamp >>> 0;
      const pt = session.payloadType;

      const header = Buffer.alloc(12);
      header.writeUInt8(0x80, 0);                          // V=2, P=0, X=0, CC=0
      header.writeUInt8(isMark ? (0x80 | pt) : pt, 1);      // M bit on first packet only
      header.writeUInt16BE(seqCandidate, 2);
      header.writeUInt32BE(tsCandidate, 4);
      header.writeUInt32BE(session.ssrc, 8);

      // TEMPORARY diagnostic — sample queue depth every tick, even during
      // test mode, since sendAudioFrame() keeps queuing browser audio
      // underneath test-tone/silence mode (see startAudioTest()).
      session.maxQueueDepth = Math.max(session.maxQueueDepth, session.outQueue.length);
      session.sumQueueDepth += session.outQueue.length;
      session.queueDepthSamples++;
      session.queueDepthWindow.push(session.outQueue.length);

      let frame;
      let fromQueue = false;
      let toneIndexUsed = null;
      if (session._testMode === "silence") {
        frame = SILENCE_FRAME;
      } else if (session._testMode === "tone") {
        toneIndexUsed = session._testToneIndex % TEST_TONE_FRAMES.length;
        frame = TEST_TONE_FRAMES[toneIndexUsed];
        session._testToneIndex = (session._testToneIndex + 1) >>> 0;
      } else if (!session.queuePrimed) {
        // Initial prime: accumulate past RTP_AUDIO_QUEUE_START_FRAMES (default
        // 200ms) before ever draining, so a normal ~85ms browser burst never
        // lands on an empty queue right after the loop starts. Bounded by a
        // startup grace period, independent of the configured target, so a
        // mic that's slow to start (or never starts) doesn't block RTP media
        // indefinitely — Asterisk needs packets flowing to keep the dialog up.
        const PRIME_GRACE_MS = 1000;
        const primedByDepth = session.outQueue.length >= appConfig.RTP_AUDIO_QUEUE_START_FRAMES;
        const primedByGrace = Number(sentAtHr - session.loopStartHr) / 1e6 >= PRIME_GRACE_MS;
        if (primedByDepth || primedByGrace) session.queuePrimed = true;
        // Pre-call buffering is not a loss — plain silence, no concealment.
        frame = Buffer.alloc(FRAME_SAMPLES, SILENCE);
      } else {
        // Primed: normally drain the queue. After a mid-call underrun, wait
        // for the queue to refill to RTP_AUDIO_QUEUE_RECOVERY_FRAMES (a
        // smaller threshold than the initial prime) before resuming draining,
        // so a single frame trickling back in doesn't immediately drain and
        // re-underrun on the very next tick.
        let underrun = false;
        if (session.queueRecovering && session.outQueue.length < appConfig.RTP_AUDIO_QUEUE_RECOVERY_FRAMES) {
          underrun = true;
        } else {
          session.queueRecovering = false;

          // Discard anything that's already too old to be worth sending
          // before consuming the next usable frame.
          const maxAgeNs = BigInt(appConfig.RTP_AUDIO_QUEUE_MAX_LATENCY_MS) * 1_000_000n;
          let queuedFrame = session.outQueue.shift();
          while (queuedFrame && (sentAtHr - queuedFrame.arrivalHr) > maxAgeNs) {
            session.staleFramesDiscarded++;
            queuedFrame = session.outQueue.shift();
          }

          fromQueue = !!queuedFrame;
          if (fromQueue) {
            session.audioFramesConsumed++;
            frame = queuedFrame.frame;
            // Retain for concealment and reset the ramp — the next underrun
            // (if any) fades from full gain again rather than continuing a
            // stale ramp from a previous, unrelated loss.
            session.lastRealFramePcm = _alawFrameToPcm(frame);
            session.consecutiveUnderruns = 0;
            session.concealmentFramesUsed = 0;
          } else {
            underrun = true;
          }
        }

        if (underrun) {
          session.queueUnderruns++;
          session.windowUnderruns++;
          session.consecutiveUnderruns++;
          session.maxConsecutiveUnderruns = Math.max(session.maxConsecutiveUnderruns, session.consecutiveUnderruns);
          session.windowMaxConsecutiveUnderruns = Math.max(session.windowMaxConsecutiveUnderruns, session.consecutiveUnderruns);
          session.queueRecovering = true;

          frame = _buildConcealmentFrame(session, SILENCE);
          if (session.concealmentActive) {
            session.windowConcealmentFrames++;
          } else {
            session.silenceFramesSent++; // concealment unavailable or past its cap — true silence
          }
        }
      }
      const pkt = Buffer.concat([header, frame]);

      // Do not advance sequence/timestamp unless the send call itself was
      // actually invoked without throwing synchronously.
      session.sendAttempts++;
      let invoked = true;
      try {
        session.socket.send(pkt, 0, pkt.length, session.remotePort, session.remoteIp, (err) => {
          if (err) {
            session.sendCbErrors++;
            rtpLogger.warn({ sipCallId, err: err.message }, "PromoSoftSipClient: RTP send error");
          } else {
            session.sendCbOk++;
          }
        });
      } catch (err) {
        invoked = false;
        session.sendSyncErrors++;
        rtpLogger.warn({ sipCallId, err: err.message }, "PromoSoftSipClient: RTP send invocation threw — sequence/timestamp not advanced");
      }

      if (invoked) {
        session.seqNum = seqCandidate;
        session.timestamp = (tsCandidate + FRAME_SAMPLES) >>> 0;
        session.txCount++;

        if (toneIndexUsed !== null && session.toneIndexLog.length < 60) {
          session.toneIndexLog.push(toneIndexUsed);
          if (appConfig.LOG_RTP && session.toneIndexLog.length === 60) {
            rtpLogger.debug({ sipCallId, toneIndexSequence: session.toneIndexLog }, "[RTP TONE INDEX] first 60 tone frame indices");
          }
        }

        const isFirstPacket = session.txCount === 1;
        const isLatenessAnomaly = Math.abs(latenessMs) > 25;
        const isSevereLateness = Math.abs(latenessMs) > 100;

        if (isFirstPacket || (appConfig.LOG_RTP && (session.txCount % 50 === 0 || isLatenessAnomaly))) {
          const pacingMeta = {
            sipCallId,
            sequence:            seqCandidate,
            rtpTimestamp:        tsCandidate,
            testMode:            session._testMode || null,
            scheduledAtMs:       Number(scheduledAt - session.loopStartHr) / 1e6,
            sentAtMs:            Number(sentAtHr - session.loopStartHr) / 1e6,
            deltaFromPreviousMs: deltaMs,
            latenessMs,
            queueDepth:          session.outQueue.length,
            payloadBytes:        frame.length,
            packetBytes:         pkt.length,
            mark:                isMark,
            fromQueue,
          };
          rtpLogger[isFirstPacket ? "info" : "debug"](pacingMeta, "[RTP PACING]");
        }

        if (isSevereLateness) {
          rtpLogger.warn(
            {
              sipCallId,
              sequence:     seqCandidate,
              rtpTimestamp: tsCandidate,
              latenessMs,
              deltaFromPreviousMs: deltaMs,
            },
            "[RTP PACING] severe timing anomaly",
          );
        }

        session.pacingWindow.push(deltaMs === null ? 20 : deltaMs);
        if (session.pacingWindow.length >= 500) {
          const samples = session.pacingWindow;
          session.pacingWindow = [];
          const sorted = [...samples].sort((a, b) => a - b);
          const sum = samples.reduce((a, b) => a + b, 0);
          const avgMs = sum / samples.length;
          const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
          const variance = samples.reduce((acc, v) => acc + (v - avgMs) * (v - avgMs), 0) / samples.length;
          const stddevMs = Math.sqrt(variance);
          const offTargetCounts = samples.reduce(
            (acc, v) => {
              const dev = Math.abs(v - 20);
              if (dev > 2) acc.outside2ms++;
              if (dev > 5) acc.outside5ms++;
              return acc;
            },
            { outside2ms: 0, outside5ms: 0 },
          );

          const depthSamples = session.queueDepthWindow;
          session.queueDepthWindow = [];
          const depthSorted = [...depthSamples].sort((a, b) => a - b);
          const depthP50 = depthSorted.length ? depthSorted[Math.floor(depthSorted.length * 0.5)] : 0;
          const depthP95 = depthSorted.length ? depthSorted[Math.min(depthSorted.length - 1, Math.floor(depthSorted.length * 0.95))] : 0;
          const depthMax = depthSorted.length ? depthSorted[depthSorted.length - 1] : 0;

          const windowUnderruns = session.windowUnderruns;
          const windowConcealmentFrames = session.windowConcealmentFrames;
          const windowMaxConsecutiveUnderruns = session.windowMaxConsecutiveUnderruns;
          session.windowUnderruns = 0;
          session.windowConcealmentFrames = 0;
          session.windowMaxConsecutiveUnderruns = 0;

          // Do not attribute pacing deviation to Windows/OS scheduling until
          // it has been checked against Node's own event-loop delay and GC —
          // both are sampled continuously via a native histogram, so this
          // costs nothing extra on the hot RTP send path.
          const eventLoop = eventLoopMonitor.snapshot();

          rtpLogger.info(
            {
              sipCallId,
              testMode:      session._testMode || null,
              sampleCount:   samples.length,
              minMs:         sorted[0],
              maxMs:         sorted[sorted.length - 1],
              avgMs,
              stddevMs,
              p95Ms:         p95,
              outside2msPct: (offTargetCounts.outside2ms / samples.length) * 100,
              outside5msPct: (offTargetCounts.outside5ms / samples.length) * 100,
              over25msCount: samples.filter((v) => v > 25).length,
              over40msCount: samples.filter((v) => v > 40).length,
              sendAttempts:   session.sendAttempts,
              sendSyncErrors: session.sendSyncErrors,
              sendCbOk:       session.sendCbOk,
              sendCbErrors:   session.sendCbErrors,
              queueDepthP50: depthP50,
              queueDepthP95: depthP95,
              queueDepthMax: depthMax,
              windowUnderruns,
              windowConcealmentFrames,
              windowMaxConsecutiveUnderruns,
              eventLoopDelayMinMs:    eventLoop.elDelayMinMs,
              eventLoopDelayMeanMs:   eventLoop.elDelayMeanMs,
              eventLoopDelayMaxMs:    eventLoop.elDelayMaxMs,
              eventLoopDelayStddevMs: eventLoop.elDelayStddevMs,
              eventLoopDelayP95Ms:    eventLoop.elDelayP95Ms,
              gcCount:   eventLoop.gcCount,
              gcTotalMs: eventLoop.gcTotalMs,
              gcMaxMs:   eventLoop.gcMaxMs,
            },
            "[RTP PACING STATS] (window of 500 packets)",
          );
        }
      }

      session.nextDeadline += FRAME_NS;
      scheduleNext();
    };

    const scheduleNext = () => {
      if (session.rtpLoopStopped) return;
      const now = process.hrtime.bigint();
      const delayMs = Math.max(0, Number(session.nextDeadline - now) / 1e6);
      session.sendTimer = setTimeout(tick, delayMs);
    };

    scheduleNext();
  }

  /**
   * Stop the RTP send timer and close the per-call UDP socket.
   */
  _closeRtpSession(sipCallId) {
    const session = this._rtpSessions.get(sipCallId);
    if (!session) return;
    this._rtpSessions.delete(sipCallId);
    session.rtpLoopStopped = true;
    if (session.sendTimer) clearTimeout(session.sendTimer);
    try { session.socket.close(); } catch (_) {}

    rtpLogger.info(
      {
        sipCallId,
        audioFramesReceived:  session.audioFramesReceived,
        audioFramesQueued:    session.audioFramesQueued,
        audioFramesConsumed:  session.audioFramesConsumed,
        audioFramesDropped:   session.audioFramesDropped,
        queueOverflowEvents:  session.queueOverflowEvents,
        queueUnderruns:       session.queueUnderruns,
        silenceFramesSent:    session.silenceFramesSent,
        concealmentFramesSent: session.concealmentFramesTotal,
        maxConsecutiveUnderruns: session.maxConsecutiveUnderruns,
        staleFramesDiscarded: session.staleFramesDiscarded,
        maxQueueDepth:        session.maxQueueDepth,
        avgQueueDepth:        session.queueDepthSamples > 0 ? session.sumQueueDepth / session.queueDepthSamples : 0,
        txCount:              session.txCount,
        rxCount:              session.rxCount,
      },
      "[RTP AUDIO QUEUE SUMMARY]",
    );

    rtpLogger.info(
      { sipCallId, rxCount: session.rxCount, txCount: session.txCount },
      "PromoSoftSipClient: RTP session closed",
    );
  }

  /**
   * TEMPORARY diagnostic: force the RTP media loop to send a fixed test
   * signal (silence or a verified 440Hz tone) instead of session.outQueue,
   * bypassing the browser mic/resampler/encoder/WebSocket entirely. Does not
   * touch RTP header/timestamp/sequence construction, SDP, or call state.
   */
  startAudioTest({ sipCallId, mode }) {
    const session = this._rtpSessions.get(sipCallId);
    if (!session) {
      logger.warn({ sipCallId, mode }, "[AUDIO TEST] startAudioTest — no RTP session for sipCallId");
      return false;
    }
    if (mode !== "silence" && mode !== "tone") {
      logger.warn({ sipCallId, mode }, "[AUDIO TEST] startAudioTest — unknown mode, ignoring");
      return false;
    }
    session._testMode = mode;
    session._testToneIndex = 0;
    session.toneIndexLog = []; // re-arm the first-60-indices proof log for this activation
    logger.info({ sipCallId, mode }, "[AUDIO TEST] test mode started — RTP payload now sourced from fixed test buffer");
    return true;
  }

  /**
   * Revert startAudioTest(): RTP payload goes back to session.outQueue
   * (browser mic audio) / silence fallback.
   */
  stopAudioTest({ sipCallId }) {
    const session = this._rtpSessions.get(sipCallId);
    if (!session) return false;
    delete session._testMode;
    delete session._testToneIndex;
    // Discard whatever accumulated in outQueue while test mode was diverting
    // the RTP payload elsewhere — otherwise it plays back as a stale burst
    // the instant real audio resumes, and skews the priming/underrun counters.
    session.outQueue = [];
    session.queuePrimed = false;
    // Full reset of recovery/concealment state too — test mode never fed
    // lastRealFramePcm, so stale state here could otherwise cause the first
    // post-test underrun to reference audio from before the test ran.
    session.queueRecovering = false;
    session.consecutiveUnderruns = 0;
    session.lastRealFramePcm = null;
    session.concealmentActive = false;
    session.concealmentFramesUsed = 0;
    logger.info({ sipCallId }, "[AUDIO TEST] test mode stopped — RTP payload reverts to normal queue");
    return true;
  }

  /**
   * Register the callback invoked with each received RTP payload (media
   * bytes only, RTP header already stripped) for relay to the browser.
   */
  onAudioFrame(fn) {
    this._onAudioFrame = fn;
  }

  /**
   * Queue a browser-supplied media frame (already encoded in the
   * negotiated codec) to be sent on the next 20 ms RTP tick. Capped so a
   * slow consumer can't build up latency.
   */
  sendAudioFrame({ sipCallId, frame }) {
    const session = this._rtpSessions.get(sipCallId);
    if (!session) {
      logger.warn({ sipCallId }, "[AUDIO WS IN BACKEND] sendAudioFrame — no RTP session for sipCallId, frame dropped");
      return;
    }
    // Browser encoder is A-law-only — drop anything queued against a
    // non-PCMA session instead of sending mislabeled/garbled RTP.
    if (session.payloadType !== 8) {
      if (!session._loggedBadCodec) {
        session._loggedBadCodec = true;
        logger.warn(
          { sipCallId, payloadType: session.payloadType },
          "[AUDIO WS IN BACKEND] sendAudioFrame — session codec is not PCMA(8), dropping browser audio frame",
        );
      }
      return;
    }
    session.audioFramesReceived++;
    session.outQueue.push({ frame, arrivalHr: process.hrtime.bigint() });

    // Overflow: trim oldest frames while over the count cap OR while the
    // oldest queued frame is already older than the max tolerated latency.
    // A normal ~4-frame browser burst never trips this against a 25-frame
    // cap — this only fires when the consumer has genuinely fallen behind.
    const maxAgeNs = BigInt(appConfig.RTP_AUDIO_QUEUE_MAX_LATENCY_MS) * 1_000_000n;
    const now = process.hrtime.bigint();
    let droppedThisCall = 0;
    while (
      session.outQueue.length > appConfig.RTP_AUDIO_QUEUE_MAX_FRAMES ||
      (session.outQueue.length > 0 && (now - session.outQueue[0].arrivalHr) > maxAgeNs)
    ) {
      session.outQueue.shift();
      droppedThisCall++;
    }
    if (droppedThisCall > 0) {
      session.audioFramesDropped += droppedThisCall;
      session.queueOverflowEvents++;
      rtpLogger.warn(
        { sipCallId, droppedThisCall, queueDepth: session.outQueue.length, totalDropped: session.audioFramesDropped },
        "[RTP AUDIO QUEUE] overflow — dropped oldest frame(s)",
      );
    }

    session.audioFramesQueued++;
    session.rxFrameCount = (session.rxFrameCount || 0) + 1;
    if (session.rxFrameCount === 1 || session.rxFrameCount % 50 === 0) {
      logger.info(
        { sipCallId, count: session.rxFrameCount, bytes: frame.length, queueDepth: session.outQueue.length },
        "[AUDIO WS IN BACKEND] browser audio frame queued for RTP send",
      );
    }
  }

  _sendAck({
    fromExtension,
    targetNumber,
    domain,
    sipCallId,
    fromTag,
    toTag,
    cseq = 1,
    contactUri = null,
    routeHeaders = [],
    branch = null,
    host = null,
    port = null,
  }) {
    const requestUri = contactUri || `sip:${targetNumber}@${domain}`;

    // Determine physical send address: Route set → Contact URI → SIP server fallback
    let ackHost = host || this._config.sipServer;
    let ackPort = port || this._config.sipPort;
    if (!host && routeHeaders.length > 0) {
      const m = routeHeaders[0].match(/sip:(?:[^@]+@)?([^;>\s:]+)(?::(\d+))?/i);
      if (m) { ackHost = m[1]; ackPort = m[2] ? parseInt(m[2], 10) : this._config.sipPort; }
    } else if (!host && contactUri) {
      const m = contactUri.match(/sip:(?:[^@]+@)?([^;>\s:]+)(?::(\d+))?/i);
      if (m) { ackHost = m[1]; ackPort = m[2] ? parseInt(m[2], 10) : this._config.sipPort; }
    }

    const msg = this._buildAck({
      fromExtension,
      targetNumber,
      domain,
      sipCallId,
      fromTag,
      toTag,
      cseq,
      requestUri,
      routeHeaders,
      branch,
    });

    logger.info(
      { sipCallId, cseq, requestUri, ackHost, ackPort, routeCount: routeHeaders.length },
      `PromoSoftSipClient: → ACK\n${msg}`,
    );

    const buf = Buffer.from(msg, "utf8");
    this._socket.send(buf, 0, buf.length, ackPort, ackHost, (err) => {
      if (err) {
        logger.warn(
          { err: err.message, sipCallId },
          "PromoSoftSipClient: ACK send failed",
        );
      } else {
        logger.info(
          { sipCallId, from: fromExtension, to: targetNumber, cseq, ackHost, ackPort },
          "PromoSoftSipClient: → ACK sent (confirmed)",
        );
      }
    });
  }

  /* ── RFC 3261 Timer G — 200 OK retransmission ───────────────────────── */

  /**
   * Retransmit the 200 OK for an INVITE until the ACK arrives or Timer G expires.
   * T1=500ms doubles each retry up to T2=4 s cap; total window = 64×T1 = 32 s.
   * Stores a `stopRetx` cancellation function on the call entry.
   */
  _start200OkRetransmit({ sipCallId, msg, rinfo }) {
    const T1          = 500;
    const T2          = 4_000;
    const MAX_ELAPSED = 64 * T1; // 32 s — Timer G ceiling
    let delay   = T1;
    let elapsed = 0;
    let timer   = null;

    const stop = () => { if (timer) { clearTimeout(timer); timer = null; } };

    const schedule = () => {
      if (elapsed >= MAX_ELAPSED) return;
      timer = setTimeout(() => {
        elapsed += delay;
        const c = this._calls.get(sipCallId);
        if (!c || c.status === "confirmed") { stop(); return; }
        if (!this._socket) { stop(); return; }
        const buf = Buffer.from(msg, "utf8");
        this._socket.send(buf, 0, buf.length, rinfo.port, rinfo.address, (err) => {
          if (err) logger.warn({ err: err.message, sipCallId }, "PromoSoftSipClient: 200 OK retransmit failed");
          else     logger.debug({ sipCallId, delay, elapsed }, "PromoSoftSipClient: 200 OK retransmitted (Timer G)");
        });
        delay = Math.min(delay * 2, T2);
        schedule();
      }, delay);
    };

    const call = this._calls.get(sipCallId);
    if (call) call.stopRetx = stop;
    schedule();
  }

  /* ── Inbound call answer / reject ───────────────────────────────────── */

  /**
   * Send 200 OK in response to an incoming INVITE (answer the call).
   *
   * Builds a 200 OK with SDP, sends it to the address from which the INVITE
   * arrived, updates the _calls entry from "ringing" → "answered", and resolves with
   * the dialog tags so the adapter can update its state.
   *
   * @param {{ sipCallId: string, onRemoteBye: Function }} param
   */
  async answerIncoming({ sipCallId, onRemoteBye }) {
    if (!this._socket) throw new PromoSoftSipError("SIP socket not open");

    const call = this._calls.get(sipCallId);
    if (!call || call.direction !== "inbound") {
      throw new PromoSoftSipError(`answerIncoming: no inbound call found for ${sipCallId}`);
    }
    if (call.status !== "ringing") {
      throw new PromoSoftSipError(`answerIncoming: inbound call is not ringing (status="${call.status}")`);
    }

    const {
      callId,
      callerNumber,
      callerTag,
      targetNumber,
      localTag,
      fromHeader,
      toHeader,
      viaHeader,
      cseq: inviteCseq,
      rinfo,
    } = call;

    const toValue = toHeader.includes("tag=") ? toHeader : `${toHeader};tag=${localTag}`;

    // SDP negotiation: parse INVITE offer, select one compatible codec
    logger.info(
      { sipCallId, inviteSdp: call.sdp || "(none)" },
      "PromoSoftSipClient: INVITE SDP offer (raw)",
    );
    const offeredCodecs = this._parseSdpCodecs(call.sdp);
    logger.info({ sipCallId, offeredCodecs }, "PromoSoftSipClient: INVITE offered codecs");
    const selectedCodec = this._selectCodec(offeredCodecs);

    // Parse remote RTP endpoint from INVITE SDP (c= and m=audio lines)
    let { remoteIp, remotePort } = this._parseSdpRemoteRtp(call.sdp);
    if (!remoteIp || remoteIp === "0.0.0.0") remoteIp = rinfo.address;
    logger.info(
      { sipCallId, remoteRtp: `${remoteIp}:${remotePort}`, selectedCodec },
      "PromoSoftSipClient: remote RTP endpoint parsed from INVITE SDP",
    );

    // Open the local RTP socket before sending 200 OK so the port is already listening
    const localRtpPort = await this._openRtpSocket({
      sipCallId, remoteIp, remotePort: remotePort || 0, payloadType: selectedCodec.payloadType,
    });
    const advertiseRtpIp = this._config.publicRtpIp || this._localIp;
    const { sdp: localSdp } = this._buildSdpAnswer({ offeredCodecs, localPort: localRtpPort, advertiseIp: advertiseRtpIp });
    logger.info(
      { sipCallId, selectedCodec, advertisedRtp: `${advertiseRtpIp}:${localRtpPort}`, localSdp },
      "PromoSoftSipClient: SDP answer — selected codec",
    );
    const bodyLen = Buffer.byteLength(localSdp, "utf8");

    const contact200 = `<${this._contactUri(targetNumber)}>`;
    logger.info(
      { sipCallId, contact200, rinstance: this._rinstance },
      "PromoSoftSipClient: 200 OK Contact",
    );

    // RFC 4028 session timers: if the INVITE carried Session-Expires we MUST echo it
    // in the 200 OK (especially when Require: timer was present).  Delegate refresh to
    // the UAC (Asterisk) so we don't need to send periodic re-INVITEs.
    let sessionExpiresLine = null;
    let minSeLine          = null;
    let requireTimerLine   = null;
    if (call.sessionExpiresHeader) {
      const seVal        = call.sessionExpiresHeader.replace(/;?\s*refresher=\w+/i, "").trim();
      sessionExpiresLine = `Session-Expires: ${seVal};refresher=uac`;
      minSeLine          = `Min-SE: ${call.minSeHeader || "90"}`;
      if (call.requiresTimer) requireTimerLine = "Require: timer";
    }

    const headerLines = [
      "SIP/2.0 200 OK",
      viaHeader  ? `Via: ${viaHeader}`   : null,
      fromHeader ? `From: ${fromHeader}` : null,
      `To: ${toValue}`,
      `Call-ID: ${sipCallId}`,
      `CSeq: ${inviteCseq}`,
      `Contact: ${contact200}`,
      // Record-Route must be mirrored verbatim (RFC 3261 §12.1.1)
      call.recordRoute ? `Record-Route: ${call.recordRoute}` : null,
      requireTimerLine,
      sessionExpiresLine,
      minSeLine,
      `Allow: INVITE, ACK, BYE, CANCEL, OPTIONS`,
      `Supported: replaces`,
      `User-Agent: LabelGateway/1.0`,
      `Content-Type: application/sdp`,
      `Content-Length: ${bodyLen}`,
    ].filter(Boolean);
    // Build headers and body separately so the mandatory blank-line separator
    // (RFC 3261 §7) can never be dropped by .filter(Boolean) stripping the "".
    const lines = [headerLines.join("\r\n"), "", localSdp];

    const msg = lines.join("\r\n");

    if (this._dumper) {
      const f = this._dumper.dump(sipCallId, "answer-200ok", msg);
      if (f) logger.info({ dump: f }, "PromoSoftSipClient: SIP dump → answer-200ok");
    }

    logger.info(
      {
        callId,
        sipCallId,
        from:           callerNumber,
        to:             targetNumber,
        localTag,
        callerTag,
        sendTo:         `${rinfo.address}:${rinfo.port}`,
        viaHeader:      viaHeader || "(none)",
        sessionExpires: sessionExpiresLine || "(none)",
        recordRoute:    call.recordRoute   || "(none)",
      },
      `PromoSoftSipClient: → 200 OK (answer)\n${msg}`,
    );

    // Update the existing _calls entry in place — no delete+re-add so no window where
    // a concurrent BYE could miss the call.
    call.status      = "answered";
    call.onRemoteBye = onRemoteBye || (() => {});
    call.response200 = msg; // stored for INVITE-retransmit re-send (see _handleIncomingInvite)

    return new Promise((resolve, reject) => {
      const buf = Buffer.from(msg, "utf8");
      this._socket.send(buf, 0, buf.length, rinfo.port, rinfo.address, (err) => {
        if (err) {
          call.status      = "ringing";
          call.onRemoteBye = null;
          call.response200 = null;
          this._closeRtpSession(sipCallId);
          logger.warn({ err: err.message, sipCallId }, "PromoSoftSipClient: 200 OK (answer) send failed");
          reject(new PromoSoftSipError(`200 OK send failed: ${err.message}`, err));
        } else {
          logger.info(
            { callId, sipCallId, from: callerNumber, to: targetNumber, sendTo: `${rinfo.address}:${rinfo.port}` },
            "PromoSoftSipClient: 200 OK (answer) sent — awaiting ACK",
          );
          call.answer200SentAt = Date.now();
          // RFC 3261 §13.3.1.4 Timer G: retransmit 200 OK until ACK arrives.
          this._start200OkRetransmit({ sipCallId, msg, rinfo });
          // Start RTP immediately — don't wait for ACK so Asterisk receives media right away.
          this._startRtpMediaLoop(sipCallId);
          resolve({ sipCallId, localTag, callerTag, callerNumber, targetNumber });
        }
      });
    });
  }

  /**
   * Send a final rejection response (486 Busy Here or 603 Decline) to an
   * incoming INVITE that the user chose not to answer.
   *
   * @param {{ sipCallId: string, statusCode?: number }} param
   */
  async rejectIncoming({ sipCallId, statusCode = 486 }) {
    if (!this._socket) throw new PromoSoftSipError("SIP socket not open");

    const call = this._calls.get(sipCallId);
    if (!call || call.direction !== "inbound") {
      logger.warn({ sipCallId }, "PromoSoftSipClient: rejectIncoming — no inbound call found (already gone?)");
      return;
    }
    if (typeof call.stopRetx === "function") call.stopRetx();
    this._calls.delete(sipCallId);

    const {
      callId,
      callerNumber,
      targetNumber,
      localTag,
      fromHeader,
      toHeader,
      viaHeader,
      cseq: inviteCseq,
      rinfo,
    } = call;

    const reason   = statusCode === 486 ? "Busy Here" : statusCode === 603 ? "Decline" : "Rejected";
    const toValue  = toHeader.includes("tag=") ? toHeader : `${toHeader};tag=${localTag}`;

    const lines = [
      `SIP/2.0 ${statusCode} ${reason}`,
      viaHeader  ? `Via: ${viaHeader}`   : null,
      fromHeader ? `From: ${fromHeader}` : null,
      `To: ${toValue}`,
      `Call-ID: ${sipCallId}`,
      `CSeq: ${inviteCseq}`,
      "Content-Length: 0",
      "",
      "",
    ].filter(Boolean);

    const msg = lines.join("\r\n");

    logger.info(
      { callId, sipCallId, from: callerNumber, to: targetNumber, statusCode, reason },
      `PromoSoftSipClient: → ${statusCode} ${reason} (reject)`,
    );

    return new Promise((resolve, reject) => {
      const buf = Buffer.from(msg, "utf8");
      this._socket.send(buf, 0, buf.length, rinfo.port, rinfo.address, (err) => {
        if (err) {
          logger.warn({ err: err.message, sipCallId, statusCode }, "PromoSoftSipClient: reject send failed");
          reject(new PromoSoftSipError(`${statusCode} send failed: ${err.message}`, err));
        } else {
          logger.info({ callId, sipCallId, statusCode }, "PromoSoftSipClient: reject sent");
          resolve();
        }
      });
    });
  }

  /* ── Call method stubs (pending further SIP integration) ──────────────── */

  answer(_p) {
    return Promise.reject(
      new PromoSoftSipError("SIP ANSWER not yet implemented"),
    );
  }
  decline(_p) {
    return Promise.reject(
      new PromoSoftSipError("SIP DECLINE not yet implemented"),
    );
  }
  hold(_p) {
    return Promise.reject(
      new PromoSoftSipError("SIP HOLD not yet implemented"),
    );
  }
  resume(_p) {
    return Promise.reject(
      new PromoSoftSipError("SIP RESUME not yet implemented"),
    );
  }
  refer(_p) {
    return Promise.reject(
      new PromoSoftSipError("SIP REFER not yet implemented"),
    );
  }
  dtmf(_p) {
    return Promise.reject(
      new PromoSoftSipError("SIP DTMF not yet implemented"),
    );
  }

  /* ── Unique SIP identifiers ─────────────────────────────────────────── */

  _newCallId() {
    return `${crypto.randomBytes(8).toString("hex")}@${this._localIp || "local"}`;
  }
  _newTag() {
    return crypto.randomBytes(6).toString("hex");
  }
  // Branch MUST start with the magic cookie "z9hG4bK" per RFC 3261 §8.1.1.7
  _newBranch() {
    return `z9hG4bK${crypto.randomBytes(8).toString("hex")}`;
  }

  /* ── Cleanup ─────────────────────────────────────────────────────────── */

  destroy() {
    this._clearKeepalive();
    for (const w of this._pending.values()) {
      clearTimeout(w.timer);
      w.reject(new PromoSoftSipError("SIP client destroyed"));
    }
    this._pending.clear();
    for (const inv of this._invites.values()) {
      clearTimeout(inv.timer);
      inv.reject(new PromoSoftSipError("SIP client destroyed"));
    }
    this._invites.clear();
    // Notify the adapter for any calls still active at destroy time
    for (const [sipCallId, call] of this._calls.entries()) {
      if (typeof call.stopRetx === "function") call.stopRetx();
      if (call.direction === "inbound" && call.status === "ringing") {
        // Unanswered inbound — notify as cancelled
        if (typeof this._onIncomingCall === "function") {
          try {
            this._onIncomingCall({ callId: call.callId, sipCallId, from: call.callerNumber, to: call.targetNumber, cancelled: true });
          } catch (_) {}
        }
      } else if (call.onRemoteBye) {
        try {
          call.onRemoteBye({ sipCallId, fromTag: null, toTag: null });
        } catch (_) {}
      }
    }
    for (const sipCallId of this._rtpSessions.keys()) {
      this._closeRtpSession(sipCallId);
    }
    this._calls.clear();
    this._endedCallIds.clear();
    this._closeSocket();
    this._registered = false;
    this._session = null;
  }
}

module.exports = PromoSoftSipClient;
