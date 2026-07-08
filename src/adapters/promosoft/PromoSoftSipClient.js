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
const logger = require("../../utils/logger");
const { PromoSoftSipError } = require("./PromoSoftErrors");
const SipDumper = require("./SipDumper");

const EXPIRES_SEC = 3600; // requested registration lifetime
const REREGISTER_LEAD_SEC = 60; // refresh this many seconds before expiry
const TRANSACTION_TIMEOUT = 32_000; // RFC 3261 Timer B (max wait for response)

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
    // Rolling cursor into [config.rtpPortMin, config.rtpPortMax] for port allocation.
    this._rtpPortCursor = null;
    // Stable SDP session-id/version for this process lifetime (RFC 4566 §5.2 o= line).
    // Using an NTP-epoch second avoids the invalid "0 0" that some Asterisk versions reject.
    this._sdpSessionId = Math.floor(Date.now() / 1000);
    // Raw SIP message dumper — only active when PROMOSOFT_SIP_DUMP=true.
    this._dumper = config.sipDump
      ? new SipDumper(path.join(process.cwd(), "logs", "sip"))
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
            // Track the established dialog so an incoming remote BYE can be matched
            this._calls.set(sipCallId, {
              fromExtension: inv.fromExtension,
              targetNumber: inv.targetNumber,
              fromTag: inv.fromTag,
              toTag,
              domain: inv.domain,
              onRemoteBye: inv.onRemoteBye,
            });
            inv.resolve({ status, sipCallId, fromTag: inv.fromTag, toTag });
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
            const retryMsg = this._buildInvite({
              fromExtension: inv.fromExtension,
              targetNumber: inv.targetNumber,
              domain: inv.domain,
              sipCallId,
              fromTag: inv.fromTag,
              sdp: inv.sdp,
              cseq: inv.cseq,
              authorization: authz,
            });
            logger.info(
              {
                sipCallId,
                from: inv.fromExtension,
                to: inv.targetNumber,
                realm: challenge.realm,
                cseq: inv.cseq,
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
            // 3xx–6xx: final failure (or second 401 — auth gave up)
            clearTimeout(inv.timer);
            this._invites.delete(sipCallId);
            logger.warn(
              {
                status,
                reason: parsed.reason,
                sipCallId,
                from: inv.fromExtension,
                to: inv.targetNumber,
              },
              "PromoSoftSipClient: ← INVITE failed",
            );
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
  async invite({ fromExtension, targetNumber, onProvisional, onRemoteBye }) {
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
    const sdp = this._buildSdp();

    // Equivalent of JsSIP "newRTCSession" — log sipCallId so every subsequent
    // event can be correlated back to this call.
    logger.info(
      { fromExtension, targetNumber, sipCallId, host, port },
      "PromoSoftSipClient: → INVITE (newRTCSession)",
    );
    if (this._config.debug) {
      logger.debug(
        { fromExtension, targetNumber, sipCallId },
        `PromoSoftSipClient: SDP offer:\n${sdp}`,
      );
    }

    const msg = this._buildInvite({
      fromExtension,
      targetNumber,
      domain,
      sipCallId,
      fromTag,
      sdp,
      cseq: 1,
    });
    if (this._config.debug) {
      logger.debug(
        { direction: "OUT", sipCallId },
        `PromoSoftSipClient: INVITE packet:\n${msg}`,
      );
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._invites.delete(sipCallId);
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

      // sdp, cseq, and onRemoteBye are stored for the 401 retry handler and
      // post-answer BYE dispatch.
      this._invites.set(sipCallId, {
        fromExtension,
        targetNumber,
        fromTag,
        domain,
        sdp,
        cseq: 1,
        authAttempted: false,
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
      { fromExtension, targetNumber, sipCallId },
      "PromoSoftSipClient: BYE (ended)",
    );
    return this._sendAndWait(msg, host, port, `${sipCallId}:2`);
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
  }) {
    const bodyLen = Buffer.byteLength(sdp, "utf8");
    const lines = [
      `INVITE sip:${targetNumber}@${domain} SIP/2.0`,
      `Via: SIP/2.0/UDP ${this._localIp}:${this._localPort};branch=${this._newBranch()};rport`,
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
  }) {
    const uri = requestUri || `sip:${targetNumber}@${domain}`;
    const toLine = toTag
      ? `To: <sip:${targetNumber}@${domain}>;tag=${toTag}`
      : `To: <sip:${targetNumber}@${domain}>`;
    const lines = [
      `ACK ${uri} SIP/2.0`,
      `Via: SIP/2.0/UDP ${this._localIp}:${this._localPort};branch=${this._newBranch()};rport`,
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

  _buildSdp() {
    // Outgoing INVITE offer — list multiple codecs so the remote can choose.
    const rtpPort = 20000;
    return [
      "v=0",
      `o=- 0 0 IN IP4 ${this._localIp}`,
      "s=LabelGateway",
      `c=IN IP4 ${this._localIp}`,
      "t=0 0",
      `m=audio ${rtpPort} RTP/AVP 8 0`,
      "a=rtpmap:8 PCMA/8000",
      "a=rtpmap:0 PCMU/8000",
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
            if (session.rxCount === 1 || session.rxCount % 50 === 0) {
              logger.info(
                { sipCallId, from: `${rinfo.address}:${rinfo.port}`, rxCount: session.rxCount, bytes: msg.length },
                "PromoSoftSipClient: RTP ← packet",
              );
            }
          });

          sock.on("error", (err) => {
            logger.warn({ sipCallId, err: err.message }, "PromoSoftSipClient: RTP socket error");
          });

          const { port: boundPort } = sock.address();
          session.localPort = boundPort;
          this._rtpPortCursor = boundPort >= portMax ? portMin : boundPort + 1;
          this._rtpSessions.set(sipCallId, session);

          logger.info(
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
   * Start sending PCMA/PCMU comfort-noise silence frames (20 ms intervals)
   * to the remote RTP endpoint.  Called after ACK confirms the dialog so
   * Asterisk does not time out waiting for media.
   */
  _startRtpSilence(sipCallId) {
    const session = this._rtpSessions.get(sipCallId);
    if (!session || session.sendTimer) return;

    const FRAME_SAMPLES = 160;    // 20 ms at 8 kHz
    const PT            = 8;      // PCMA — forced for diagnostic clarity
    const SILENCE_PCMA  = 0xD5;   // G.711 A-law silence value

    logger.info(
      {
        sipCallId,
        remoteRtp: `${session.remoteIp}:${session.remotePort}`,
        ssrc:      session.ssrc,
        pt:        PT,
      },
      "PromoSoftSipClient: RTP → starting PCMA silence stream (diagnostic)",
    );

    session.sendTimer = setInterval(() => {
      if (!session.socket || !session.remotePort || !session.remoteIp) return;

      const isMark = session.txCount === 0;
      const seq    = (session.seqNum + 1) & 0xFFFF;
      session.seqNum = seq;
      const ts = session.timestamp >>> 0;
      session.timestamp = (session.timestamp + FRAME_SAMPLES) >>> 0;

      const header = Buffer.alloc(12);
      header.writeUInt8(0x80, 0);                        // V=2, P=0, X=0, CC=0
      header.writeUInt8(isMark ? (0x80 | PT) : PT, 1);  // M bit on first packet only
      header.writeUInt16BE(seq, 2);
      header.writeUInt32BE(ts, 4);
      header.writeUInt32BE(session.ssrc, 8);

      const pkt = Buffer.concat([header, Buffer.alloc(FRAME_SAMPLES, SILENCE_PCMA)]);
      session.socket.send(pkt, 0, pkt.length, session.remotePort, session.remoteIp, (err) => {
        if (err) logger.warn({ sipCallId, err: err.message }, "PromoSoftSipClient: RTP send error");
      });

      session.txCount++;

      if (session.txCount <= 10) {
        logger.info(
          {
            sipCallId,
            txCount:   session.txCount,
            dest:      `${session.remoteIp}:${session.remotePort}`,
            pt:        PT,
            seq,
            timestamp: ts,
            ssrc:      session.ssrc,
            mark:      isMark,
            bytes:     pkt.length,
          },
          "PromoSoftSipClient: RTP → packet",
        );
      } else if (session.txCount % 50 === 0) {
        logger.debug(
          { sipCallId, txCount: session.txCount, remoteRtp: `${session.remoteIp}:${session.remotePort}` },
          "PromoSoftSipClient: RTP → silence",
        );
      }
    }, 20);
  }

  /**
   * Stop the RTP send timer and close the per-call UDP socket.
   */
  _closeRtpSession(sipCallId) {
    const session = this._rtpSessions.get(sipCallId);
    if (!session) return;
    this._rtpSessions.delete(sipCallId);
    if (session.sendTimer) clearInterval(session.sendTimer);
    try { session.socket.close(); } catch (_) {}
    logger.info({ sipCallId, rxCount: session.rxCount }, "PromoSoftSipClient: RTP session closed");
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
  }) {
    const requestUri = contactUri || `sip:${targetNumber}@${domain}`;

    // Determine physical send address: Route set → Contact URI → SIP server fallback
    let ackHost = this._config.sipServer;
    let ackPort = this._config.sipPort;
    if (routeHeaders.length > 0) {
      const m = routeHeaders[0].match(/sip:(?:[^@]+@)?([^;>\s:]+)(?::(\d+))?/i);
      if (m) { ackHost = m[1]; ackPort = m[2] ? parseInt(m[2], 10) : this._config.sipPort; }
    } else if (contactUri) {
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

    const lines = [
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
      "",
      localSdp,
    ].filter(Boolean);

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
          this._startRtpSilence(sipCallId);
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
