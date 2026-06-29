require('dotenv').config();
const { z } = require('zod');

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
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  console.error('LabelGateway: invalid configuration\n', parsed.error.format());
  process.exit(1);
}

module.exports = parsed.data;
