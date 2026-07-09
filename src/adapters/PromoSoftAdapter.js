/**
 * PromoSoftAdapter
 *
 * LabelGateway adapter for PromoSoft / GUC Contact Center.
 * Target: prelabel2.guccontactcenter.com · SIP/UDP · port 5060.
 *
 * SECURITY CONSTRAINTS (hard rules, never relax):
 *   - Extension and password come ONLY from the `login` WS command params.
 *   - Passwords are NEVER read from .env, stored in config, or written to logs.
 *   - Only extension (not password) appears in INFO-level log entries.
 *
 * Login flow:
 *   1. LabelPhone opens WS connection → wsServer calls adapter.connect().
 *      If PROMOSOFT_SIP_SERVER is not set → emit registrationFailed immediately.
 *      If set → stay silent, wait for the `login` command.
 *   2. LabelPhone sends: { command: 'login', params: { extension, password } }
 *      adapter.login() kicks off SIP REGISTER in the background and returns
 *      immediately so the WS command reply is always { ok: true }.
 *      The actual outcome arrives as a push event: `registered` or `registrationFailed`.
 */

const BaseTelephonyAdapter = require("./BaseTelephonyAdapter");
const PromoSoftConfig = require("./promosoft/PromoSoftConfig");
const PromoSoftSipClient = require("./promosoft/PromoSoftSipClient");
const PromoSoftWssClient = require("./promosoft/PromoSoftWssClient");
const PromoSoftEventNormalizer = require("./promosoft/PromoSoftEventNormalizer");
const {
  AdapterNotReadyError,
  PromoSoftLoginError,
} = require("./promosoft/PromoSoftErrors");
const logger = require("../utils/logger");

class PromoSoftAdapter extends BaseTelephonyAdapter {
  constructor(sendEvent) {
    super(sendEvent);
    this._config = new PromoSoftConfig();
    this._normalizer = new PromoSoftEventNormalizer();

    if (this._config.mode === 'wss') {
      this._sipClient = new PromoSoftWssClient(this._config);
      logger.info({ wsUrl: this._config.wsUrl }, 'PromoSoftAdapter: mode=wss — using JsSIP/WebSocket');
    } else {
      this._sipClient = new PromoSoftSipClient(this._config);
      logger.info({ server: this._config.sipServer }, 'PromoSoftAdapter: mode=udp — using manual SIP/UDP');
    }

    this._session = null; // { extension, displayName } — password NOT stored here
    this._call = null; // { callId, sipCallId, fromTag, toTag, number, status, direction }
    this._sipClient.setIncomingCallHandler(this._onIncomingCallFromSip.bind(this));
  }

  /* ── Lifecycle ──────────────────────────────────────────────────────────── */

  /**
   * Called when a LabelPhone client opens a WS connection.
   * If PROMOSOFT_SIP_SERVER is not configured → emit registrationFailed.
   * If configured → stay silent and wait for the `login` command with credentials.
   */
  connect() {
    if (!this._config.isServerConfigured()) {
      const missingVar = this._config.mode === 'wss'
        ? 'PROMOSOFT_WS_URL'
        : 'PROMOSOFT_SIP_SERVER';
      const reason = `PromoSoft server not configured. Set ${missingVar} in .env`;
      logger.warn(`PromoSoftAdapter: ${reason}`);
      setImmediate(() =>
        this._sendEvent("registrationFailed", { provider: "promosoft", reason }),
      );
    }
    return Promise.resolve({});
  }

