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

const BaseTelephonyAdapter     = require('./BaseTelephonyAdapter');
const PromoSoftConfig          = require('./promosoft/PromoSoftConfig');
const PromoSoftSipClient       = require('./promosoft/PromoSoftSipClient');
const PromoSoftEventNormalizer = require('./promosoft/PromoSoftEventNormalizer');
const { AdapterNotReadyError, PromoSoftLoginError } = require('./promosoft/PromoSoftErrors');
const logger                   = require('../utils/logger');

class PromoSoftAdapter extends BaseTelephonyAdapter {
  constructor(sendEvent) {
    super(sendEvent);
    this._config     = new PromoSoftConfig();
    this._normalizer = new PromoSoftEventNormalizer();
    this._sipClient  = new PromoSoftSipClient(this._config);
    this._session    = null; // { extension, displayName } — password NOT stored here
  }

  /* ── Lifecycle ──────────────────────────────────────────────────────────── */

  /**
   * Called when a LabelPhone client opens a WS connection.
   * If PROMOSOFT_SIP_SERVER is not configured → emit registrationFailed.
   * If configured → stay silent and wait for the `login` command with credentials.
   */
  connect() {
    if (!this._config.isServerConfigured()) {
      logger.warn('PromoSoftAdapter: SIP server not configured — emitting registrationFailed');
      setImmediate(() => this._sendEvent('registrationFailed', {
        provider: 'promosoft',
        reason:   'PromoSoft SIP server not configured. Set PROMOSOFT_SIP_SERVER in .env',
      }));
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
      const reason = 'extension and password are required for PromoSoft login';
      this._sendEvent('registrationFailed', { provider: 'promosoft', reason });
      return Promise.reject(new PromoSoftLoginError(reason));
    }

    try { this._config.requireServerConfigured(); }
    catch (err) {
      this._sendEvent('registrationFailed', { provider: 'promosoft', reason: err.message });
      return Promise.reject(err);
    }

    this._session = { extension, displayName: displayName || extension };
    // Log extension only — password must never appear in any log entry
    logger.info({ extension }, 'PromoSoftAdapter: login — starting SIP REGISTER (password redacted)');

    // Fire-and-forget: SIP REGISTER runs in the background.
    // The command reply is { ok: true }; the actual result arrives as a push event.
    this._sipClient.register({ extension, password })
      .then(() => {
        logger.info({ extension }, 'PromoSoftAdapter: registered');
        this._sendEvent('registered', { extension });
      })
      .catch((err) => {
        logger.error({ extension, err: err.message }, 'PromoSoftAdapter: SIP registration failed');
        this._session = null;
        this._sendEvent('registrationFailed', {
          provider: 'promosoft',
          reason:   err.message,
          extension,
        });
      });

    return Promise.resolve({});
  }

  /**
   * Unregister from the SIP server (REGISTER with Expires: 0) and clear session.
   */
  logout() {
    const ext = this._session && this._session.extension;
    if (ext) logger.info({ extension: ext }, 'PromoSoftAdapter: logout');
    this._session = null;

    return this._sipClient.unregister()
      .then(() => {
        this._sendEvent('unregistered', ext ? { extension: ext } : {});
        return {};
      })
      .catch((err) => {
        logger.warn({ err: err.message }, 'PromoSoftAdapter: unregister error (ignored)');
        this._sendEvent('unregistered', ext ? { extension: ext } : {});
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
      throw new AdapterNotReadyError('PromoSoft: not logged in — send the login command first');
    }
  }

  _stub(methodName) {
    try { this._requireSession(); }
    catch (err) { return Promise.reject(err); }
    return Promise.reject(
      new AdapterNotReadyError(`PromoSoft: ${methodName}() not yet implemented — pending SIP INVITE integration`)
    );
  }

  /* ── Call methods (all stubbed — pending SIP INVITE integration) ─────────── */

  call(number, contact)  { return this._stub('call'); }
  answer()               { return this._stub('answer'); }
  reject()               { return this._stub('reject'); }
  hangup()               { return this._stub('hangup'); }
  hold()                 { return this._stub('hold'); }
  resume()               { return this._stub('resume'); }
  mute()                 { return this._stub('mute'); }
  unmute()               { return this._stub('unmute'); }
  setSpeaker(_enabled)   { return this._stub('setSpeaker'); }
  transfer(target)       { return this._stub('transfer'); }
  sendDTMF(digit)        { return this._stub('sendDTMF'); }

  /* ── Data (empty stubs — no PromoSoft contacts/history API defined yet) ──── */

  getContacts()           { return Promise.resolve({ contacts: [] }); }
  getHistory()            { return Promise.resolve({ history: [] }); }
  addHistoryEntry(_entry) { return Promise.resolve({}); }

  /* ── Cleanup ────────────────────────────────────────────────────────────── */

  destroy() {
    this._sipClient.destroy();
    this._session = null;
  }
}

module.exports = PromoSoftAdapter;
