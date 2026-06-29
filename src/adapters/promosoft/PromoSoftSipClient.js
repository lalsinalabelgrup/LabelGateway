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

const dgram  = require('node:dgram');
const crypto = require('node:crypto');
const logger = require('../../utils/logger');
const { PromoSoftSipError } = require('./PromoSoftErrors');

const EXPIRES_SEC         = 3600;   // requested registration lifetime
const REREGISTER_LEAD_SEC = 60;     // refresh this many seconds before expiry
const TRANSACTION_TIMEOUT = 32_000; // RFC 3261 Timer B (max wait for response)

class PromoSoftSipClient {
  constructor(config) {
    this._config         = config;
    this._socket         = null;
    this._localIp        = null;
    this._localPort      = null;
    this._registered     = false;
    // session: extension + password kept for re-REGISTER keepalive only.
    // password is NEVER logged. Cleared on destroy/unregister.
    this._session        = null;
    this._keepaliveTimer = null;
    this._calls          = new Map();
    // pendingKey `${callId}:${cseq}` → { resolve, reject, timer }
    this._pending        = new Map();
  }

  get isRegistered() { return this._registered; }

  /* ── Registration ────────────────────────────────────────────────────── */

  /**
   * Perform SIP REGISTER. Handles the 401 digest challenge cycle automatically.
   * @param {{ extension: string, password: string }} credentials
   * @returns {Promise<{ extension: string }>}
   */
  async register({ extension, password }) {
    await this._openSocket();

    const domain = this._config.serverDomain;
    const host   = this._config.sipServer;
    const port   = this._config.sipPort;
    const callId = this._newCallId();
    const tag    = this._newTag();

    // ── Step 1: Unauthenticated REGISTER ────────────────────────────────
    logger.debug({ extension, host, port }, 'PromoSoftSipClient: → REGISTER (unauthenticated)');
    const res1 = await this._sendAndWait(
      this._buildRegister({ extension, domain, callId, tag, seq: 1 }),
      host, port, `${callId}:1`
    );

    let finalRes = res1;

    // ── Step 2: Digest challenge (401/407) ──────────────────────────────
    if (res1.status === 401 || res1.status === 407) {
      const wwwAuth = res1.headers['www-authenticate'] || res1.headers['proxy-authenticate'];
      if (!wwwAuth) {
        throw new PromoSoftSipError(`SIP ${res1.status} Unauthorized but no WWW-Authenticate header`);
      }

      const challenge = this._parseDigestChallenge(wwwAuth);
      const authz     = this._computeDigestAuth({
        extension, password,
        realm: challenge.realm,
        nonce: challenge.nonce,
        qop:   challenge.qop,
        uri:   `sip:${domain}`,
      });

      logger.debug({ extension }, 'PromoSoftSipClient: → REGISTER (authenticated, password redacted)');
      finalRes = await this._sendAndWait(
        this._buildRegister({ extension, domain, callId, tag, seq: 2, authorization: authz }),
        host, port, `${callId}:2`
      );
    }

    // ── Step 3: Check final response ────────────────────────────────────
    if (finalRes.status === 200) {
      this._registered = true;
      // password stored only for re-REGISTER keepalive — never logged
      this._session    = { extension, callId, tag, domain, password };
      logger.info({ extension }, 'PromoSoftSipClient: ← 200 OK — registered');
      this._scheduleReRegister();
      return { extension };
    }

    throw new PromoSoftSipError(
      `SIP REGISTER failed: ${finalRes.status} ${finalRes.reason}`
    );
  }

  /**
   * Unregister by sending REGISTER with Expires: 0.
   * @returns {Promise<void>}
   */
  async unregister() {
    this._clearKeepalive();
    if (!this._registered || !this._session) {
      this._closeSocket();
      return;
    }
    const { extension, callId, tag, domain } = this._session;
    try {
      await this._sendAndWait(
        this._buildRegister({ extension, domain, callId, tag, seq: 99, expires: 0 }),
        this._config.sipServer, this._config.sipPort, `${callId}:99`
      );
      logger.info({ extension }, 'PromoSoftSipClient: unregistered (Expires: 0 accepted)');
    } catch (err) {
      logger.warn({ extension, err: err.message }, 'PromoSoftSipClient: REGISTER Expires=0 failed (ignored)');
    }
    this._registered = false;
    this._session    = null;
    this._closeSocket();
  }

  /* ── UDP socket ──────────────────────────────────────────────────────── */

  async _openSocket() {
    if (this._socket) return;

    const sock = dgram.createSocket('udp4');
    sock.on('message', (buf, rinfo) => this._onMessage(buf, rinfo));
    sock.on('error',   (err) => logger.error({ err: err.message }, 'PromoSoftSipClient: socket error'));

    await new Promise((resolve, reject) => {
      sock.bind(0, (err) => (err ? reject(err) : resolve()));
    });

    this._socket    = sock;
    this._localPort = sock.address().port;
    this._localIp   = await this._probeLocalIp();

    logger.debug(
      { ip: this._localIp, port: this._localPort },
      'PromoSoftSipClient: UDP socket ready'
    );
  }

