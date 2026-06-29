/**
 * CallStateService
 * Per-session telephony state container used by adapters.
 */
class CallStateService {
  constructor() {
    this.connection   = 'disconnected';
    this.registration = 'unregistered';
    this.call         = null;
    /*
      call shape:
        callId:    string
        direction: 'inbound' | 'outbound'
        status:    'ringing' | 'answered' | 'held'
        contact:   object | null
        number:    string
        muted:     boolean
        speaker:   boolean
        held:      boolean
        startTime: number | null
    */
  }

  setConnection(status)   { this.connection   = status; }
  setRegistration(status) { this.registration = status; }

  setCall(call)     { this.call = call ? { ...call } : null; }
  updateCall(patch) { if (this.call) Object.assign(this.call, patch); }
  clearCall()       { this.call = null; }

  snapshot() {
    return {
      connection:   this.connection,
      registration: this.registration,
      call:         this.call ? { ...this.call } : null,
    };
  }
}

module.exports = CallStateService;
