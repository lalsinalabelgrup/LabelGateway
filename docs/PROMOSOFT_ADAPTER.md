# PromoSoft Adapter

LabelGateway adapter for the **PromoSoft / GUC Contact Center** SIP platform.

---

## Target system

| Item | Value |
|---|---|
| Host | `prelabel2.guccontactcenter.com` |
| Protocol | SIP/UDP (default), SIP/TCP, SIP/TLS |
| Port | 5060 (default) |
| Authentication | Digest (extension + password) |
| Call control | SIP INVITE / BYE / HOLD / RESUME / REFER |
| DTMF | SIP INFO or RFC 2833 (in-band) |

---

## Status

**Skeleton — SIP stack pending integration.**

The adapter skeleton is complete:

- [x] Adapter class with full interface (`PromoSoftAdapter`)
- [x] Login flow via `login` WS command (credentials at runtime, never from `.env`)
- [x] `registrationFailed` on missing SIP server config or missing credentials
- [x] Password never logged
- [x] Per-session in-memory credential scope
- [x] SIP client stub with all methods (`PromoSoftSipClient`)
- [x] Event normalizer stub (`PromoSoftEventNormalizer`)
- [x] Error classes (`PromoSoftErrors`)
- [x] Adapter factory + COMMANDS router wired in `wsServer.js`

Remaining:

- [ ] Choose and install a Node.js SIP library (see [SIP stack candidates](#sip-stack-candidates))
- [ ] Implement `PromoSoftSipClient.register()` with real REGISTER
- [ ] Implement all call methods (INVITE, BYE, HOLD, RESUME, REFER, DTMF, ANSWER)
- [ ] Populate `SIP_EVENT_MAP` in `PromoSoftEventNormalizer` with actual event names
- [ ] Integration test with `prelabel2.guccontactcenter.com`

---

## Login flow

PromoSoft is the only provider where credentials come from LabelPhone at runtime,
not from the server's `.env`. This keeps passwords out of config files and allows
operators to log in with their own extension directly from the softphone UI.

```
LabelPhone opens WS connection
  └─ wsServer.js: createAdapter(sendEvent) → new PromoSoftAdapter(sendEvent)
  └─ wsServer.js: adapter.connect()
       └─ if PROMOSOFT_SIP_SERVER missing → emits registrationFailed
       └─ if configured → silent, waits for login command

LabelPhone sends: { command: "login", params: { extension: "101", password: "secret" } }
  └─ wsServer.js COMMANDS["login"] → adapter.login({ extension, password })
       └─ validates params and server config
       └─ logs: INFO { extension } (password redacted)
       └─ calls PromoSoftSipClient.register({ extension, password })
            └─ (stub) → emits registrationFailed
            └─ (real) SIP REGISTER → 200 OK → emits registered { extension }
                                   → 4xx/5xx → emits registrationFailed { reason }
```

**Security rules (enforced in code):**
- Password is **never** stored on any instance property after `login()` — it is passed directly into `sipClient.register()` as a function argument.
- Password is **never** written to any log entry (`logger.info`, `logger.debug`, `logger.warn`, `logger.error`).
- `_session` stores only `{ extension, displayName }`.

---

## Configuration

### `.env` — SIP infrastructure only

```env
TELEPHONY_PROVIDER=promosoft
ADAPTER=promosoft

PROMOSOFT_SIP_SERVER=prelabel2.guccontactcenter.com
PROMOSOFT_SIP_PORT=5060
PROMOSOFT_SIP_TRANSPORT=udp
PROMOSOFT_SIP_DOMAIN=         # optional; defaults to PROMOSOFT_SIP_SERVER
PROMOSOFT_DEBUG=false
```

**Do NOT** add extension or password to `.env`.

---

## WS command reference

### `login` — authenticate and register

Sent by LabelPhone after the WS connection is established.

```json
{
  "id": "login-1718000000000",
  "command": "login",
  "params": {
    "extension":   "101",
    "password":    "secret",
    "displayName": "Lluis Alsina"
  }
}
```

Success reply:

```json
{ "id": "login-1718000000000", "result": {} }
```

followed by the `registered` push event:

```json
{ "event": "registered", "timestamp": "…", "payload": { "extension": "101" } }
```

Failure reply (reply + push event):

```json
{ "id": "login-1718000000000", "result": {} }
{ "event": "registrationFailed", "timestamp": "…", "payload": { "provider": "promosoft", "reason": "…", "extension": "101" } }
```

The command always resolves (result `{}`). The actual outcome arrives as a push event.

### `logout` — unregister

```json
{ "id": "logout-1718000000001", "command": "logout" }
```

Push event:

```json
{ "event": "unregistered", "timestamp": "…", "payload": { "extension": "101" } }
```

---

## Normalised push events

Events follow the standard LabelGateway schema: `{ event, callId?, timestamp, payload }`.

| Event | callId | Payload | Trigger |
|---|---|---|---|
| `registrationFailed` | — | `{ provider, reason, extension? }` | SIP server not configured; login params missing; REGISTER rejected |
| `registered` | — | `{ extension }` | SIP REGISTER accepted (200 OK) |
| `unregistered` | — | `{ extension? }` | logout command |
| `outgoingCall` | ✓ | `{ number, contact }` | INVITE sent |
| `incomingCall` | ✓ | `{ number, contact }` | Incoming INVITE received |
| `ringing` | ✓ | `{}` | 180 Ringing |
| `answered` | ✓ | `{ contact, number, startTime }` | 200 OK (call connected) |
| `held` | ✓ | `{}` | re-INVITE sendonly |
| `resumed` | ✓ | `{}` | re-INVITE sendrecv |
| `ended` | ✓ | `{ contact, number, direction, duration, reason }` | BYE received/sent |
| `dtmf` | ✓ | `{ digit }` | DTMF sent |
| `error` | — | `{ code, message }` | Unrecoverable error |

---

## File structure

```
src/adapters/
├── PromoSoftAdapter.js               Main adapter class
└── promosoft/
    ├── PromoSoftConfig.js            Reads PROMOSOFT_* env vars (no credentials)
    ├── PromoSoftSipClient.js         SIP stack wrapper (stubs — pending integration)
    ├── PromoSoftEventNormalizer.js   Maps SIP events → normalised LabelGateway events
    └── PromoSoftErrors.js            AdapterNotReadyError · PromoSoftSipError · PromoSoftLoginError
```

---

## SIP stack candidates

When integrating the real SIP client, choose one of:

| Library | Notes |
|---|---|
| **sip.js** (`sip.js`) | Mature, well-documented; supports Node.js (headless) + browser. Recommended. |
| **JsSIP** (`jssip`) | Alternative; smaller API surface; good WebSocket transport support. |
| **node-sip** (`sip`) | Low-level SIP parser/stack; maximum control but more boilerplate. |
| **drachtio** | Server-side SIP with FreeSWITCH; overkill for a simple UA. |

Install: `npm install sip.js` (or equivalent), then replace the TODO stubs in `PromoSoftSipClient.js`.

---

## Replacing a stub

Each stub method in `PromoSoftSipClient.js` and `PromoSoftAdapter.js` contains a
`// TODO:` block showing exactly what to fill in. Search for `TODO` in either file
to see all pending integration points:

```bash
grep -n "TODO" src/adapters/PromoSoftAdapter.js
grep -n "TODO" src/adapters/promosoft/PromoSoftSipClient.js
grep -n "TODO" src/adapters/promosoft/PromoSoftEventNormalizer.js
```

The normalizer's `SIP_EVENT_MAP` must be populated with the actual state/event names
exposed by the chosen SIP library before call events will flow through correctly.
