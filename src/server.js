/**
 * server.js — LabelGateway entry point
 *
 * Starts the HTTP + WebSocket server.
 * REST is minimal; all telephony traffic goes over WebSocket (/ws).
 */

const dotenvResult = require('dotenv').config();

const http       = require('http');
const express    = require('express');
const cors       = require('cors');
const setupWsServer = require('./websocket/wsServer');
const config     = require('./config/config');
const logger     = require('./utils/logger');

const app = express();

app.use(cors({ origin: config.CORS_ORIGIN }));
app.use(express.json());

/* ── REST endpoints ─────────────────────────────────────────────────────── */

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'LabelGateway', adapter: config.ADAPTER });
});

app.get('/api/status', (_req, res) => {
  res.json({
    service: 'LabelGateway',
    version: '1.0.0',
    adapter: config.ADAPTER,
    wsUrl:   `ws://localhost:${config.PORT}/ws`,
    restUrl: `http://localhost:${config.PORT}/api`,
    uptime:  Math.floor(process.uptime()),
  });
});

app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

/* ── HTTP + WebSocket server ────────────────────────────────────────────── */

const server = http.createServer(app);
setupWsServer(server);

server.listen(config.PORT, config.HOST, () => {
  logger.info(`CWD                     →  ${process.cwd()}`);
  logger.info(`Node                    →  ${process.version}`);
  logger.info(dotenvResult.error ? '.env not found — using environment variables only' : '.env loaded');
  logger.info(`Adapter                 →  ${config.ADAPTER}`);
  logger.info(`LabelGateway listening  →  http://${config.HOST}:${config.PORT}`);
  logger.info(`WebSocket endpoint      →  ws://localhost:${config.PORT}/ws`);
  logger.info(`REST health             →  http://localhost:${config.PORT}/health`);
});

server.on('error', (err) => {
  logger.error({ err }, 'Server error');
  process.exit(1);
});

process.on('SIGTERM', () => {
  logger.info('SIGTERM received — shutting down');
  server.close(() => process.exit(0));
});