  /**
   * Start SIP registration using credentials from the `login` WS command.
   *
   * Returns immediately (fire-and-forget). The outcome arrives as a push event:
   *   registered { extension }          — on SIP 200 OK
   *   registrationFailed { reason }     — on SIP error / config problem
   *
   * Passwords are NEVER logged.
   *
   * @param {{ extension: string, password: string, displayName?: string }} credentials
   */
  login({ extension, password, displayName } = {}) {
    if (!extension || !password) {
      const reason = "extension and password are required for PromoSoft login";
      this._sendEvent("registrationFailed", { provider: "promosoft", reason });
      return Promise.reject(new PromoSoftLoginError(reason));
    }

    try {
      this._config.requireServerConfigured();
    } catch (err) {
      this._sendEvent("registrationFailed", {
        provider: "promosoft",
        reason: err.message,
      });
      return Promise.reject(err);
    }

    this._session = { extension, displayName: displayName || extension };
    // Log extension only — password must never appear in any log entry
    logger.info(
      { extension },
      "PromoSoftAdapter: login - starting SIP REGISTER (password redacted)",
    );

    // Fire-and-forget: SIP REGISTER runs in the background.
    // The command reply is { ok: true }; the actual result arrives as a push event.
    this._sipClient
      .register({ extension, password })
      .then(({ expiresIn } = {}) => {
        logger.info({ extension }, "PromoSoftAdapter: registered");
        const registeredAt = new Date().toISOString();
        const expiresAt = expiresIn
          ? new Date(Date.now() + expiresIn * 1000).toISOString()
          : null;
        logger.info(
          {
            extension,
            event: "registered",
            adapterHasActiveCall: !!this._call,
            adapterCallStatus: this._call?.status || null,
            activeCalls: this._sipClient._calls?.size || 0,
            activeRtpSessions: this._sipClient._rtpSessions?.size || 0,
            suppressedCallEvents: ["incomingCall", "outgoingCall", "ringing", "answered"],
          },
          "PromoSoftAdapter: emitting registered only after REGISTER",
        );
        this._sendEvent("registered", {
          provider: "promosoft",
          extension,
          registrar: this._config.sipServer,
          transport: this._config.sipTransport,
          registeredAt,
          ...(expiresIn != null ? { expiresIn, expiresAt } : {}),
        });
      })
      .catch((err) => {
        logger.error(
          { extension, err: err.message },
          "PromoSoftAdapter: SIP registration failed",
        );
        this._session = null;
        this._sendEvent("registrationFailed", {
          provider: "promosoft",
          reason: err.message,
          extension,
          statusCode: err.statusCode || null,
        });
      });

    return Promise.resolve({});
  }

  /**
   * Unregister from the SIP server (REGISTER with Expires: 0) and clear session.
   */
  logout() {
    const ext = this._session && this._session.extension;
    if (ext) logger.info({ extension: ext }, "PromoSoftAdapter: logout");
    this._session = null;

    return this._sipClient
      .unregister()
      .then(() => {
        const unregisteredAt = new Date().toISOString();
        this._sendEvent("unregistered", {
          provider: "promosoft",
          unregisteredAt,
          ...(ext ? { extension: ext } : {}),
        });
        return {};
      })
      .catch((err) => {
        logger.warn(
          { err: err.message },
          "PromoSoftAdapter: unregister error (ignored)",
        );
        const unregisteredAt = new Date().toISOString();
        this._sendEvent("unregistered", {
          provider: "promosoft",
          unregisteredAt,
          ...(ext ? { extension: ext } : {}),
        });
        return {};
      });
  }

  /** Disconnect is treated as logout for PromoSoft. */
  disconnect() {
    return this.logout();
  }

  /* ── Call guard ─────────────────────────────────────────────────────────── */

  _requireSession() {
    if (!this._session) {
      throw new AdapterNotReadyError(
        "PromoSoft: not logged in — send the login command first",
      );
    }
  }

  _stub(methodName) {
    try {
      this._requireSession();
    } catch (err) {
      return Promise.reject(err);
    }
    return Promise.reject(
      new AdapterNotReadyError(
        `PromoSoft: ${methodName}() not yet implemented — pending SIP INVITE integration`,
      ),
    );
  }

  /* ── Incoming call notification (from SIP client) ──────────────────────── */

  /**
   * Called by PromoSoftSipClient when an incoming INVITE is received.
   *
   * If `cancelled: true` the call was cancelled before we answered (CANCEL or
   * pre-answer BYE) — clear local state and emit `missed`.
   *
   * @param {{ callId, sipCallId, from, to, cancelled? }} info
   */
  _onIncomingCallFromSip({ callId, sipCallId, from, to, cancelled = false }) {
    if (cancelled) {
      // Caller hung up before we answered
      if (this._call && this._call.callId === callId) {
        const num = this._call.number;
        this._call = null;
        logger.info(
          { callId, sipCallId, from: num },
          "PromoSoftAdapter: incoming call cancelled before answer",
        );
        this._sendEvent("missed", { callId, sipCallId, from: num, to, direction: "inbound" });
      }
      return;
    }

    if (this._call) {
      logger.warn(
        { sipCallId, from, to },
        "PromoSoftAdapter: incoming INVITE ignored — call already in progress",
      );
      return;
    }

    this._call = {
      callId,
      sipCallId,
      fromTag:   null,
      toTag:     null,
      number:    from,
      status:    "ringing",
      direction: "inbound",
    };

    logger.info(
      { callId, sipCallId, from, to },
      "PromoSoftAdapter: ← incoming call — emitting incomingCall",
    );
    this._sendEvent("incomingCall", {
      callId,
      sipCallId,
      from,
      to,
      direction: "inbound",
    });
  }

