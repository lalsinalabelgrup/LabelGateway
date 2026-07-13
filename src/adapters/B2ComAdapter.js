/**
 * B2ComAdapter
 *
 * Telephony adapter for the B2Com provider.
 * Implements the same interface as MockAdapter so wsServer.js routes all
 * commands to it without any LabelPhone changes.
 *
 * Status: SKELETON — pending B2Com API documentation and credentials.
 *         All call-control methods return AdapterNotReadyError until the
 *         integration is implemented.
 *
 * Architecture:
 *   wsServer.js
 *     ↓ (sendEvent callback injected at construction)
 *   B2ComAdapter
 *     ├── B2ComHttpClient   (REST calls → B2Com API)
 *     └── B2ComWsClient     (WS frames → B2ComEventNormalizer → sendEvent)
 *
 * Provider selection:
 *   Set TELEPHONY_PROVIDER=b2com in .env (see .env.example).
 */

const BaseTelephonyAdapter  = require('./BaseTelephonyAdapter');
const B2ComConfig           = require('./b2com/B2ComConfig');
const B2ComHttpClient       = require('./b2com/B2ComHttpClient');
const B2ComWsClient         = require('./b2com/B2ComWsClient');
const B2ComEventNormalizer  = require('./b2com/B2ComEventNormalizer');
const { AdapterNotReadyError } = require('./b2com/B2ComErrors');
const logger                = require('../utils/logger').child({ module: 'Adapter' });

class B2ComAdapter extends BaseTelephonyAdapter {
  /**
   * @param {(event: string, payload: object, callId?: string|null) => void} sendEvent
   */
  constructor(sendEvent) {
    super(sendEvent);

    this._config     = new B2ComConfig();
    this._normalizer = new B2ComEventNormalizer();
    this._http       = new B2ComHttpClient(this._config);
    this._ws         = new B2ComWsClient(this._config, (raw) => this._onProviderEvent(raw));
  }

  /* ── Provider event forwarding ──────────────────────────────────────────── */

  _onProviderEvent(raw) {
    const evt = this._normalizer.normalize(raw);
    if (!evt) return;
    logger.debug({ event: evt.event, callId: evt.callId }, 'B2ComAdapter → event');
    this._sendEvent(evt.event, evt.payload, evt.callId);
  }

  /* ── Connection lifecycle ───────────────────────────────────────────────── */

  connect() {
    if (!this._config.isConfigured()) {
      logger.warn('B2ComAdapter.connect: credentials not configured — emitting registrationFailed');
      setImmediate(() => this._sendEvent('registrationFailed', {
        provider: 'b2com',
        reason:   'B2Com credentials are not configured. Set B2COM_BASE_URL and B2COM_TOKEN (or B2COM_USERNAME + B2COM_PASSWORD) in .env',
      }));
      return Promise.resolve({});
    }

    return this._ws.connect()
      .then(() => {
        logger.info('B2ComAdapter: WS connected to B2Com');
        // TODO: after WS connect, wait for B2Com to emit its registered event
        //       rather than emitting one here. Remove setImmediate once confirmed.
        return {};
      })
      .catch((err) => {
        logger.error({ err: err.message }, 'B2ComAdapter.connect failed');
        this._sendEvent('error', { code: 'CONNECT_FAILED', message: err.message });
        return Promise.reject(err);
      });
  }

  disconnect() {
    return this._ws.disconnect().then(() => {
      logger.info('B2ComAdapter: disconnected');
      return {};
    });
  }

  destroy() {
    this._ws.disconnect().catch(() => {});
    logger.debug('B2ComAdapter: destroyed');
  }

  /* ── Controlled error helper ────────────────────────────────────────────── */

  _stub(method) {
    this._config.requireConfigured();
    return Promise.reject(
      new AdapterNotReadyError(`B2Com ${method}() is not yet implemented — pending API documentation`)
    );
  }

  /* ── Call control ───────────────────────────────────────────────────────── */

  call(number, contact) {
    this._config.requireConfigured();
    // TODO: POST to B2Com REST endpoint to initiate outbound call.
    //       Confirm path, request body, and response shape with API docs.
    //       Expected response should include a providerCallId that can be
    //       mapped to an internal callId via B2ComEventNormalizer.
    // Example (placeholder):
    //   return this._http.post('/api/calls', { number, extension: this._config.extension })
    //     .then(res => { ... mint callId via normalizer ... });
    return this._stub('call');
  }

  answer() {
    // TODO: PUT /api/calls/{providerCallId}/answer
    return this._stub('answer');
  }

  reject() {
    // TODO: PUT /api/calls/{providerCallId}/reject or DELETE
    return this._stub('reject');
  }

  hangup() {
    // TODO: DELETE /api/calls/{providerCallId}
    return this._stub('hangup');
  }

  hold() {
    // TODO: PUT /api/calls/{providerCallId}/hold
    return this._stub('hold');
  }

  resume() {
    // TODO: PUT /api/calls/{providerCallId}/unhold (or /resume)
    return this._stub('resume');
  }

  mute() {
    // Mute may be pure WebRTC (client-side) rather than a server REST call.
    // TODO: confirm whether B2Com has a server-side mute API or if it is
    //       handled entirely via WebRTC track muting in LabelPhone.
    return this._stub('mute');
  }

  unmute() {
    return this._stub('unmute');
  }

  setSpeaker(_enabled) {
    // Speaker/loudspeaker control is always client-side WebRTC — no server API expected.
    return Promise.reject(
      new AdapterNotReadyError('setSpeaker is a client-side WebRTC control — not a server-side operation')
    );
  }

  transfer(target) {
    // TODO: POST /api/calls/{providerCallId}/transfer { target, mode: 'blind'|'attended' }
    //       Confirm transfer modes supported by B2Com.
    return this._stub('transfer');
  }

  sendDTMF(digit) {
    // TODO: POST /api/calls/{providerCallId}/dtmf { digit }
    //       Alternatively B2Com may accept DTMF via WS command.
    return this._stub('sendDTMF');
  }

  /* ── Data ───────────────────────────────────────────────────────────────── */

  getContacts() {
    if (!this._config.isConfigured()) {
      return Promise.reject(new AdapterNotReadyError('B2Com credentials not configured'));
    }
    // TODO: GET /api/contacts — confirm path and response shape
    // return this._http.get('/api/contacts');
    return this._stub('getContacts');
  }

  getHistory() {
    if (!this._config.isConfigured()) {
      return Promise.reject(new AdapterNotReadyError('B2Com credentials not configured'));
    }
    // TODO: GET /api/calls/history — confirm path, pagination, and response shape
    // return this._http.get('/api/calls/history');
    return this._stub('getHistory');
  }

  addHistoryEntry(_entry) {
    // TODO: decide whether call history is stored locally in LabelGateway or
    //       pushed to a B2Com API endpoint.
    return this._stub('addHistoryEntry');
  }

  /* ── Authentication ────────────────────────────────────────────────────── */

  login(_credentials) {
    return Promise.reject(
      new AdapterNotReadyError('B2Com login() not implemented — B2Com authenticates via env credentials (B2COM_TOKEN or B2COM_USERNAME/B2COM_PASSWORD)')
    );
  }

  logout() {
    return this.disconnect();
  }

  /* ── Simulation (mock only) ─────────────────────────────────────────────── */

  simulateIncomingCall() {
    return Promise.reject(
      new AdapterNotReadyError('simulateIncomingCall is only available with MockAdapter (TELEPHONY_PROVIDER=mock)')
    );
  }
}

module.exports = B2ComAdapter;
