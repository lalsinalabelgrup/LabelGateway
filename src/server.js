/**
 * server.js — LabelGateway entry point
 *
 * Starts the HTTP + WebSocket server.
 * REST is minimal; all telephony traffic goes over WebSocket (/ws).
 */

// First executable line — breakpoint here is hit immediately on F5.
// Logs raw values injected by launch.json (before dotenv overwrites anything).
/* eslint-disable no-console */
console.log("[LabelGateway] starting", {
  cwd: process.cwd(),
  file: __filename,
  NODE_ENV: process.env.NODE_ENV,
  TELEPHONY_PROVIDER: process.env.TELEPHONY_PROVIDER,
  PROMOSOFT_SIP_SERVER: process.env.PROMOSOFT_SIP_SERVER,
  PROMOSOFT_SIP_PORT: process.env.PROMOSOFT_SIP_PORT,
  PROMOSOFT_SIP_TRANSPORT: process.env.PROMOSOFT_SIP_TRANSPORT,
});
/* eslint-enable no-console */

const dotenvResult = require("dotenv").config();

const http = require("http");
const express = require("express");
const cors = require("cors");
const setupWsServer = require("./websocket/wsServer");
const { getRegistrationState } = setupWsServer;
const config = require("./config/config");
const logger = require("./utils/logger").child({ module: "Server" });

const app = express();

app.use(cors({ origin: config.CORS_ORIGIN }));
app.use(express.json());

/* ── REST endpoints ─────────────────────────────────────────────────────── */

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "LabelGateway" });
});

app.get("/api/status", (_req, res) => {
  res.json({
    service: "LabelGateway",
    version: "1.0.0",
    registration: getRegistrationState(),
    wsUrl: `ws://localhost:${config.PORT}/ws`,
    restUrl: `http://localhost:${config.PORT}/api`,
    uptime: Math.floor(process.uptime()),
  });
});

app.use((_req, res) => {
  res.status(404).json({ error: "Not found" });
});

/* ── HTTP + WebSocket server ────────────────────────────────────────────── */

const server = http.createServer(app);
setupWsServer(server);

server.listen(config.PORT, config.HOST, () => {
  logger.info("LabelGateway starting", {
    nodeVersion: process.version,
    environment: config.NODE_ENV,
    provider: config.TELEPHONY_PROVIDER,
    host: config.HOST,
    port: config.PORT,
    wsPath: "/ws",
    logLevel: config.LOG_LEVEL,
    fileLoggingEnabled: config.LOG_TO_FILE,
    rtpLoggingEnabled: config.LOG_RTP,
    sipRawLoggingEnabled: config.LOG_SIP_RAW,
  });
  logger.info(`CWD                     :  ${process.cwd()}`);
  logger.info(`Node                    :  ${process.version}`);
  logger.info(
    dotenvResult.error
      ? ".env                          : not found — using environment variables only"
      : ".env                          : loaded",
  );
  logger.info(
    `LabelGateway listening  :  http://${config.HOST}:${config.PORT}`,
  );
  logger.info(`WebSocket endpoint      :  ws://localhost:${config.PORT}/ws`);
  logger.info(
    `REST health             :  http://localhost:${config.PORT}/health`,
  );
});

server.on("error", (err) => {
  logger.error({ err }, "Server error");
  process.exit(1);
});

/* ── Graceful shutdown ──────────────────────────────────────────────────── */

let shuttingDown = false;

function shutdown(reason, exitCode) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ reason, exitCode }, "LabelGateway shutting down");

  // Never let log-flushing keep the process alive indefinitely.
  const forceExitTimer = setTimeout(() => process.exit(exitCode), 5000);
  if (typeof forceExitTimer.unref === "function") forceExitTimer.unref();

  server.close(() => {
    logger.close().finally(() => {
      clearTimeout(forceExitTimer);
      process.exit(exitCode);
    });
  });
}

process.on("SIGTERM", () => shutdown("SIGTERM", 0));
process.on("SIGINT", () => shutdown("SIGINT", 0));

process.on("uncaughtException", (err) => {
  logger.error({ err }, "Uncaught exception");
  shutdown("uncaughtException", 1);
});

process.on("unhandledRejection", (reason) => {
  logger.error({ err: reason }, "Unhandled promise rejection");
  shutdown("unhandledRejection", 1);
});
