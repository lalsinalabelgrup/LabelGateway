/**
 * B2ComHttpClient
 *
 * Thin REST client for B2Com API calls.
 * Uses Node 18+ built-in fetch (no extra dependencies).
 *
 * Responsibilities:
 *   - Injects base URL and auth headers on every request
 *   - Enforces a per-request timeout
 *   - Parses JSON responses
 *   - Wraps non-2xx responses in B2ComApiError
 *   - Debug-logs all traffic when B2COM_DEBUG=true
 *
 * NOTE: No specific B2Com endpoint paths are hardcoded here.
 *       Add methods as endpoints are confirmed by API documentation.
 */

const logger = require('../../utils/logger');
const { B2ComApiError, AdapterNotReadyError } = require('./B2ComErrors');

const DEFAULT_TIMEOUT_MS = 10_000;

class B2ComHttpClient {
  /** @param {import('./B2ComConfig')} config */
  constructor(config) {
    this._config  = config;
    this._baseUrl = config.baseUrl ? config.baseUrl.replace(/\/$/, '') : null;
  }

  _authHeaders() {
    if (this._config.token) {
      return { Authorization: `Bearer ${this._config.token}` };
    }
    if (this._config.username && this._config.password) {
      const b64 = Buffer.from(`${this._config.username}:${this._config.password}`).toString('base64');
      return { Authorization: `Basic ${b64}` };
    }
    return {};
  }

  async _request(method, path, body) {
    if (!this._baseUrl) {
      throw new AdapterNotReadyError('B2Com base URL is not configured (B2COM_BASE_URL)');
    }

    const url = `${this._baseUrl}${path}`;
    const headers = {
      'Content-Type': 'application/json',
      Accept:         'application/json',
      ...this._authHeaders(),
    };

    if (this._config.debug) {
      logger.debug({ method, url }, 'B2ComHttpClient → request');
    }

    const controller = new AbortController();
    const timer      = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

    let res;
    try {
      res = await fetch(url, {
        method,
        headers,
        body:   body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } catch (err) {
      throw new B2ComApiError(
        `B2Com HTTP request failed: ${err.message}`,
        null,
        { method, path }
      );
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      let detail = {};
      try { detail = await res.json(); } catch { /* ignore parse error */ }
      if (this._config.debug) {
        logger.debug({ status: res.status, path, detail }, 'B2ComHttpClient ← error');
      }
      throw new B2ComApiError(`B2Com API error ${res.status} on ${path}`, res.status, detail);
    }

    const data = await res.json();
    if (this._config.debug) {
      logger.debug({ path, status: res.status }, 'B2ComHttpClient ← ok');
    }
    return data;
  }

  get(path)        { return this._request('GET',    path); }
  post(path, body) { return this._request('POST',   path, body); }
  put(path, body)  { return this._request('PUT',    path, body); }
  del(path)        { return this._request('DELETE', path); }

  /* ── Endpoint methods (add as API docs confirm paths) ─────────────────── */

  // TODO: confirm paths against B2Com API documentation before uncommenting

  // login(credentials)   { return this.post('/api/auth/login', credentials); }
  // logout()             { return this.post('/api/auth/logout'); }
  // getContacts()        { return this.get('/api/contacts'); }
  // getHistory()         { return this.get('/api/calls/history'); }
  // initiateCall(params) { return this.post('/api/calls', params); }
  // hangupCall(callId)   { return this.del(`/api/calls/${callId}`); }
  // holdCall(callId)     { return this.put(`/api/calls/${callId}/hold`); }
  // resumeCall(callId)   { return this.put(`/api/calls/${callId}/resume`); }
  // transferCall(callId, target) { return this.post(`/api/calls/${callId}/transfer`, { target }); }
  // sendDTMF(callId, digit) { return this.post(`/api/calls/${callId}/dtmf`, { digit }); }
}

module.exports = B2ComHttpClient;
