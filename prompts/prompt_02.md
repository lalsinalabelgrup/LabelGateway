# Build LabelGateway Mock Backend

Build a Node.js backend in the `LabelGateway/` folder.

## Stack

- Express (HTTP + REST)
- ws (WebSocket server)
- cors
- dotenv
- zod (config validation)
- pino + pino-pretty (structured logging)

## Endpoints

- `GET /health` — liveness check
- `GET /api/status` — service info

## WebSocket

- Endpoint: `ws://localhost:8080/ws`
- Each connected client gets its own session and adapter instance

## MockAdapter

Implement a full in-process telephony simulation (`MockAdapter`) that:

- Simulates the full call lifecycle: connect, outgoingCall, incomingCall, ringing, answered, held, resumed, ended, dtmf, transfer
- Returns mock contacts and call history
- Uses configurable delays (connect delay, call connect delay, incoming delay, transfer delay)
- Emits normalised events to the connected WebSocket client

## Default server

- `http://0.0.0.0:8080`
- `NODE_ENV=development` uses pino-pretty coloured logs
- `NODE_ENV=production` uses newline-delimited JSON logs
