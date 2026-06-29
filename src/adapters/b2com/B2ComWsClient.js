/**
 * B2ComWsClient
 *
 * WebSocket client for B2Com real-time events.
 * Connects to B2COM_WS_URL, parses incoming frames, and forwards each parsed
 * message to the `onMessage` callback for normalization.
 *
 * Safety contract:
 *   If B2COM_WS_URL or credentials are absent, connect() returns immediately
 *   without throwing — the adapter stays up in a degraded (unconfigured) state.
 *
 * NOTE: The B2Com WS authentication handshake, ping/keepalive format, and
 *       message envelope schema are pending API documentation.
 *       See TODO comments throughout for integration points.
 */

const { WebSocket } = require('ws');
const logger = require('../../utils/logger');
const { B2ComWsError } = require('./B2ComErrors');

const RECONNECT_DELAY_MS = 5_000; // TODO: use exponential backoff once WS protocol confirmed

class B2ComWsClient {
  /**
   * @param {import('./B2ComConfig')} config
   * @param {(raw: object) => void} onMessage  Called with every parsed WS frame
   */
  constructor(config, onMessage) {
    this._config     = config;
    this._onMessage  = onMessage;
    this._ws         = null;
    this._connected  = false;
    this._destroyed  = false;
  }

  /** Open the WebSocket. Resolves immediately if credentials/URL are absent. */
  connect() {
    if (this._destroyed) return Promise.resolve();

    if (!this._config.wsUrl) {
      logger.warn('B2ComWsClient: B2COM_WS_URL not set — skipping WS connection');
      return Promise.resolve();
    }
    if (!this._config.isConfigured()) {
      logger.warn('B2ComWsClient: credentials not configured — skipping WS connection');
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      const headers = {};
      if (this._config.token) headers['Authorization'] = `Bearer ${this._config.token}`;

      logger.info({ url: this._config.wsUrl }, 'B2ComWsClient: connecting');

      try {
        this._ws = new WebSocket(this._config.wsUrl, { headers });
      } catch (err) {
        return reject(new B2ComWsError('Failed to create B2Com WebSocket', err));
      }

      this._ws.once('open', () => {
        this._connected = true;
        logger.info('B2ComWsClient: connected');

        // TODO: send authentication frame if B2Com WS requires one after the handshake.
        // Example (placeholder — confirm exact format with B2Com API docs):
        // this._ws.send(JSON.stringify({ type: 'auth', token: this._config.token }));

        resolve();
      });

      this._ws.once('error', (err) => {
        logger.error({ err: err.message }, 'B2ComWsClient: connection error');
        reject(new B2ComWsError('B2Com WebSocket connection failed', err));
      });

      this._ws.on('message', (raw) => {
        let msg;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          logger.warn({ raw: raw.toString().slice(0, 200) }, 'B2ComWsClient: non-JSON frame ignored');
          return;
        }
        if (this._config.debug) logger.debug({ msg }, 'B2ComWsClient ← frame');
        this._onMessage(msg);
      });

      this._ws.on('close', (code, reason) => {
        this._connected = false;
        logger.info({ code, reason: reason.toString() }, 'B2ComWsClient: disconnected');
        // TODO: trigger reconnect with exponential backoff once WS protocol is confirmed
        // For now, a disconnect is final until the LabelGateway session reconnects.
      });

      this._ws.on('error', (err) => {
        logger.error({ err: err.message }, 'B2ComWsClient: socket error');
      });
    });
  }

  disconnect() {
    this._destroyed = true;
    if (this._ws) {
      this._ws.close();
      this._ws = null;
    }
    this._connected = false;
    return Promise.resolve();
  }

  /**
   * Reconnect after a network drop.
   * TODO: implement exponential backoff once reconnect semantics with B2Com are confirmed.
   */
  reconnect() {
    this._destroyed = false;
    return this.disconnect().then(() => this.connect());
  }

  isConnected() { return this._connected; }
}

module.exports = B2ComWsClient;