  /* ── Call methods ───────────────────────────────────────────────────────── */

  /**
   * Place an outgoing call via SIP INVITE.
   *
   * Emits outgoingCall immediately on initiation, then pushes ringing / answered /
   * ended as SIP provisional and final responses arrive.
   * Mirrors the JsSIP event sequence: newRTCSession → progress → accepted →
   * confirmed → ended / failed.
   *
   * @returns {Promise<{ callId }>}
   */
  call(number, _contact) {
    try {
      this._requireSession();
    } catch (err) {
      return Promise.reject(err);
    }
    if (this._call) {
      return Promise.reject(
        new AdapterNotReadyError("PromoSoft: call already in progress"),
      );
    }

    const { extension } = this._session;
    const callId = `call-${Date.now()}`;

    // Equivalent of JsSIP "newRTCSession" — log initiation immediately
    logger.info(
      { extension, number, callId },
      "PromoSoftAdapter: call - SIP INVITE initiated (newRTCSession)",
    );

    this._call = {
      callId,
      sipCallId: null,
      fromTag: null,
      toTag: null,
      number,
      status: "calling",
      direction: "outbound",
    };

    // Emit outgoingCall immediately — do NOT gate on receiving 100 Trying
    this._sendEvent("outgoingCall", { callId, number, extension });

    const onProvisional = (status, reason, _headers) => {
      if (!this._call || this._call.callId !== callId) return;
      const sipCallId = this._call.sipCallId; // may still be null if we get 100 before resolve

      if (status === 100) {
        // 100 Trying — server received the INVITE; outgoingCall already emitted above
        logger.info(
          { extension, number, callId, sipCallId, status, reason },
          "PromoSoftAdapter: 100 Trying",
        );
      } else if (status === 180 || status === 183) {
        // 180 Ringing / 183 Session Progress — equivalent of JsSIP "progress"
        logger.info(
          { extension, number, callId, sipCallId, status, reason },
          "PromoSoftAdapter: progress (ringing)",
        );
        if (this._call.status !== "ringing") {
          this._call.status = "ringing";
          this._sendEvent("ringing", { callId, number, status });
        }
      } else {
        logger.info(
          { extension, number, callId, sipCallId, status, reason },
          "PromoSoftAdapter: ← INVITE provisional",
        );
      }
    };

    // Called synchronously by the SIP client as soon as the INVITE transaction
    // exists (before any response) — makes sipCallId available to hangup()
    // while the call is still ringing, so it can send CANCEL.
    const onInviteCreated = ({ sipCallId: sid }) => {
      if (!this._call || this._call.callId !== callId) return;
      this._call.sipCallId = sid;
      logger.info(
        { extension, number, callId, sipCallId: sid },
        "PromoSoftAdapter: outbound INVITE transaction created",
      );
    };

    // Called by the SIP client when the remote endpoint sends BYE (remote hangup).
    const onRemoteBye = ({ sipCallId: sid }) => {
      if (!this._call || this._call.callId !== callId) return;
      const { number: num } = this._call;
      const activeSipCallId = this._call.sipCallId || sid;
      this._call = null;

      logger.info(
        { extension, number: num, callId, sipCallId: activeSipCallId },
        "PromoSoftAdapter: ← remote BYE — call ended by remote",
      );
      logger.info(
        { callId, number: num, sipCallId: activeSipCallId },
        "PromoSoftAdapter: WS broadcast ended",
      );
      this._sendEvent("ended", {
        callId,
        number: num,
        sipCallId: activeSipCallId,
        reason: "remote_bye",
        endedBy: "remote",
      });
      logger.info(
        { callId, number: num, sipCallId: activeSipCallId },
        "PromoSoftAdapter: WS broadcast ended sent",
      );
    };

    // Fire-and-forget: INVITE runs in background; push events carry final state.
    this._sipClient
      .invite({
        fromExtension: extension,
        targetNumber: number,
        onProvisional,
        onRemoteBye,
        onInviteCreated,
      })
      .then(({ sipCallId: sid, fromTag, toTag, status, cseq }) => {
        if (!this._call || this._call.callId !== callId) return;
        this._call.sipCallId = sid;
        this._call.fromTag = fromTag;
        this._call.toTag = toTag;
        this._call.status = "answered";
        // Last INVITE-transaction CSeq (bumped by +1 if a digest auth retry
        // happened) — hangup() needs this to send BYE with a CSeq that is
        // strictly greater than the dialog's last request, or the PBX
        // silently ignores it as a stale/duplicate transaction.
        this._call.cseq = cseq || 1;
        // Equivalent of JsSIP "accepted" + "confirmed" (ACK already sent by sipClient)
        logger.info(
          { extension, number, callId, sipCallId: sid, fromTag, toTag, status, cseq: this._call.cseq },
          "PromoSoftAdapter: INVITE accepted - answered (confirmed)",
        );
        this._sendEvent("answered", {
          callId,
          number,
          sipCallId: sid,
          startTime: Date.now(),
        });
      })
      .catch((err) => {
        if (!this._call || this._call.callId !== callId) return;
        this._call = null;
        // Equivalent of JsSIP "failed" or "ended"
        logger.warn(
          {
            extension,
            number,
            callId,
            reason: err.message,
            statusCode: err.statusCode || null,
          },
          "PromoSoftAdapter: INVITE failed (failed)",
        );
        this._sendEvent("ended", {
          callId,
          number,
          reason: err.message,
          statusCode: err.statusCode || null,
        });
      });

    return Promise.resolve({ callId });
  }

