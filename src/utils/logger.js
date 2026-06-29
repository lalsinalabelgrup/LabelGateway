const pino = require('pino');
const config = require('../config/config');

const logger = pino({
  level: config.LOG_LEVEL,
  ...(config.NODE_ENV !== 'production' && {
    transport: {
      target: 'pino-pretty',
      options: {
        colorize:      true,
        translateTime: 'HH:MM:ss.l',
        ignore:        'pid,hostname',
      },
    },
  }),
});

module.exports = logger;
