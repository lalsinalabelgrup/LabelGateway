require('dotenv').config();
const { z } = require('zod');

// z.coerce.boolean() treats the string "false" as truthy (any non-empty
// string coerces to true), so boolean-flag env vars use this explicit
// string-compare transform instead.
const boolString = (def) => z.string().optional().default(String(def)).transform((v) => v === 'true');

const schema = z.object({
  PORT:                   z.coerce.number().default(8080),
  HOST:                   z.string().default('0.0.0.0'),
  CORS_ORIGIN:            z.string().default('*'),
  ADAPTER:                z.enum(['mock', 'b2com', 'promosoft']).default('mock'),
  TELEPHONY_PROVIDER:     z.enum(['mock', 'b2com', 'promosoft']).default('mock'),
  LOG_LEVEL:              z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  NODE_ENV:               z.string().default('development'),
  MOCK_CONNECT_DELAY_MS:  z.coerce.number().default(600),
  MOCK_CALL_CONNECT_MS:   z.coerce.number().default(2000),
  MOCK_INCOMING_DELAY_MS: z.coerce.number().default(3000),
  MOCK_TRANSFER_DELAY_MS: z.coerce.number().default(800),

  // Logging (see src/utils/logger.js)
  LOG_CONSOLE:            boolString(true),
  LOG_TO_FILE:            boolString(true),
  LOG_DIR:                z.string().default('logs'),
  LOG_RETENTION_DAYS:     z.coerce.number().default(14),
  LOG_MAX_SIZE:           z.string().default('20m'),
  LOG_RTP:                boolString(false),
  LOG_SIP_RAW:            boolString(false),

  // RTP outbound audio jitter buffer (see PromoSoftSipClient.js sendAudioFrame/tick)
  RTP_AUDIO_QUEUE_MAX_FRAMES:       z.coerce.number().default(25),
  RTP_AUDIO_QUEUE_START_FRAMES:     z.coerce.number().default(10),
  RTP_AUDIO_QUEUE_RECOVERY_FRAMES:  z.coerce.number().default(4),
  RTP_AUDIO_QUEUE_MAX_LATENCY_MS:   z.coerce.number().default(200),
  RTP_AUDIO_CONCEALMENT_MAX_FRAMES: z.coerce.number().default(4),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  console.error('LabelGateway: invalid configuration\n', parsed.error.format());
  process.exit(1);
}

module.exports = parsed.data;
