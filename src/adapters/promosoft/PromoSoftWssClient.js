'use strict';

/**
 * PromoSoftWssClient
 *
 * SIP/WSS transport for PromoSoft using JsSIP over WebSocket.
 * Replaces PromoSoftSipClient when PROMOSOFT_MODE=wss.
 *
 * SECURITY CONSTRAINTS (identical to PromoSoftSipClient):
 *   - Extension and password arrive ONLY via register({ extension, password }).
 *   - Passwords are NEVER written to logs.
 *   - Only extension (not password) appears in log entries.
 *
 * Milestone 1 — registration:
 *   register()   → JsSIP UA + WSS connect + SIP REGISTER
 *   unregister() → SIP REGISTER Expires:0 + UA stop
 *   destroy()    → UA stop, cleanup
 *
 * Milestone 2 — outgoing calls:
 *   invite({ fromExtension, targetNumber, onProvisional, onRemoteBye })
 *     → JsSIP UA.call() + SDP offer via SipRtcStub
 *     → resolves { sipCallId, fromTag, toTag, status } on confirmed
 *   bye({ ..., sipCallId })
 *     → JsSIP session.terminate() (sends BYE)
 *
 * NOTE: JsSIP was written for browsers.  installGlobals() (from SipRtcStub)
 * satisfies its RTCPeerConnection / RTCSessionDescription requirements in Node.js
 * without a real WebRTC stack.  The SDP offer uses G.711 on port 9 (discard) —
 * enough to ring the remote extension; actual audio is a later milestone.
 */

const JsSIP         = require('jssip');
const NodeWebSocket = require('jssip-node-websocket');
const logger        = require('../../utils/logger');
const { PromoSoftSipError } = require('./PromoSoftErrors');
const { installGlobals }    = require('./SipRtcStub');

// Install RTCPeerConnection / RTCSessionDescription shims once at module load.
// Safe to call multiple times — guarded by a flag inside installGlobals().
installGlobals();

// Send a double-CRLF keepalive every 20 seconds to prevent idle-close by the server.
// The SIP/WSS spec (RFC 5626) defines double-CRLF as the client→server ping;
// JsSIP Transport.js already handles the single-CRLF pong from the server.
const KEEPALIVE_INTERVAL_MS = 20_000;

class PromoSoftWssClient {
  /**
   * @param {import('./PromoSoftConfig')} config
   */
  constructor(config) {
    this._config         = config;
    this._ua             = null;
    this._socket         = null;       // persistent reference — prevents GC, enables keepalives
    this._keepAliveTimer = null;
    this._onIncomingCall = null;
    this._sessions       = new Map(); // sipCallId → JsSIP RTCSession

    if (config.debug) {
      JsSIP.debug.enable('JsSIP:*');
    } else {
      JsSIP.debug.disable('JsSIP:*');
    }
  }

  /** Called by PromoSoftAdapter to register the inbound-call callback. */
  setIncomingCallHandler(fn) {
    this._onIncomingCall = fn;
  }

  /* ── Registration ─────────────────────────────────────────────────────── */

  /**
   * Connect to the PromoSoft WSS endpoint and register with SIP REGISTER.
   *
   * Creates a fresh JsSIP UA every time (allows re-login with different credentials).
   * Resolves when 200 OK is received for REGISTER; rejects on transport or auth failure.
   * The UA and socket remain alive after the promise resolves — they are only torn
   * down via unregister() or destroy().
   *
   * @param {{ extension: string, password: string }} credentials
   * @returns {Promise<{ expiresIn: number|null }>}
   */
  register({ extension, password }) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const settle = (fn) => {
        if (settled) return;
        settled = true;
        fn();
      };

      // Tear down any previous UA before creating a new one.
      this._stopUa('re-login before new registration');

      const wsUrl    = this._config.wsUrl;
      const domain   = this._config.serverDomain;
      const authUser = this._config.authUser || extension;
      const sipUri   = `sip:${extension}@${domain}`;

      logger.info(
        { extension, wsUrl, sipUri, authUser, domain },
        'PromoSoftWssClient: starting WSS/SIP registration'
      );

