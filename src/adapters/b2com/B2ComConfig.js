/**
 * B2ComConfig
 *
 * Reads B2Com credentials and endpoint URLs from environment variables.
 * All fields are optional at load time — the adapter starts without credentials
 * and methods return AdapterNotReadyError when they are actually invoked.
 *
 * Required for basic connectivity (minimum viable):
 *   B2COM_BASE_URL   +   B2COM_TOKEN
 *   B2COM_BASE_URL   +   B2COM_USERNAME + B2COM_PASSWORD
 */

const logger = require('../../utils/logger');
const { AdapterNotReadyError } = require('./B2ComErrors');

class B2ComConfig {
  constructor(env = process.env) {
    this.baseUrl       = env.B2COM_BASE_URL       || null;
    this.wsUrl         = env.B2COM_WS_URL         || null;
    this.webrtcUrl     = env.B2COM_WEBRTC_URL     || null;

    this.clientId      = env.B2COM_CLIENT_ID      || null;
    this.token         = env.B2COM_TOKEN          || null;

    this.username      = env.B2COM_USERNAME       || null;
    this.password      = env.B2COM_PASSWORD       || null;

    this.domain        = env.B2COM_DOMAIN         || null;
    this.extension     = env.B2COM_EXTENSION      || null;

    this.turnUrl       = env.B2COM_TURN_URL       || null;
    this.turnUsername  = env.B2COM_TURN_USERNAME  || null;
    this.turnPassword  = env.B2COM_TURN_PASSWORD  || null;

    this.debug         = env.B2COM_DEBUG === 'true';

    if (!this.isConfigured()) {
      logger.warn(
        'B2ComConfig: credentials not configured — ' +
        'adapter will start but return controlled errors on any call operation'
      );
    }
  }

  /** True when the minimum credentials needed to attempt a connection are present. */
  isConfigured() {
    const hasAuth = !!(this.token || (this.username && this.password));
    return !!(this.baseUrl && hasAuth);
  }

  /** Throws AdapterNotReadyError when credentials are not configured. */
  requireConfigured() {
    if (!this.isConfigured()) {
      throw new AdapterNotReadyError(
        'B2Com credentials are not configured. ' +
        'Set B2COM_BASE_URL and B2COM_TOKEN (or B2COM_USERNAME + B2COM_PASSWORD) in .env'
      );
    }
  }
}

module.exports = B2ComConfig;