  /**
   * Discover the local IP that can reach the SIP server by using a temporary
   * connected UDP socket (OS routing fills in the right interface — no packets sent).
   */
  async _probeLocalIp() {
    return new Promise((resolve) => {
      const tmp = dgram.createSocket('udp4');
      tmp.connect(this._config.sipPort, this._config.sipServer, () => {
        const ip = tmp.address().address;
        tmp.close();
        resolve(ip);
      });
    });
  }

  _closeSocket() {
    if (!this._socket) return;
    try { this._socket.close(); } catch (_) {}
    this._socket    = null;
    this._localIp   = null;
    this._localPort = null;
  }

  /* ── Incoming message routing ────────────────────────────────────────── */

  _onMessage(buf, rinfo) {
    const text = buf.toString('utf8');
    if (this._config.debug) {
      logger.debug({ bytes: buf.length, from: `${rinfo.address}:${rinfo.port}` }, 'PromoSoftSipClient: ← raw');
    }

    const parsed = this._parseMessage(text);

    if (parsed.status !== null) {
      // SIP response — route to the pending waiter by Call-ID + CSeq
      const h   = parsed.headers;
      const key = `${h['call-id'] || ''}:${(h['cseq'] || '').match(/^(\d+)/)?.[1] || '0'}`;
      const w   = this._pending.get(key);
      if (w) {
        clearTimeout(w.timer);
        this._pending.delete(key);
        w.resolve({ status: parsed.status, reason: parsed.reason, headers: h });
      } else {
        logger.debug({ status: parsed.status, key }, 'PromoSoftSipClient: unsolicited response ignored');
      }
    } else if (parsed.method) {
      // SIP request from server (OPTIONS keepalive, NOTIFY, etc.)
      logger.debug({ method: parsed.method }, 'PromoSoftSipClient: ← server request');
      if (parsed.method === 'OPTIONS') {
        this._replyOptions(parsed.headers, rinfo);
      }
      // TODO: handle incoming INVITE (inbound calls), NOTIFY (call events), BYE
    }
  }

  /* ── Send and await matching response ───────────────────────────────── */