      // ── Create WebSocket transport ───────────────────────────────────────
      let socket;
      try {
        socket = new NodeWebSocket(wsUrl);
      } catch (err) {
        reject(new PromoSoftSipError(
          `PromoSoftWssClient: failed to create WebSocket — ${err.message}`, err
        ));
        return;
      }

      // Store as instance property so it survives after the Promise settles
      // and is not garbage-collected while the UA is alive.
      this._socket = socket;

      // Intercept socket.disconnect() so we can log a stack trace whenever
      // anything (JsSIP internals, our own code, or a bug) closes the WS.
      const origDisconnect = socket.disconnect.bind(socket);
      socket.disconnect = () => {
        logger.warn(
          { extension, wsUrl, stack: new Error('socket.disconnect() called').stack },
          'PromoSoftWssClient: socket.disconnect() intercepted — see stack for caller'
        );
        origDisconnect();
      };

      // ── Parse PROMOSOFT_CONTACT_URI if configured ────────────────────────
      // By default JsSIP generates a random sip:<token>@<token>.invalid;transport=ws
      // as the Contact URI.  Some PBX dashboards resolve registered extensions by the
      // Contact host/user, so the .invalid token causes the extension to appear offline.
      // Setting a stable URI (sip:<ext>@<host>;transport=ws) fixes this.
      let contactUri = null;
      if (this._config.contactUri) {
        try {
          contactUri = JsSIP.Grammar.parse(this._config.contactUri, 'SIP_URI');
        } catch (parseErr) {
          logger.warn(
            { contactUri: this._config.contactUri, err: parseErr.message },
            'PromoSoftWssClient: PROMOSOFT_CONTACT_URI is invalid — using JsSIP default (.invalid)'
          );
        }
      }

      // ── Build UA config and log key fields ───────────────────────────────
      const uaConfig = {
        sockets            : [socket],
        uri                : sipUri,
        password           : password,
        authorization_user : authUser,
        register           : true,
        register_expires   : 300,
        // Increased from the default (2 s) to avoid confusion with the ~2-second
        // disconnect that was observed before the keepalive mechanism was added.
        connection_recovery_min_interval : 30,
        connection_recovery_max_interval : 120,
        log                : { builtinEnabled: false },
        ...(contactUri ? { contact_uri: contactUri } : {}),
      };

      logger.info(
        {
          uri                : sipUri,
          authorization_user : authUser,
          registrar_server   : `(derived from uri: sip:${domain})`,
          contact_uri        : contactUri
            ? contactUri.toString()
            : '(JsSIP default — random .invalid — set PROMOSOFT_CONTACT_URI to fix)',
        },
        'PromoSoftWssClient: JsSIP UA config'
      );

      // ── Create JsSIP UA ──────────────────────────────────────────────────
      const ua = new JsSIP.UA(uaConfig);

      // ── Transport events ─────────────────────────────────────────────────

      ua.on('connecting', () => {
        logger.info(
          { extension, wsUrl },
          'PromoSoftWssClient: WSS transport connecting (Sec-WebSocket-Protocol: sip)'
        );
      });

      ua.on('connected', () => {
        logger.info(
          { extension, wsUrl },
          'PromoSoftWssClient: WSS transport connected — sending SIP REGISTER'
        );
        this._startKeepAlive(socket, extension, wsUrl);
      });

      ua.on('disconnected', ({ error, code, reason, cause }) => {
        logger.warn(
          { extension, wsUrl, error, code: code ?? null, reason: reason ?? null, cause: cause ?? null },
          'PromoSoftWssClient: WSS transport disconnected'
        );
        this._stopKeepAlive();

        if (!settled) {
          const parts = [
            'WSS transport disconnected before SIP registration completed',
            reason ? `reason="${reason}"` : null,
            code   ? `code=${code}`       : null,
            cause  ? `cause="${cause}"`   : null,
          ].filter(Boolean);
          settle(() => reject(new PromoSoftSipError(parts.join(' '))));
        }
      });

      // ── Registration events ───────────────────────────────────────────────

