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
    // ── Transport mode ──────────────────────────────────────────────────────
    // 'udp'  → PromoSoftSipClient (manual SIP over dgram, legacy)
    // 'wss'  → PromoSoftWssClient (JsSIP over WebSocket)
    this.mode = (env.PROMOSOFT_MODE || 'udp').toLowerCase();

    // ── UDP mode config ─────────────────────────────────────────────────────
    this.sipServer    = env.PROMOSOFT_SIP_SERVER    || null;
    this.sipPort      = parseInt(env.PROMOSOFT_SIP_PORT, 10) || 5060;
    this.sipTransport = env.PROMOSOFT_SIP_TRANSPORT || 'udp';
    this.sipDomain    = env.PROMOSOFT_SIP_DOMAIN    || null;
    this.sipStunServer = env.PROMOSOFT_STUN_SERVER  || null;
    this.debug        = env.PROMOSOFT_DEBUG === 'true';
    // Write every raw SIP message (INVITE / 200 OK / ACK / BYE) to logs/sip/.
    // Set LOG_SIP_RAW=true (preferred) or PROMOSOFT_SIP_DUMP=true (legacy) to
    // enable.  Independent of debug logging.
    this.sipDump      = env.LOG_SIP_RAW === 'true' || env.PROMOSOFT_SIP_DUMP === 'true';

    // Local SIP UDP port to bind to (0 = OS picks an ephemeral port).
    // Set PROMOSOFT_SIP_BIND_PORT=5060 or 5062 for a stable port so the
    // Contact header uses a predictable value rather than an ephemeral one.
    this.sipBindPort  = parseInt(env.PROMOSOFT_SIP_BIND_PORT, 10) || 0;

    // RTP media NAT (UDP mode only)
    this.publicRtpIp  = env.PROMOSOFT_PUBLIC_RTP_IP  || null;
    this.rtpPortMin   = parseInt(env.PROMOSOFT_RTP_PORT_MIN, 10) || 20000;
    this.rtpPortMax   = parseInt(env.PROMOSOFT_RTP_PORT_MAX, 10) || 20100;

    // ── WSS mode config ─────────────────────────────────────────────────────
    // PROMOSOFT_WS_URL      — WebSocket endpoint (e.g. wss://prelabel2.guccontactcenter.com:8089)
    // PROMOSOFT_AUTH_USER   — SIP authorization user; defaults to the extension from login
    // PROMOSOFT_CONTACT_URI — Stable SIP Contact URI sent in REGISTER/INVITE.
    //   If unset, JsSIP generates a random sip:<token>@<token>.invalid;transport=ws which
    //   some PBX dashboards fail to resolve back to the registered extension.
    //   Set to: sip:<extension>@<host>;transport=ws
    this.wsUrl      = env.PROMOSOFT_WS_URL      || null;
    this.authUser   = env.PROMOSOFT_AUTH_USER   || null;
    this.contactUri = env.PROMOSOFT_CONTACT_URI || null;

    if (!this.isServerConfigured()) {
      const logger = require('../../utils/logger').child({ module: 'Config' });
      const missingVar = this.mode === 'wss' ? 'PROMOSOFT_WS_URL' : 'PROMOSOFT_SIP_SERVER';
      logger.warn(
        `PromoSoftConfig: ${missingVar} is not set — ` +
        'registrationFailed will be emitted when a client connects'
      );
    }
  }

  /** Returns true when the minimum SIP infrastructure is configured. */
  isServerConfigured() {
    if (this.mode === 'wss') return !!this.wsUrl;
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

  /** Effective SIP domain for URI construction. */
  get serverDomain() {
    if (this.sipDomain) return this.sipDomain;
    if (this.sipServer) return this.sipServer;
    // WSS mode: derive hostname from the WebSocket URL
    if (this.wsUrl) {
      try { return new URL(this.wsUrl).hostname; } catch (_) {}
    }
    return null;
  }
}

module.exports = PromoSoftConfig;
