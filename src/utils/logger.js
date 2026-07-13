"use strict";

/**
 * Central Winston logger. All modules must require this file (or a
 * `.child({ module: '...' })` of it) rather than instantiating their own
 * logger.
 *
 * Existing call sites across the codebase use pino's call signature —
 * `logger.info(mergingObject, msg)` — so every level method here accepts
 * either argument order:
 *   logger.info({ sipCallId }, 'RTP session started')   // pino style
 *   logger.info('RTP session started', { sipCallId })   // winston style
 * This lets the whole codebase move to Winston without rewriting the
 * ~249 existing log call sites.
 */

const fs = require("fs");
const winston = require("winston");
require("winston-daily-rotate-file");
const config = require("../config/config");

const LEVELS = { fatal: 0, error: 1, warn: 2, info: 3, debug: 4, trace: 5 };
const COLORS = { fatal: "red", error: "red", warn: "yellow", info: "green", debug: "blue", trace: "gray" };
winston.addColors(COLORS);

const RESERVED_KEYS = new Set(["timestamp", "level", "message", "module"]);

// Winston does not automatically serialize Error properties beyond
// `message`, so normalize any `error`/`err` metadata field into a plain
// object before it reaches the console/file formats.
const normalizeErrors = winston.format((info) => {
  for (const key of ["error", "err"]) {
    const value = info[key];
    if (value instanceof Error) {
      info[key] = {
        message: value.message,
        stack: value.stack,
        name: value.name,
        code: value.code,
        cause: value.cause,
      };
    }
  }
  return info;
});

const consoleFormat = winston.format.combine(
  normalizeErrors(),
  winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss.SSS" }),
  winston.format.colorize({ level: true }),
  winston.format.printf((info) => {
    const { timestamp, level, message, module: mod } = info;
    const meta = {};
    for (const key of Object.keys(info)) {
      if (!RESERVED_KEYS.has(key) && info[key] !== undefined) meta[key] = info[key];
    }
    const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : "";
    const modStr = mod ? ` [${mod}]` : "";
    return `${timestamp} ${level}${modStr}: ${message}${metaStr}`;
  })
);

const fileFormat = winston.format.combine(
  normalizeErrors(),
  winston.format.timestamp(),
  winston.format.json()
);

const transports = [];

if (config.LOG_CONSOLE) {
  transports.push(new winston.transports.Console({ format: consoleFormat }));
}

if (config.LOG_TO_FILE) {
  // Never fail startup because the logs directory doesn't exist yet.
  fs.mkdirSync(config.LOG_DIR, { recursive: true });

  transports.push(
    new winston.transports.DailyRotateFile({
      dirname: config.LOG_DIR,
      filename: "application-%DATE%.log",
      datePattern: "YYYY-MM-DD",
      maxSize: config.LOG_MAX_SIZE,
      maxFiles: `${config.LOG_RETENTION_DAYS}d`,
      zippedArchive: true,
      format: fileFormat,
    })
  );

  transports.push(
    new winston.transports.DailyRotateFile({
      dirname: config.LOG_DIR,
      filename: "error-%DATE%.log",
      datePattern: "YYYY-MM-DD",
      level: "error",
      maxSize: config.LOG_MAX_SIZE,
      maxFiles: `${config.LOG_RETENTION_DAYS}d`,
      zippedArchive: true,
      format: fileFormat,
    })
  );
}

const rootWinstonLogger = winston.createLogger({
  levels: LEVELS,
  level: config.LOG_LEVEL,
  transports,
  exitOnError: false,
});

function normalizeArgs(a, b) {
  if (typeof a === "string") {
    return { message: a, meta: b && typeof b === "object" ? b : {} };
  }
  if (a && typeof a === "object") {
    return { message: typeof b === "string" ? b : "", meta: a };
  }
  return { message: a === undefined ? "" : String(a), meta: {} };
}

function closeLogger(timeoutMs = 3000) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    if (typeof timer.unref === "function") timer.unref();
    rootWinstonLogger.once("finish", finish);
    rootWinstonLogger.end(finish);
  });
}

function wrap(winstonInstance) {
  const wrapper = {};
  for (const level of Object.keys(LEVELS)) {
    wrapper[level] = (a, b) => {
      const { message, meta } = normalizeArgs(a, b);
      winstonInstance.log(level, message, meta);
    };
  }
  wrapper.child = (meta) => wrap(winstonInstance.child(meta));
  wrapper.close = () => closeLogger();
  return wrapper;
}

module.exports = wrap(rootWinstonLogger);
