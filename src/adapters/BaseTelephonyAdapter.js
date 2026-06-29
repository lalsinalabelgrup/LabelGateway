/**
 * BaseTelephonyAdapter
 *
 * Abstract interface that every telephony adapter must implement.
 * All methods return Promises.
 *
 * Concrete adapters receive a `sendEvent(event, payload)` callback
 * injected at construction time — used to push normalised events to
 * the connected WebSocket client.
 */
class BaseTelephonyAdapter {
  /**
   * @param {(event: string, payload: object) => void} sendEvent
   */
  constructor(sendEvent) {
    if (typeof sendEvent !== 'function') throw new Error('sendEvent must be a function');
    this._sendEvent = sendEvent;
  }

  /** Open/initialise the telephony session. */
  connect()                     { return this._notImpl('connect'); }

  /** Close the telephony session. */
  disconnect()                  { return this._notImpl('disconnect'); }

  /** Start an outbound call. */
  call(number, contact)         { return this._notImpl('call'); }

  /** Answer the ringing inbound call. */
  answer()                      { return this._notImpl('answer'); }

  /** Decline the ringing inbound call. */
  reject()                      { return this._notImpl('reject'); }

  /** End the active call. */
  hangup()                      { return this._notImpl('hangup'); }

  /** Place the active call on hold. */
  hold()                        { return this._notImpl('hold'); }

  /** Resume a held call. */
  resume()                      { return this._notImpl('resume'); }

  /** Mute the microphone. */
  mute()                        { return this._notImpl('mute'); }

  /** Unmute the microphone. */
  unmute()                      { return this._notImpl('unmute'); }

  /** Enable or disable the loudspeaker. */
  setSpeaker(enabled)           { return this._notImpl('setSpeaker'); }

  /** Blind-transfer the active call. */
  transfer(target)              { return this._notImpl('transfer'); }

  /** Send a DTMF digit. */
  sendDTMF(digit)               { return this._notImpl('sendDTMF'); }

  /** Fetch contact list. */
  getContacts()                 { return this._notImpl('getContacts'); }

  /** Fetch call history. */
  getHistory()                  { return this._notImpl('getHistory'); }

  /** Persist a history entry. */
  addHistoryEntry(entry)        { return this._notImpl('addHistoryEntry'); }

  /**
   * Authenticate and register with the telephony provider.
   * Extension and password come from the `login` WS command params.
   * Adapters that use env-based credentials (mock, b2com) may ignore this.
   */
  login(_credentials)           { return this._notImpl('login'); }

  /** Unregister from the telephony provider and clear the session. */
  logout()                      { return this._notImpl('logout'); }

  /** Trigger a simulated incoming call (dev/mock only). */
  simulateIncomingCall(contact) { return Promise.reject(new Error('simulateIncomingCall not supported')); }

  /** Release timers and resources. Called when the WS client disconnects. */
  destroy() {}

  _notImpl(name) { return Promise.reject(new Error(`${this.constructor.name}: ${name}() not implemented`)); }
}

module.exports = BaseTelephonyAdapter;
