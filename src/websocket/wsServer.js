/**
 * wsServer.js
 *
 * WebSocket server for LabelGateway.
 *
 * Protocol (mirrors telephonyGatewayClient.js Real implementation):
 *
 *   Client → Server  command envelope:
 *     { "id": "<uid>", "command": "<name>", "callId"?: "<cid>", "params"?: { … } }
 *     callId is present for all commands that target an existing call.
 *
 *   Server → Client  command reply:
 *     { "id": "<uid>", "result": { … } }
 *     { "id": "<uid>", "error": "<message>" }
 *
 *   Server → Client  push event:
 *     { "event": "<name>", "callId"?: "<cid>", "timestamp": "<ISO>", "payload": { … } }
 *     callId is present for all events that belong to a specific call.
 *
 * Each WebSocket connection gets its own adapter instance.
 * State is per-session and kept in memory.
 */

const { WebSocketServer } = require('ws');
const MockAdapter         = require('../adapters/MockAdapter');
const config              = require('../config/config');
const logger              = require('../utils/logger');

/* ─── Registration state (server-level, updated by event interception) ──────
   Tracks the most recent registration event so /api/status can report it.
   Password is never stored here. */
let _registrationState = {
  provider:           config.TELEPHONY_PROVIDER,
  registered:         false,
  extension:          null,
  registrar:          null,
  transport:          null,
  lastRegistrationAt: null,
  expiresIn:          null,
  expiresAt:          null,
};

function getRegistrationState() {
  return { ..._registrationState };
}

/* ─── Adapter factory ────────────────────────────────────────────────────── */

function createAdapter(sendEvent) {
  switch (config.TELEPHONY_PROVIDER) {
    case 'b2com': {
      const B2ComAdapter = require('../adapters/B2ComAdapter');
      return new B2ComAdapter(sendEvent);
    }
    case 'promosoft': {
      const PromoSoftAdapter = require('../adapters/PromoSoftAdapter');
      return new PromoSoftAdapter(sendEvent);
    }
    default:
      return new MockAdapter(sendEvent, '1001');
  }
}

/* ─── Command router ─────────────────────────────────────────────────────── */

const COMMANDS = {
  /* Connection lifecycle — "connect" may not be sent by LabelPhone in real
     mode (onopen handles it client-side), but the command is supported for
     test clients and future use. */
  connect:              (a, p) => a.connect(),
  disconnect:           (a, p) => a.disconnect(),

  /* Calls */
  call:                 (a, p) => a.call(p.number, p.contact || null),
  answer:               (a, p) => a.answer(),
  reject:               (a, p) => a.reject(),
  hangup:               (a, p) => a.hangup(),

  /* Call control */
  hold:                 (a, p) => a.hold(),
  resume:               (a, p) => a.resume(),
  mute:                 (a, p) => a.mute(),
  unmute:               (a, p) => a.unmute(),
  toggleMute:           (a, p) => a._cs.call && a._cs.call.muted ? a.unmute() : a.mute(),
  setSpeaker:           (a, p) => a.setSpeaker(p.enabled),
  toggleSpeaker:        (a, p) => a.setSpeaker(!(a._cs.call && a._cs.call.speaker)),

  /* Advanced */
  transfer:             (a, p) => a.transfer(p.target),
  sendDTMF:             (a, p) => a.sendDTMF(p.digit),
  conference:           (a, p) => a.conference(),
  startRecording:       (a, p) => a.startRecording(),
  stopRecording:        (a, p) => a.stopRecording(),

  /* Data */
  getContacts:          (a, p) => a.getContacts(),
  getHistory:           (a, p) => a.getHistory(),
  addHistoryEntry:      (a, p) => a.addHistoryEntry(p.entry),

  /* Dev / simulation */
  simulateIncomingCall: (a, p) => a.simulateIncomingCall(p.contact || null),

  /* Authentication — used by providers that receive credentials at runtime
     (e.g. PromoSoft). Extension is safe to log; password must NOT be logged
     by this router or by the adapter. The command reply is always { ok: true };
     the actual outcome (registered / registrationFailed / unregistered) arrives
     as a separate push event so LabelPhone can handle it asynchronously. */
  login:  async (a, p) => { await a.login({ extension: p.extension, password: p.password, displayName: p.displayName }); return { ok: true }; },
  logout: async (a, p) => { await a.logout(); return { ok: true }; },
};

