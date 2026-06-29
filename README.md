# LabelGateway

Telephony Gateway Backend for LabelPhone.

Provides a WebSocket + REST API that LabelPhone connects to in `real` mode.
Currently ships with a **MockAdapter** — a full in-process telephony simulation —
so the complete demo works without any external telephony provider.

---

## Architecture

```
LabelPhone UI
  ↓ commands (WebSocket)
  ↑ normalised events
LabelGateway  ←  this server
  ↓ provider protocol
Provider Adapters
  MockAdapter (built-in, no external deps)
  B2Com, OnSIP, 3CX, Asterisk, Aircall … (future)
```

---

## Quick start

```bash
cd LabelGateway
npm install
cp .env.example .env
npm start
```

Server starts on **http://0.0.0.0:8080** by default.

---

## Connect LabelPhone

1. Open `LabelPhone/js/config/appConfig.js`
2. Change `mode` from `'mock'` to `'real'`:

```js
telephonyGateway: {
  mode:    'real',              // ← change this
  restUrl: 'http://localhost:8080/api',
  wsUrl:   'ws://localhost:8080/ws',
}
```

The active telephony provider is set **only** in LabelGateway via `TELEPHONY_PROVIDER` in `.env`.
LabelPhone does not select or know the provider — switching from `mock` to `b2com` (or any future
adapter) requires only a LabelGateway config change and restart, with zero LabelPhone changes.

3. Open `LabelPhone/index.html` in a browser — LabelPhone will connect to LabelGateway automatically.

---

## REST endpoints

| Method | Path | Description |
|---|---|---|
| GET | `/health` | Liveness check |
| GET | `/api/status` | Service info (version, adapter, URLs, uptime) |

---

## WebSocket protocol

**Endpoint:** `ws://localhost:8080/ws`

### Client → Server (command)

```json
{ "id": "<uid>", "command": "<name>", "callId": "<cid>", "params": { … } }
```

`callId` is present for all commands that target an existing call (`hangup`, `hold`, `resume`, `answer`, `reject`, `mute`, `unmute`, `setSpeaker`, `transfer`, `sendDTMF`). It is absent for commands that create or are unrelated to a call (`call`, `getContacts`, `getHistory`, `simulateIncomingCall`). `params` is omitted when the command has no parameters.

### Server → Client (command reply)

```json
{ "id": "<uid>", "result": { … } }
{ "id": "<uid>", "error": "<message>" }
```

### Server → Client (push event)

```json
{ "event": "<name>", "callId": "<cid>", "timestamp": "<ISO8601>", "payload": { … } }
```

`callId` is present for all events that belong to a specific call. It is absent for session-level events (`connecting`, `connected`, `disconnected`, `registered`, `unregistered`).

---

## Supported commands

| Command | Params | Description |
|---|---|---|
| `connect` | — | Initialise session (optional in real mode) |
| `disconnect` | — | Close session |
| `call` | `number`, `contact?` | Start outbound call |
| `answer` | — | Answer inbound call |
| `reject` | — | Decline inbound call |
| `hangup` | — | End active call |
| `hold` | — | Place call on hold |
| `resume` | — | Resume held call |
| `mute` | — | Mute microphone |
| `unmute` | — | Unmute microphone |
| `setSpeaker` | `enabled` | Enable/disable speaker |
| `transfer` | `target` | Blind transfer |
| `sendDTMF` | `digit` | Send DTMF digit |
| `getContacts` | — | Fetch contact list |
| `getHistory` | — | Fetch call history |
| `addHistoryEntry` | `entry` | Persist history entry |
| `simulateIncomingCall` | `contact?` | Trigger simulated incoming (MockAdapter only) |

---

## Push events

These are the normalised event names expected by `telephonyGatewayClient.js`:

`callId` is at the **top level** of the event envelope (not inside `payload`).

| Event | callId | Payload | When |
|---|---|---|---|
| `connecting` | — | `{}` | Session connecting |
| `connected` | — | `{}` | Session ready |
| `disconnected` | — | `{}` | Session closed |
| `registered` | — | `{ extension }` | Extension registered |
| `unregistered` | — | `{}` | Extension unregistered |
| `outgoingCall` | ✓ | `{ number, contact }` | Outbound call initiated |
| `incomingCall` | ✓ | `{ number, contact }` | Inbound call arriving |
| `ringing` | ✓ | `{}` | Call is ringing |
| `answered` | ✓ | `{ contact, number, startTime }` | Call connected |
| `held` | ✓ | `{}` | Call placed on hold |
| `resumed` | ✓ | `{}` | Call resumed |
| `ended` | ✓ | `{ contact, number, direction, duration, reason }` | Call ended |
| `dtmf` | ✓ | `{ digit }` | DTMF digit sent |
| `historyUpdated` | — | `{ history }` | History changed |
| `error` | — | `{ code, message }` | Error condition |

---

## Configuration (.env)

| Variable | Default | Description |
|---|---|---|
| `PORT` | `8080` | HTTP/WS listen port |
| `HOST` | `0.0.0.0` | Bind address |
| `CORS_ORIGIN` | `*` | Allowed CORS origin |
| `ADAPTER` | `mock` | Telephony adapter (`mock`) |
| `LOG_LEVEL` | `info` | Pino log level |
| `NODE_ENV` | `development` | `development` → pretty logs; `production` → JSON |
| `MOCK_CONNECT_DELAY_MS` | `600` | Simulated connect delay |
| `MOCK_CALL_CONNECT_MS` | `2000` | Simulated call answer delay |
| `MOCK_INCOMING_DELAY_MS` | `3000` | Simulated incoming call delay |
| `MOCK_TRANSFER_DELAY_MS` | `800` | Simulated transfer delay |