      ua.on('registered', ({ response }) => {
        let expiresIn = null;
        try {
          const contact = response.getHeader('contact') || '';
          const m = contact.match(/;expires=(\d+)/i);
          if (m) {
            expiresIn = parseInt(m[1], 10);
          } else {
            const expiresHdr = response.getHeader('expires');
            if (expiresHdr) expiresIn = parseInt(expiresHdr, 10);
          }
        } catch (_) {}

        if (!settled) {
          // First registration — resolve the Promise.
          logger.info(
            { extension, expiresIn },
            'PromoSoftWssClient: SIP registered ✓ — UA will remain alive for re-registration'
          );
          settle(() => resolve({ expiresIn }));
        } else {
          // Subsequent re-registrations (before expiry) — just log, Promise already resolved.
          logger.info(
            { extension, expiresIn },
            'PromoSoftWssClient: SIP re-registered ✓ (periodic refresh)'
          );
        }
      });

      ua.on('registrationFailed', ({ cause, response }) => {
        const statusCode = response ? response.status_code : null;
        const statusText = response ? response.reason_phrase : null;
        const parts = [
          'SIP registration failed',
          `cause="${cause}"`,
          statusCode ? `status=${statusCode}` : null,
          statusText ? `("${statusText}")`    : null,
        ].filter(Boolean);
        const msg = parts.join(' ');

        logger.error(
          { extension, cause, statusCode, statusText },
          `PromoSoftWssClient: ${msg}`
        );
        settle(() => reject(new PromoSoftSipError(msg, null, statusCode)));
      });

      // ── Incoming calls (milestone 3) ─────────────────────────────────────
      // Auto-reject all incoming calls until inbound handling is implemented.
      ua.on('newRTCSession', ({ session }) => {
        if (session.direction === 'incoming') {
          logger.info(
            { extension, direction: 'incoming' },
            'PromoSoftWssClient: incoming INVITE — auto-rejecting (milestone 3 not yet implemented)'
          );
          try { session.terminate({ status_code: 486, reason_phrase: 'Busy Here' }); } catch (_) {}
        }
        // Outgoing sessions are tracked in invite() — no action needed here.
      });