  _sendAndWait(msg, host, port, key) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(key);
        reject(new PromoSoftSipError(
          `SIP transaction timeout after ${TRANSACTION_TIMEOUT / 1000}s — no response from ${host}:${port}`
        ));
      }, TRANSACTION_TIMEOUT);

      this._pending.set(key, { resolve, reject, timer });

      const buf = Buffer.from(msg, 'utf8');
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

  _buildRegister({ extension, domain, callId, tag, seq, expires = EXPIRES_SEC, authorization }) {
    const lines = [
      `REGISTER sip:${domain} SIP/2.0`,
      // rport: ask the server to use the actual source address in its response (RFC 3581 NAT traversal)
      `Via: SIP/2.0/UDP ${this._localIp}:${this._localPort};branch=${this._newBranch()};rport`,
      `From: <sip:${extension}@${domain}>;tag=${tag}`,
      `To: <sip:${extension}@${domain}>`,
      `Call-ID: ${callId}`,
      `CSeq: ${seq} REGISTER`,
      `Contact: <sip:${extension}@${this._localIp}:${this._localPort}>;expires=${expires}`,
      `Expires: ${expires}`,
      `Max-Forwards: 70`,
      `User-Agent: LabelGateway/1.0`,
    ];
    if (authorization) lines.push(`Authorization: ${authorization}`);
    lines.push('Content-Length: 0', '', '');
    return lines.join('\r\n');
  }

  /**
   * Reply to a server-initiated OPTIONS with 200 OK so the PBX knows we are alive.
   * Many PBXes send periodic OPTIONS as a keepalive probe and deregister if no reply.
   */
  _replyOptions(headers, rinfo) {
    const lines = [
      'SIP/2.0 200 OK',
      headers['via']     ? `Via: ${headers['via']}`                        : null,
      headers['from']    ? `From: ${headers['from']}`                       : null,
      headers['to']      ? `To: ${headers['to']};tag=${this._newTag()}`     : null,
      headers['call-id'] ? `Call-ID: ${headers['call-id']}`                 : null,
      headers['cseq']    ? `CSeq: ${headers['cseq']}`                       : null,
      'Content-Length: 0',
      '',
      '',
    ].filter(Boolean);

    const buf = Buffer.from(lines.join('\r\n'), 'utf8');
    this._socket.send(buf, 0, buf.length, rinfo.port, rinfo.address, (err) => {
      if (err) logger.warn({ err: err.message }, 'PromoSoftSipClient: OPTIONS reply failed');
      else     logger.debug({ to: `${rinfo.address}:${rinfo.port}` }, 'PromoSoftSipClient: → OPTIONS 200 OK');
    });
  }

  /* ── SIP message parser ──────────────────────────────────────────────── */

  /**
   * Minimal SIP message parser that extracts what we need for REGISTER flow.
   * Returns { status, reason, method, headers }.
   * status/reason are set for responses; method is set for requests.
   */
  _parseMessage(text) {
    const [firstLine, ...rest] = text.split('\r\n');
    let status = null, reason = null, method = null;

    const statusM = firstLine.match(/^SIP\/2\.0\s+(\d+)\s*(.*)/);
    if (statusM) {
      status = parseInt(statusM[1], 10);
      reason = statusM[2] || '';
    } else {
      const reqM = firstLine.match(/^([A-Z]+)\s+/);
      if (reqM) method = reqM[1];
    }

    const headers = {};
    for (const line of rest) {
      if (!line) break; // empty line = header/body separator
      const colon = line.indexOf(':');
      if (colon < 0) continue;
      const name  = line.slice(0, colon).trim().toLowerCase();
      const value = line.slice(colon + 1).trim();
      // Last value wins for duplicate headers. For Via this loses multi-hop info,
      // but we only originate single-hop requests so this is fine.
      headers[name] = value;
    }

    return { status, reason, method, headers };
  }

  /* ── Digest authentication (RFC 2617 / RFC 3261 §22.4) ──────────────── */

  _parseDigestChallenge(header) {
    const pick = (name) => {
      const m = header.match(new RegExp(`${name}=(?:"([^"]*)"|([^,\\s]+))`, 'i'));
      return m ? (m[1] !== undefined ? m[1] : m[2]) : null;
    };
    return {
      realm: pick('realm') || '',
      nonce: pick('nonce') || '',
      qop:   pick('qop')   || null,
    };
  }

  _computeDigestAuth({ extension, password, realm, nonce, qop, uri }) {
    const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');
    const ha1  = md5(`${extension}:${realm}:${password}`);
    const ha2  = md5(`REGISTER:${uri}`);

    const params = [
      `username="${extension}"`,
      `realm="${realm}"`,
      `nonce="${nonce}"`,
      `uri="${uri}"`,
      `algorithm=MD5`,
    ];

    if (qop) {
      const nc     = '00000001';
      const cnonce = crypto.randomBytes(8).toString('hex');
      params.push(
        `cnonce="${cnonce}"`,
        `nc=${nc}`,
        `qop=auth`,
        `response="${md5(`${ha1}:${nonce}:${nc}:${cnonce}:auth:${ha2}`)}"`,
      );
    } else {
      params.push(`response="${md5(`${ha1}:${nonce}:${ha2}`)}"`);
    }

    return `Digest ${params.join(', ')}`;
  }

  /* ── Re-REGISTER keepalive ───────────────────────────────────────────── */

  _scheduleReRegister() {
    this._clearKeepalive();
    const ms = (EXPIRES_SEC - REREGISTER_LEAD_SEC) * 1000;
    this._keepaliveTimer = setTimeout(() => {
      if (!this._session) return;
      const { extension, password } = this._session;
      logger.debug({ extension }, 'PromoSoftSipClient: re-REGISTER (keepalive)');
      this.register({ extension, password }).catch((err) =>
        logger.error({ extension, err: err.message }, 'PromoSoftSipClient: re-REGISTER failed')
      );
    }, ms);
  }

  _clearKeepalive() {
    if (this._keepaliveTimer) { clearTimeout(this._keepaliveTimer); this._keepaliveTimer = null; }
  }

  /* ── Call method stubs (pending SIP INVITE integration) ──────────────── */

  invite(_p)  { return Promise.reject(new PromoSoftSipError('SIP INVITE not yet implemented')); }
  answer(_p)  { return Promise.reject(new PromoSoftSipError('SIP ANSWER not yet implemented')); }
  decline(_p) { return Promise.reject(new PromoSoftSipError('SIP DECLINE not yet implemented')); }
  bye(_p)     { return Promise.reject(new PromoSoftSipError('SIP BYE not yet implemented')); }
  hold(_p)    { return Promise.reject(new PromoSoftSipError('SIP HOLD not yet implemented')); }
  resume(_p)  { return Promise.reject(new PromoSoftSipError('SIP RESUME not yet implemented')); }
  refer(_p)   { return Promise.reject(new PromoSoftSipError('SIP REFER not yet implemented')); }
  dtmf(_p)    { return Promise.reject(new PromoSoftSipError('SIP DTMF not yet implemented')); }

  /* ── Unique SIP identifiers ─────────────────────────────────────────── */

  _newCallId() { return `${crypto.randomBytes(8).toString('hex')}@${this._localIp || 'local'}`; }
  _newTag()    { return crypto.randomBytes(6).toString('hex'); }
  // Branch MUST start with the magic cookie "z9hG4bK" per RFC 3261 §8.1.1.7
  _newBranch() { return `z9hG4bK${crypto.randomBytes(8).toString('hex')}`; }

  /* ── Cleanup ─────────────────────────────────────────────────────────── */

  destroy() {
    this._clearKeepalive();
    for (const w of this._pending.values()) {
      clearTimeout(w.timer);
      w.reject(new PromoSoftSipError('SIP client destroyed'));
    }
    this._pending.clear();
    this._closeSocket();
    this._registered = false;
    this._session    = null;
    this._calls.clear();
  }
}

module.exports = PromoSoftSipClient;
