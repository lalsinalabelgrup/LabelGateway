/**
 * PromoSoftConfig
 *
 * Reads PROMOSOFT_* environment variables for SIP infrastructure only.
 * Extension and password are NEVER read from .env — they come from
 * the `login` WS command at runtime so credentials stay out of config files.
 */

const { AdapterNotReadyError } = require('./PromoSoftErrors');

class PromoSoftConfig {
  constructor(env = process.env) {
    this.sipServer    = env.PROMOSOFT_SIP_SERVER    || null;
    this.sipPort      = parseInt(env.PROMOSOFT_SIP_PORT, 10) || 5060;
    this.sipTransport = env.PROMOSOFT_SIP_TRANSPORT || 'udp';
    this.sipDomain    = env.PROMOSOFT_SIP_DOMAIN    || null;
    // STUN is used to discover the external IP/port when behind NAT.
    // PromoSoftSipClient uses rport for basic NAT traversal; STUN gives the
    // exact external address for Via/Contact when the PBX is on the public internet.
    this.sipStunServer = env.PROMOSOFT_STUN_SERVER  || null;
    this.debug        = env.PROMOSOFT_DEBUG === 'true';

    if (!this.isServerConfigured()) {
      const logger = require('../../utils/logger');
      logger.warn(
        'PromoSoftConfig: PROMOSOFT_SIP_SERVER is not set — ' +
        'registrationFailed will be emitted when a client connects'
      );
    }
  }

  /** Returns true when the minimum SIP infrastructure is configured. */
  isServerConfigured() {
    return !!this.sipServer;
  }

  /** Throws AdapterNotReadyError if the SIP server is not configured. */
  requireServerConfigured() {
    if (!this.isServerConfigured()) {
      throw new AdapterNotReadyError(
        'PromoSoft SIP server not configured. Set PROMOSOFT_SIP_SERVER in .env'
      );
    }
  }

  /** SIP registrar URI derived from infrastructure config. */
  get registrarUri() {
    if (!this.sipServer) return null;
    const scheme = (this.sipTransport === 'tls' || this.sipTransport === 'wss') ? 'sips' : 'sip';
    return `${scheme}:${this.sipServer}:${this.sipPort};transport=${this.sipTransport}`;
  }

  /** Effective SIP domain (falls back to server hostname if not set). */
  get serverDomain() {
    return this.sipDomain || this.sipServer;
  }
}

module.exports = PromoSoftConfig;