  /**
   * Hang up the active call.
   *
   * - Answered call (inbound or outbound): sends SIP BYE.
   * - Ringing inbound call: sends 486 Busy Here.
   * - Ringing/calling outbound call (not yet answered): sends SIP CANCEL.
   */
  hangup() {
    logger.info({}, "PromoSoftAdapter: hangup command received");
    try {
      this._requireSession();
    } catch (err) {
      return Promise.reject(err);
    }
    if (!this._call) {
      logger.warn({}, "PromoSoftAdapter: hangup - no active call found");
      return Promise.resolve({});
    }

    const { callId, sipCallId, fromTag, toTag, number, status, direction, cseq } = this._call;
    const { extension } = this._session;

    logger.info(
      { extension, number, status, direction, callId, sipCallId, cseq },
      "PromoSoftAdapter: hangup - active call found",
    );
    this._call = null;
    logger.info({ callId, sipCallId }, "PromoSoftAdapter: local call state cleared");
    this._sendEvent("ended", { callId, sipCallId, number, reason: "local_hangup", endedBy: "local" });

    logger.info(
      { extension, number, status, direction, sipCallId },
      "PromoSoftAdapter: hangup - deciding CANCEL vs BYE",
    );

    if (status === "answered" && sipCallId) {
      // For inbound calls we are the UAS — our first in-dialog request, so CSeq: 1.
      // For outbound calls, BYE must use a CSeq strictly greater than the one the
      // INVITE transaction ended up using (it's bumped +1 if a digest auth retry
      // happened) — otherwise the PBX treats BYE as a stale/duplicate transaction
      // and silently drops it, leaving the call up despite our local state clearing.
      const byeCseq = direction === "inbound" ? 1 : (cseq || 1) + 1;
      logger.info(
        { extension, number, sipCallId, direction, byeCseq },
        "PromoSoftAdapter: sending SIP BYE for active dialog",
      );
      this._sipClient
        .bye({ fromExtension: extension, targetNumber: number, sipCallId, fromTag, toTag, cseq: byeCseq })
        .then(() =>
          logger.info({ sipCallId }, "PromoSoftAdapter: BYE transaction completed"),
        )
        .catch((err) =>
          logger.warn({ sipCallId, err: err.message }, "PromoSoftAdapter: BYE error (ignored)"),
        );
    } else if (status === "ringing" && direction === "inbound") {
      // User pressed hangup while an inbound call was ringing — decline it
      this._sipClient
        .rejectIncoming({ sipCallId, statusCode: 486 })
        .catch((err) =>
          logger.warn({ err: err.message }, "PromoSoftAdapter: decline (hangup) error (ignored)"),
        );
    } else if ((status === "calling" || status === "ringing") && direction === "outbound" && sipCallId) {
      // User pressed hangup before the outbound call was answered — the
      // INVITE transaction is still pending, so CANCEL it (RFC 3261 §9.1),
      // not BYE.
      logger.info(
        { extension, number, sipCallId, status },
        "PromoSoftAdapter: hangup before answer (outbound) - sending SIP CANCEL",
      );
      this._sipClient
        .cancel({ sipCallId })
        .then(() =>
          logger.info({ sipCallId }, "PromoSoftAdapter: CANCEL transaction completed"),
        )
        .catch((err) =>
          logger.warn({ sipCallId, err: err.message }, "PromoSoftAdapter: CANCEL error (ignored)"),
        );
    } else {
      logger.info(
        { extension, number, status, direction, sipCallId },
        "PromoSoftAdapter: hangup - no SIP action needed for this call state",
      );
    }

    return Promise.resolve({});
  }