---

## File structure

```
LabelGateway/
├── src/
│   ├── server.js                    Entry point — Express + HTTP server
│   ├── config/
│   │   └── config.js                Env-validated configuration (Zod)
│   ├── websocket/
│   │   └── wsServer.js              WebSocket server — command routing
│   ├── adapters/
│   │   ├── BaseTelephonyAdapter.js  Abstract interface for all adapters
│   │   └── MockAdapter.js           In-process telephony simulation
│   ├── services/
│   │   ├── CallStateService.js      Per-session call state container
│   │   └── EventBus.js              Internal Node.js EventEmitter singleton
│   └── utils/
│       └── logger.js                Pino logger (pretty in dev, JSON in prod)
├── .env.example
├── package.json
└── README.md
```

---

## Adding a real provider adapter

1. Create `src/adapters/MyProviderAdapter.js` extending `BaseTelephonyAdapter`
2. Implement all methods; call `this._sendEvent(event, payload)` to push events
3. Add `'myprovider'` to the `ADAPTER` enum in `src/config/config.js`
4. Import and instantiate it in `src/websocket/wsServer.js`

LabelPhone code does **not** change when a new provider adapter is added.

---

## MockAdapter behaviour

| Action | Simulation |
|---|---|
| `connect()` | Emits `connecting` → after `MOCK_CONNECT_DELAY_MS` → `connected` + `registered` |
| `call()` | Emits `outgoingCall` + `ringing` → after `MOCK_CALL_CONNECT_MS` → `answered` |
| `hangup()` | Emits `ended` with correct duration |
| `reject()` | Emits `ended` with `reason: 'declined'` |
| `hold()` / `resume()` | Emits `held` / `resumed` |
| `transfer()` | After `MOCK_TRANSFER_DELAY_MS`, emits `ended` with `reason: 'transferred'` |
| `simulateIncomingCall()` | After `MOCK_INCOMING_DELAY_MS`, emits `incomingCall` + `ringing` |
| `getContacts()` | Returns 12 mock contacts |
| `getHistory()` | Returns 6 mock history entries |

---

## Development

```bash
npm run dev    # node --watch (Node 18+ built-in, no nodemon needed)
npm start      # plain node
```

Logs use `pino-pretty` in development (coloured, human-readable).
In production (`NODE_ENV=production`) logs are newline-delimited JSON.

---

## Debugging with VSCode

### Which folder to open

The `launch.json` configurations use `${workspaceFolder}` to build file paths.
**Open the correct folder** so those paths resolve:

| How you open VSCode | `${workspaceFolder}` resolves to | `launch.json` used |
|---|---|---|
| `File → Open Folder` → `LabelGateway/` | `.../LabelGateway` | `LabelGateway/.vscode/launch.json` |
| `File → Open Folder` → `LabelSuite/` | `.../LabelSuite` | `LabelSuite/.vscode/launch.json` |

Both files contain the same four profiles and keep all paths correct for their respective workspace root.

---

### Steps

1. **Open the folder** (see table above).

2. **Create `.env`** from the template if you haven't already:

   ```bash
   # from inside LabelGateway/
   cp .env.example .env
   ```

   Fill in any provider credentials (`PROMOSOFT_SIP_SERVER`, `B2COM_*`, etc.).
   Secrets live only in `.env` — never in `launch.json`.

3. **Select a debug profile** in the Run & Debug panel (`Ctrl+Shift+D`):

   | Profile | Provider | When to use |
   |---|---|---|
   | Debug LabelGateway | From `.env` | General — uses whatever is set in `.env` |
   | Debug LabelGateway with PromoSoft | `promosoft` | PromoSoft SIP integration work |
   | Debug LabelGateway with Mock | `mock` | Offline / no credentials needed |
   | Attach to LabelGateway (port 9229) | — | Attach to a process started with `npm run debug` |

4. **Press `F5`** to start. The integrated terminal shows pino-pretty logs alongside the debugger.

5. **Verify the process is correct.** At startup, `server.js` logs:

   ```
   CWD   →  /absolute/path/to/LabelGateway     ← must end in LabelGateway
   Node  →  v22.x.x
   .env loaded                                  ← or "not found" if .env is missing
   Adapter  →  mock
   ```

   If `CWD` does not end in `LabelGateway`, the wrong workspace root is open — close and reopen the correct folder.

6. **Set breakpoints** by clicking the gutter to the left of any line number:

   | File | Breakpoint catches |
   |---|---|
   | `src/server.js` | Server startup |
   | `src/websocket/wsServer.js` | Every WebSocket command received |
   | `src/adapters/PromoSoftAdapter.js` | Login / register flow |
   | `src/adapters/promosoft/PromoSoftSipClient.js` | SIP REGISTER, digest auth |
   | `src/adapters/promosoft/PromoSoftEventNormalizer.js` | SIP → normalised event |
   | `src/adapters/B2ComAdapter.js` | B2Com command handling |

   Breakpoints appear as solid red circles when bound. A hollow circle means the file
   wasn't loaded yet — trigger the relevant code path (send a command from LabelPhone)
   and the breakpoint will bind on first load.

---

### Attach profile

To attach to an already-running process (useful when you need to debug without restarting):

```bash
# in LabelGateway/
npm run debug   # starts node --inspect on port 9229
```

Then select **"Attach to LabelGateway (port 9229)"** and press F5.
The `restart: true` option in that profile means VSCode will automatically re-attach if you restart the process.

---

> **Tip:** The PromoSoft and Mock profiles override `TELEPHONY_PROVIDER` and `ADAPTER` in
> `launch.json`'s `env` block, so they take precedence over `.env`. All other variables
> (ports, SIP server hostname, API keys) are still read from `.env`.