/* ─── setupWsServer ──────────────────────────────────────────────────────── */

function setupWsServer(httpServer) {
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

  wss.on('connection', (ws, req) => {
    const ip        = req.socket.remoteAddress;
    const sessionId = `s-${Date.now()}`;
    logger.info({ sessionId, ip }, 'WS client connected');

    /* Each session gets a dedicated adapter with a direct send callback.
       Events include callId at the top level (not nested in payload)
       so clients can correlate events to calls without payload inspection. */
    const sendEvent = (event, payload, callId) => {
      // Intercept registration events to keep the server-level state current.
      if (event === 'registered') {
        _registrationState = {
          provider:           payload.provider   || config.TELEPHONY_PROVIDER,
          registered:         true,
          extension:          payload.extension  || null,
          registrar:          payload.registrar  || null,
          transport:          payload.transport  || null,
          lastRegistrationAt: payload.registeredAt || new Date().toISOString(),
          expiresIn:          payload.expiresIn  || null,
          expiresAt:          payload.expiresAt  || null,
        };
      } else if (event === 'unregistered') {
        _registrationState = {
          provider:           config.TELEPHONY_PROVIDER,
          registered:         false,
          extension:          null,
          registrar:          null,
          transport:          null,
          lastRegistrationAt: null,
          expiresIn:          null,
          expiresAt:          null,
        };
      } else if (event === 'registrationFailed') {
        _registrationState = {
          ..._registrationState,
          registered:        false,
          lastFailureReason: payload.reason     || null,
          lastFailureAt:     new Date().toISOString(),
        };
      }

      if (ws.readyState !== ws.OPEN) return;
      try {
        const msg = { event, timestamp: new Date().toISOString(), payload: payload || {} };
        if (callId != null) msg.callId = callId;
        ws.send(JSON.stringify(msg));
      } catch (err) {
        logger.error({ sessionId, err, event }, 'sendEvent failed');
      }
    };

    const adapter = createAdapter(sendEvent);

    /* MockAdapter: emit 'registered' immediately (no connect handshake needed).
       All real adapters: call connect() so each adapter can handle its own
       registration flow (B2Com → WS handshake; PromoSoft → wait for login). */
    if (config.TELEPHONY_PROVIDER === 'mock') {
      setImmediate(() => sendEvent('registered', { extension: '1001' }));
    } else {
      adapter.connect().catch(err => {
        logger.error({ err: err.message, provider: config.TELEPHONY_PROVIDER }, 'Adapter connect failed');
        sendEvent('error', { code: 'CONNECT_FAILED', message: err.message });
      });
    }

    /* ── Message handling ─────────────────────────────────────────────── */
    ws.on('message', async (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        logger.warn({ sessionId }, 'Received non-JSON message — ignored');
        return;
      }

      const { id, command, callId, params = {} } = msg;

      if (!command) {
        logger.warn({ sessionId, msg }, 'Message has no command field — ignored');
        return;
      }

      logger.debug({ sessionId, command, id, callId }, '→ command');

      const handler = COMMANDS[command];
      if (!handler) {
        const errorMsg = `Unknown command: ${command}`;
        logger.warn({ sessionId, command }, errorMsg);
        ws.send(JSON.stringify({ id, error: errorMsg }));
        return;
      }

      try {
        const result = await handler(adapter, params);
        ws.send(JSON.stringify({ id, result: result || {} }));
      } catch (err) {
        logger.warn({ sessionId, command, message: err.message }, '← command error');
        ws.send(JSON.stringify({ id, error: err.message }));
      }
    });

    /* ── Disconnection ────────────────────────────────────────────────── */
    ws.on('close', (code, reason) => {
      logger.info({ sessionId, code, reason: reason.toString() }, 'WS client disconnected');
      adapter.destroy();
    });

    ws.on('error', (err) => {
      logger.error({ sessionId, err }, 'WS socket error');
    });
  });

  wss.on('error', (err) => {
    logger.error({ err }, 'WebSocketServer error');
  });

  return wss;
}

module.exports = setupWsServer;
module.exports.getRegistrationState = getRegistrationState;