  /**
   * Answer a ringing inbound call.
   * Sends SIP 200 OK with SDP and emits "answered" to LabelPhone.
   */
  answer() {
    try {
      this._requireSession();
    } catch (err) {
      return Promise.reject(err);
    }
    if (!this._call || this._call.direction !== "inbound") {
      return Promise.reject(
        new AdapterNotReadyError("PromoSoft: no incoming call to answer"),
      );
    }
    if (this._call.status !== "ringing") {
      return Promise.reject(
        new AdapterNotReadyError("PromoSoft: incoming call is not in ringing state"),
      );
    }

    const { callId, sipCallId, number: callerNumber } = this._call;
    const { extension } = this._session;

    logger.info({ callId, sipCallId, from: callerNumber, to: extension }, "PromoSoftAdapter: answer");

    const onRemoteBye = ({ sipCallId: sid }) => {
      if (!this._call || this._call.callId !== callId) return;
      const { number: num } = this._call;
      this._call = null;
      logger.info(
        { callId, sipCallId: sid, from: num },
        "PromoSoftAdapter: ← remote BYE (inbound call ended by remote)",
      );
      logger.info({ callId, sipCallId: sid }, "PromoSoftAdapter: WS broadcast ended");
      this._sendEvent("ended", {
        callId,
        sipCallId:  sid,
        number:     num,
        reason:     "remote_bye",
        endedBy:    "remote",
        direction:  "inbound",
      });
      logger.info({ callId, sipCallId: sid }, "PromoSoftAdapter: WS broadcast ended sent");
    };

    return this._sipClient
      .answerIncoming({ sipCallId, onRemoteBye })
      .then(({ localTag, callerTag, callerNumber: num }) => {
        if (!this._call || this._call.callId !== callId) return {};
        this._call.fromTag = localTag;
        this._call.toTag   = callerTag;
        this._call.status  = "answered";
        logger.info(
          { callId, sipCallId, from: num, to: extension },
          "PromoSoftAdapter: answered (inbound) — 200 OK sent",
        );
        this._sendEvent("answered", {
          callId,
          sipCallId,
          number:    num,
          direction: "inbound",
          startTime: Date.now(),
        });
        return { callId };
      });
  }

  /**
   * Reject a ringing inbound call with 486 Busy Here.
   * Emits "ended" to LabelPhone immediately so it returns to idle.
   */
  reject() {
    try {
      this._requireSession();
    } catch (err) {
      return Promise.reject(err);
    }
    if (!this._call || this._call.direction !== "inbound") {
      return Promise.reject(
        new AdapterNotReadyError("PromoSoft: no incoming call to reject"),
      );
    }

    const { callId, sipCallId, number: callerNumber } = this._call;
    this._call = null;

    logger.info({ callId, sipCallId, from: callerNumber }, "PromoSoftAdapter: reject");
    this._sendEvent("ended", {
      callId,
      sipCallId,
      number:  callerNumber,
      reason:  "rejected",
      endedBy: "local",
    });

    return this._sipClient
      .rejectIncoming({ sipCallId, statusCode: 486 })
      .catch((err) => {
        logger.warn({ err: err.message, sipCallId }, "PromoSoftAdapter: reject SIP response failed (ignored)");
      });
  }
  hold() {
    return this._stub("hold");
  }
  resume() {
    return this._stub("resume");
  }
  mute() {
    return this._stub("mute");
  }
  unmute() {
    return this._stub("unmute");
  }
  setSpeaker(_enabled) {
    return this._stub("setSpeaker");
  }
  transfer(target) {
    return this._stub("transfer");
  }
  sendDTMF(digit) {
    return this._stub("sendDTMF");
  }

  /* ── Data (empty stubs — no PromoSoft contacts/history API defined yet) ──── */

  getContacts() {
    return Promise.resolve({ contacts: [] });
  }
  getHistory() {
    return Promise.resolve({ history: [] });
  }
  addHistoryEntry(_entry) {
    return Promise.resolve({});
  }

  /* ── Cleanup ────────────────────────────────────────────────────────────── */

  destroy() {
    this._sipClient.destroy();
    this._session = null;
  }
}

module.exports = PromoSoftAdapter;
