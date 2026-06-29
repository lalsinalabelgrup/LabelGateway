/**
 * B2ComErrors — custom error classes for the B2Com adapter.
 *
 *   AdapterNotReadyError  Thrown when credentials are missing or the adapter
 *                         has not connected yet. Produces a controlled HTTP/WS
 *                         error message without crashing the server.
 *
 *   B2ComApiError         Wraps a failed B2Com REST API response.
 *
 *   B2ComWsError          Wraps a B2Com WebSocket connection failure.
 */

class AdapterNotReadyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AdapterNotReadyError';
    this.code = 'ADAPTER_NOT_READY';
  }
}

class B2ComApiError extends Error {
  constructor(message, statusCode, details) {
    super(message);
    this.name       = 'B2ComApiError';
    this.code       = 'B2COM_API_ERROR';
    this.statusCode = statusCode || null;
    this.details    = details   || {};
  }
}

class B2ComWsError extends Error {
  constructor(message, cause) {
    super(message);
    this.name  = 'B2ComWsError';
    this.code  = 'B2COM_WS_ERROR';
    this.cause = cause || null;
  }
}

module.exports = { AdapterNotReadyError, B2ComApiError, B2ComWsError };