      // ── Start ─────────────────────────────────────────────────────────────
      // Store UA as instance property BEFORE calling start() so no race window exists.
      this._ua = ua;
      logger.info({ extension, wsUrl }, 'PromoSoftWssClient: calling ua.start()');
      try {
        ua.start();
      } catch (err) {
        settle(() => reject(new PromoSoftSipError(
          `PromoSoftWssClient: JsSIP UA start() threw — ${err.message}`, err
        )));
      }
    });
  }

  /* ── Unregister ───────────────────────────────────────────────────────── */

  /**
   * Send REGISTER Expires:0 and stop the JsSIP UA.
   * @returns {Promise<void>}
   */
  unregister() {
    if (!this._ua) return Promise.resolve();

    return new Promise((resolve) => {
      const ua = this._ua;
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        this._stopUa('explicit unregister()');
        resolve();
      };

      ua.once('unregistered', () => {
        logger.info('PromoSoftWssClient: SIP unregistered');
        finish();
      });

      logger.info('PromoSoftWssClient: calling ua.unregister({ all: true })');
      try { ua.unregister({ all: true }); } catch (_) {}

      // Fallback so unregister() never hangs the WS close sequence.
      setTimeout(finish, 5000);
    });
  }

  /* ── Outgoing calls ───────────────────────────────────────────────────── */

  /**
   * Place an outgoing SIP INVITE via JsSIP UA.call().
   *
   * A minimal SDP offer (G.711 audio, port 9) is generated by SipRtcStub so
   * the PBX accepts the INVITE and rings the target extension.  No real RTP
   * socket is opened on LabelGateway at this milestone.
   *
   * Resolves with { sipCallId, fromTag, toTag, status: 200 } when the call
   * is confirmed (ACK sent).  Rejects on failure or pre-answer termination.
   *
   * @param {{ fromExtension: string, targetNumber: string,
   *            onProvisional: Function, onRemoteBye: Function }} opts
   * @returns {Promise<{ sipCallId: string, fromTag: string, toTag: string, status: number }>}
   */
  invite({ fromExtension, targetNumber, onProvisional, onRemoteBye }) {
    if (!this._ua) {
      return Promise.reject(
        new PromoSoftSipError('PromoSoftWssClient: not registered — call register() first')
      );
    }

    const domain      = this._config.serverDomain;
    const destination = `sip:${targetNumber}@${domain}`;

    logger.info(
      { fromExtension, targetNumber, destination },
      'PromoSoftWssClient: → placing outgoing call via JsSIP UA.call()'
    );

    return new Promise((resolve, reject) => {
      let settled = false;
      const settle = (fn) => {
        if (settled) return;
        settled = true;
        fn();
      };

      let session;
      try {
        // mediaConstraints: { audio: false, video: false } skips getUserMedia entirely.
        // SipRtcStub's createOffer() returns a G.711 SDP that the PBX will accept.
        session = this._ua.call(destination, {
          mediaConstraints: { audio: false, video: false },
          pcConfig        : { iceServers: [] },
        });
      } catch (err) {
        reject(new PromoSoftSipError(
          `PromoSoftWssClient: ua.call() threw — ${err.message}`, err
        ));
        return;
      }

      // Index by a temporary key; real SIP Call-ID becomes available once the session
      // fires 'confirmed'.  Use session object reference for now.
      this._sessions.set(session, session);

      // ── Connecting (INVITE about to be sent) ──────────────────────────────
      session.on('connecting', ({ request }) => {
        const sipCallId = request ? request.call_id : null;
        logger.info(
          { targetNumber, destination, sipCallId },
          'PromoSoftWssClient: → INVITE connecting (SIP INVITE sending)'
        );
      });

      // ── 1xx Provisional (progress / ringing) ─────────────────────────────
      session.on('progress', ({ originator, response }) => {
        const status    = response ? response.status_code  : null;
        const reason    = response ? response.reason_phrase : null;
        const sipCallId = session._request ? session._request.call_id : null;
        logger.info(
          { targetNumber, sipCallId, status, reason, originator },
          'PromoSoftWssClient: → INVITE progress'
        );
        if (onProvisional && status) onProvisional(status, reason, null);
      });

      // ── 2xx Accepted (200 OK received, ACK being sent) ────────────────────
      session.on('accepted', ({ originator, response }) => {
        const status    = response ? response.status_code  : null;
        const reason    = response ? response.reason_phrase : null;
        const sipCallId = session._request ? session._request.call_id : null;
        logger.info(
          { targetNumber, sipCallId, status, reason, originator },
          'PromoSoftWssClient: → INVITE accepted (200 OK received, ACK pending)'
        );
      });

      // ── 2xx Confirmed (ACK sent, dialog fully established) ────────────────
      session.on('confirmed', ({ originator }) => {
        const sipCallId = session._request  ? session._request.call_id       : null;
        const fromTag   = session._from_tag || null;
        const toTag     = session._dialog   ? session._dialog.id.remote_tag  : null;

        logger.info(
          { targetNumber, sipCallId, fromTag, toTag, originator },
          'PromoSoftWssClient: → INVITE confirmed ✓ (ACK sent, call active)'
        );

        // Re-index session by SIP Call-ID for bye() lookups
        if (sipCallId) {
          this._sessions.delete(session);
          this._sessions.set(sipCallId, session);
        }

        settle(() => resolve({ sipCallId, fromTag, toTag, status: 200 }));
      });

      // ── Session ended (local or remote BYE after answer) ──────────────────
      session.on('ended', ({ originator, message, cause }) => {
        const sipCallId  = session._request ? session._request.call_id   : null;
        const statusCode = message ? message.status_code   : null;
        const statusText = message ? message.reason_phrase : null;
        logger.info(
          { targetNumber, sipCallId, originator, cause, statusCode, statusText },
          'PromoSoftWssClient: session ended'
        );

        this._sessions.delete(session);
        if (sipCallId) this._sessions.delete(sipCallId);

        if (originator === 'remote' && onRemoteBye) {
          onRemoteBye({ sipCallId });
        }
        // If the call never reached confirmed, reject the invite() promise.
        settle(() => reject(
          new PromoSoftSipError(`Call ended before answer: ${cause}`)
        ));
      });

      // ── Session failed (non-2xx final response or timeout) ────────────────
      session.on('failed', ({ originator, message, cause }) => {
        const sipCallId  = session._request ? session._request.call_id   : null;
        const statusCode = message ? message.status_code   : null;
        const statusText = message ? message.reason_phrase : null;
        logger.warn(
          { targetNumber, sipCallId, originator, cause, statusCode, statusText },
          'PromoSoftWssClient: INVITE failed'
        );

        this._sessions.delete(session);
        if (sipCallId) this._sessions.delete(sipCallId);

        settle(() => reject(
          new PromoSoftSipError(`Call failed: cause=${cause}${statusCode ? ` status=${statusCode}` : ''}${statusText ? ` (${statusText})` : ''}`, null, statusCode)
        ));
      });
    });
  }

  /**
   * Terminate an established call by sending SIP BYE.
   *
   * Looks up the session by sipCallId.  If not found, logs a warning and
   * resolves immediately so the adapter's hangup sequence always completes.
   *
   * @param {{ sipCallId: string }} opts
   * @returns {Promise<void>}
   */
  bye({ fromExtension, targetNumber, sipCallId }) {
    logger.info(
      { fromExtension, targetNumber, sipCallId },
      'PromoSoftWssClient: bye — sending BYE via session.terminate()'
    );

    const session = this._sessions.get(sipCallId);
    if (!session) {
      logger.warn(
        { sipCallId },
        'PromoSoftWssClient: bye — no active session found for sipCallId (already ended?)'
      );
      return Promise.resolve();
    }

    this._sessions.delete(sipCallId);
    try {
      session.terminate();
    } catch (err) {
      logger.warn(
        { err: err.message, sipCallId },
        'PromoSoftWssClient: session.terminate() error (ignored)'
      );
    }

    return Promise.resolve();
  }

  /* ── Lifecycle ────────────────────────────────────────────────────────── */

  destroy() {
    this._stopUa('destroy() called');
  }

  /* ── Incoming call stubs (milestone 3) ───────────────────────────────── */

  rejectIncoming() {
    // Incoming calls are auto-rejected in the newRTCSession handler above.
    // This stub exists so hangup/reject in the adapter don't throw.
    return Promise.resolve();
  }

  answerIncoming() {
    return Promise.reject(new Error('PromoSoftWssClient: answerIncoming not yet implemented (milestone 3)'));
  }

  /* ── Private ──────────────────────────────────────────────────────────── */

  /**
   * Start sending double-CRLF keepalive pings every KEEPALIVE_INTERVAL_MS.
   * Prevents the Asterisk WS server from closing idle connections.
   */
  _startKeepAlive(socket, extension, wsUrl) {
    this._stopKeepAlive();
    this._keepAliveTimer = setInterval(() => {
      if (socket.isConnected()) {
        try {
          socket.send('\r\n\r\n');
          logger.debug({ extension }, 'PromoSoftWssClient: sent CRLF keepalive ping');
        } catch (err) {
          logger.warn(
            { extension, wsUrl, err: err.message },
            'PromoSoftWssClient: keepalive send failed'
          );
        }
      }
    }, KEEPALIVE_INTERVAL_MS);
  }

  _stopKeepAlive() {
    if (this._keepAliveTimer) {
      clearInterval(this._keepAliveTimer);
      this._keepAliveTimer = null;
    }
  }

  /**
   * The ONLY place ua.stop() is called.  Logs the reason and a full stack trace
   * so any unexpected call path is immediately visible in the logs.
   * @param {string} [reason]
   */
  _stopUa(reason = 'unknown') {
    if (!this._ua) return;
    const ua     = this._ua;
    this._ua     = null;
    this._socket = null;
    this._stopKeepAlive();

    // Terminate any active calls so BYE is sent before the transport closes.
    for (const session of this._sessions.values()) {
      try { session.terminate(); } catch (_) {}
    }
    this._sessions.clear();

    const stack = new Error(`_stopUa called (reason: ${reason})`).stack;
    logger.warn({ reason, stack }, 'PromoSoftWssClient: calling ua.stop()');

    try { ua.stop(); } catch (_) {}
  }
}

module.exports = PromoSoftWssClient;
