/**
 * B2ComEventNormalizer
 *
 * Maps raw B2Com WebSocket messages to the normalized LabelGateway event format:
 *
 *   { event, callId, timestamp, payload }
 *
 * callId ownership:
 *   LabelGateway generates an internal callId (e.g. "call-1234") when a new call
 *   arrives. The B2Com provider call identifier is kept inside payload.provider
 *   and is never exposed directly to LabelPhone as the main callId.
 *
 * NOTE: B2Com event names, message envelope schema, and payload field names are
 *       all PENDING API documentation. Update EVENT_MAP and _buildPayload once
 *       the B2Com API reference is available.
 */

const logger = require('../../utils/logger');

/* ── B2Com raw event → normalized event name ─────────────────────────────── */
// TODO: replace placeholder keys with real B2Com event type strings.
//       The right-hand values (normalized names) must not be changed —
//       they are the contract with telephonyGatewayClient.js / LabelPhone.

const EVENT_MAP = {
  // Registration
  // 'b2com.registered':           'registered',
  // 'b2com.unregistered':         'unregistered',
  // 'b2com.registration.failed':  'registrationFailed',

  // Presence
  // 'b2com.presence.changed':     'presenceChanged',

  // Call lifecycle
  // 'b2com.call.incoming':        'incomingCall',
  // 'b2com.call.outgoing':        'outgoingCall',
  // 'b2com.call.ringing':         'ringing',
  // 'b2com.call.answered':        'answered',
  // 'b2com.call.held':            'held',
  // 'b2com.call.resumed':         'resumed',
  // 'b2com.call.muted':           'muted',
  // 'b2com.call.unmuted':         'unmuted',
  // 'b2com.call.transferred':     'transferred',
  // 'b2com.call.ended':           'ended',

  // DTMF
  // 'b2com.call.dtmf':            'dtmf',

  // Errors
  // 'b2com.error':                'error',
};

/* ── Event names that create a new call (get a fresh internal callId) ─────── */
const CALL_CREATE_EVENTS = new Set(['incomingCall', 'outgoingCall']);

/* ── Event names that end a call (callId is removed from the map) ─────────── */
const CALL_END_EVENTS    = new Set(['ended', 'transferred']);

class B2ComEventNormalizer {
  constructor() {
    /* providerCallId → internal callId */
    this._callMap = new Map();
  }

  /**
   * Translate one raw B2Com frame into a normalized LabelGateway event.
   * Returns null if the frame is unknown or should be silently ignored.
   *
   * @param {object} raw  Parsed WS frame from B2Com
   * @returns {{ event: string, callId: string|null, timestamp: string, payload: object }|null}
   */
  normalize(raw) {
    // TODO: adapt selector to actual B2Com message envelope
    // Current assumption: raw.type (or raw.event) holds the event name.
    const rawType = raw.type || raw.event || null;
    if (!rawType) {
      logger.debug({ raw }, 'B2ComEventNormalizer: frame has no type/event — ignored');
      return null;
    }

    const normalized = EVENT_MAP[rawType];
    if (!normalized) {
      logger.debug({ rawType }, 'B2ComEventNormalizer: unmapped event — ignored');
      return null;
    }

    // TODO: adapt selector to actual B2Com payload envelope
    const rawPayload = raw.data || raw.payload || {};

    const providerCallId = this._extractProviderCallId(rawPayload);
    const callId         = this._resolveCallId(normalized, providerCallId);
    const payload        = this._buildPayload(normalized, rawPayload, providerCallId);

    return {
      event:     normalized,
      callId:    callId || null,
      timestamp: new Date().toISOString(),
      payload,
    };
  }

  /* ── Private helpers ────────────────────────────────────────────────────── */

  _extractProviderCallId(rawPayload) {
    // TODO: confirm field name in B2Com API docs
    return rawPayload.callId || rawPayload.call_id || rawPayload.id || null;
  }

  _resolveCallId(normalizedEvent, providerCallId) {
    if (!providerCallId) return null;

    if (CALL_CREATE_EVENTS.has(normalizedEvent)) {
      const callId = `call-${Date.now()}`;
      this._callMap.set(providerCallId, callId);
      return callId;
    }

    if (CALL_END_EVENTS.has(normalizedEvent)) {
      const callId = this._callMap.get(providerCallId) || null;
      this._callMap.delete(providerCallId);
      return callId;
    }

    return this._callMap.get(providerCallId) || null;
  }

  /**
   * Build normalized payload for each event type.
   * Provider-specific metadata is always kept under payload.provider so
   * LabelPhone never has to deal with B2Com internals.
   *
   * TODO: map specific rawPayload fields once B2Com API docs confirm field names.
   */
  _buildPayload(normalizedEvent, rawPayload, providerCallId) {
    const providerMeta = {
      provider: {
        name:           'b2com',
        providerCallId: providerCallId || null,
        raw:            rawPayload,       // retain full raw payload during dev/debug
      },
    };

    switch (normalizedEvent) {
      case 'incomingCall':
        return {
          ...providerMeta,
          // TODO: confirm B2Com field names for caller number and display name
          number:  rawPayload.from   || rawPayload.callerNumber || rawPayload.number || null,
          contact: null,               // TODO: resolve from contact list if available
        };

      case 'outgoingCall':
        return {
          ...providerMeta,
          // TODO: confirm B2Com field name for the dialled number
          number:  rawPayload.to     || rawPayload.number || null,
          contact: null,
        };

      case 'ringing':
        return providerMeta;

      case 'answered':
        return {
          ...providerMeta,
          startTime: rawPayload.startTime || rawPayload.answeredAt || Date.now(),
          number:    rawPayload.number    || null,
          contact:   null,
        };

      case 'held':
      case 'resumed':
      case 'muted':
      case 'unmuted':
        return providerMeta;

      case 'ended':
      case 'transferred':
        return {
          ...providerMeta,
          direction: rawPayload.direction || null,
          // TODO: confirm B2Com field name for call duration
          duration:  rawPayload.duration  || rawPayload.durationSeconds || 0,
          reason:    rawPayload.reason    || rawPayload.causeCode || 'normal',
          number:    rawPayload.number    || null,
          contact:   null,
        };

      case 'dtmf':
        return {
          ...providerMeta,
          // TODO: confirm B2Com field name for DTMF digit
          digit: rawPayload.digit || rawPayload.key || null,
        };

      case 'registered':
        return { extension: rawPayload.extension || rawPayload.number || null };

      case 'registrationFailed':
        return {
          ...providerMeta,
          reason: rawPayload.reason || rawPayload.message || 'Registration failed',
        };

      case 'presenceChanged':
        return {
          ...providerMeta,
          // TODO: map to normalized presence states once B2Com states are known
          status: rawPayload.status || rawPayload.presence || null,
        };

      case 'error':
        return {
          code:    rawPayload.code    || 'B2COM_ERROR',
          message: rawPayload.message || 'Unknown B2Com error',
          ...providerMeta,
        };

      default:
        return { ...providerMeta, ...rawPayload };
    }
  }
}

module.exports = B2ComEventNormalizer;
