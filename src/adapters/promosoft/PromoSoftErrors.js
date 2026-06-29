/**
 * PromoSoftErrors — custom error classes for the PromoSoft adapter.
 *
 *   AdapterNotReadyError  Thrown when credentials are missing, the session has
 *                         not logged in yet, or the SIP server is not configured.
 *                         Produces a controlled WS error without crashing the server.
 *
 *   PromoSoftSipError     Wraps a SIP stack failure (REGISTER rejected, session
 *                         error, network loss, etc.).
 *
 *   PromoSoftLoginError   Thrown when the `login` command is missing required
 *                         fields (extension, password).
 */

class AdapterNotReadyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AdapterNotReadyError';
    this.code = 'ADAPTER_NOT_READY';
  }
}

class PromoSoftSipError extends Error {
  constructor(message, cause) {
    super(message);
    this.name  = 'PromoSoftSipError';
    this.code  = 'PROMOSOFT_SIP_ERROR';
    this.cause = cause || null;
  }
}

class PromoSoftLoginError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PromoSoftLoginError';
    this.code = 'PROMOSOFT_LOGIN_ERROR';
  }
}

module.exports = { AdapterNotReadyError, PromoSoftSipError, PromoSoftLoginError };
