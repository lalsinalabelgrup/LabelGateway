/**
 * PromoSoftEventNormalizer
 *
 * Converts raw SIP stack events into the normalised LabelGateway event schema:
 *   { event, callId, timestamp, payload }
 *
 * All SIP_EVENT_MAP entries are TODO placeholders.
 * Actual event names depend on the SIP library chosen during integration
 * (sip.js uses SessionState / RegistererState enums; node-sip uses string names).
 *
 * callId lifecycle:
 *   - CALL_CREATE_EVENTS: mint a new `call-<ts>` callId and map sipCallId → callId.
 *   - CALL_END_EVENTS:    remove the mapping after the event is emitted.
 *   - All other call events: look up the existing callId from the map.
 */

// Maps SIP library event/state names → normalised LabelGateway event names.
// TODO: populate with actual sip.js SessionState / RegistererState values.
const SIP_EVENT_MAP = {
  // 'Progress':      'ringing',
  // 'Accepted':      'answered',
  // 'Terminated':    'ended',
  // 'Held':          'held',
  // 'Unhold':        'resumed',
  // 'Established':   'answered',
  // 'incomingCall':  'incomingCall',
};

// Events that create a new call — mint a fresh callId on arrival.
const CALL_CREATE_EVENTS = ['incomingCall', 'outgoingCall'];

// Events that terminate a call — remove sipCallId from callMap after emitting.
const CALL_END_EVENTS = ['ended'];

class PromoSoftEventNormalizer {
  constructor() {
    this._callMap = new Map(); // sipCallId (string) → LabelGateway callId (string)
  }

  /**
   * Normalise a raw SIP event object.
   *
   * @param {{ type: string, sipCallId?: string, data?: object }} raw
   * @returns {{ event: string, callId: string|null, timestamp: string, payload: object }|null}
   *   Returns null if the event type is not in SIP_EVENT_MAP.
   */
  normalize(raw) {
    const event = SIP_EVENT_MAP[raw.type];
    if (!event) return null;

    const sipCallId = raw.sipCallId || null;
    let callId = null;

    if (sipCallId) {
      if (CALL_CREATE_EVENTS.includes(event)) {
        callId = `call-${Date.now()}`;
        this._callMap.set(sipCallId, callId);
      } else {
        callId = this._callMap.get(sipCallId) || null;
      }

      if (CALL_END_EVENTS.includes(event)) {
        this._callMap.delete(sipCallId);
      }
    }

    const payload = {
      ...(raw.data || {}),
      provider: {
        name:      'promosoft',
        sipCallId: sipCallId || undefined,
        raw,
      },
    };

    return {
      event,
      callId,
      timestamp: new Date().toISOString(),
      payload,
    };
  }
}

module.exports = PromoSoftEventNormalizer;
