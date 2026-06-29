# B2Com Adapter — Integration Guide

This document describes the B2Com provider adapter for LabelGateway.

**Current status:** Skeleton. All structural code is in place; call-control methods
return controlled errors until B2Com API documentation is available and credentials
are configured.

---

## Purpose

`B2ComAdapter` bridges LabelGateway's normalized telephony interface with the B2Com
provider APIs (REST + WebSocket). When `TELEPHONY_PROVIDER=b2com`, LabelGateway
routes all telephony commands to B2ComAdapter instead of MockAdapter.

LabelPhone is **not aware** of the adapter — it speaks the same normalized event
language regardless of provider.

---

## File structure

```
src/adapters/
├── B2ComAdapter.js           Main adapter (extends BaseTelephonyAdapter)
└── b2com/
    ├── B2ComConfig.js        Reads credentials from env — no Zod, all optional
    ├── B2ComErrors.js        AdapterNotReadyError, B2ComApiError, B2ComWsError
    ├── B2ComHttpClient.js    REST client (Node 18+ fetch, no extra deps)
    ├── B2ComWsClient.js      WebSocket client (ws library)
    └── B2ComEventNormalizer.js  Raw B2Com events → normalized LabelGateway format
```

---

## Environment variables

Copy `.env.example` to `.env` and fill in the B2Com section.

| Variable | Required | Description |
|---|---|---|
| `TELEPHONY_PROVIDER` | Yes | `mock` (default) or `b2com` |
| `B2COM_BASE_URL` | Yes* | B2Com REST API base URL |
| `B2COM_WS_URL` | Yes* | B2Com real-time WebSocket URL |
| `B2COM_WEBRTC_URL` | Future | WebRTC signalling URL (not used by server-side adapter) |
| `B2COM_TOKEN` | Yes* (or user+pass) | Bearer token for API authentication |
| `B2COM_CLIENT_ID` | Optional | OAuth client ID if required |
| `B2COM_USERNAME` | Yes* (or token) | Username for basic auth |
| `B2COM_PASSWORD` | Yes* (or token) | Password for basic auth |
| `B2COM_DOMAIN` | Optional | SIP domain |
| `B2COM_EXTENSION` | Optional | Extension number shown in LabelPhone |
| `B2COM_TURN_URL` | Future | TURN server URL for WebRTC |
| `B2COM_TURN_USERNAME` | Future | TURN username |
| `B2COM_TURN_PASSWORD` | Future | TURN credential |
| `B2COM_DEBUG` | Optional | `true` to log every HTTP request/response and WS frame |

\* Required for the adapter to attempt a connection. If absent, the server starts
but all telephony operations return a controlled `AdapterNotReadyError`.

---

## Pending credentials

No B2Com credentials are available as of this writing. When credentials are
obtained:

1. Set `B2COM_BASE_URL`, `B2COM_WS_URL`
2. Set either `B2COM_TOKEN` or `B2COM_USERNAME` + `B2COM_PASSWORD`
3. Set `TELEPHONY_PROVIDER=b2com` in `.env`
4. Set `B2COM_DEBUG=true` initially to verify traffic
5. Start with `npm start` and monitor logs

---

## Pending endpoint verification

The following REST endpoints are assumed based on typical telephony API patterns.
**None are confirmed** — verify against the B2Com API documentation when available
and uncomment the corresponding stubs in `B2ComHttpClient.js` and `B2ComAdapter.js`.

| Operation | Assumed endpoint | Status |
|---|---|---|
| Login / auth | `POST /api/auth/login` | Pending |
| Logout | `POST /api/auth/logout` | Pending |
| Initiate call | `POST /api/calls` | Pending |
| Answer call | `PUT /api/calls/{id}/answer` | Pending |
| Reject call | `PUT /api/calls/{id}/reject` | Pending |
| Hang up | `DELETE /api/calls/{id}` | Pending |
| Hold | `PUT /api/calls/{id}/hold` | Pending |
| Resume | `PUT /api/calls/{id}/unhold` | Pending |
| Transfer | `POST /api/calls/{id}/transfer` | Pending |
| Send DTMF | `POST /api/calls/{id}/dtmf` | Pending |
| Get contacts | `GET /api/contacts` | Pending |
| Get history | `GET /api/calls/history` | Pending |

---

## Event mapping table

### B2Com → LabelGateway normalized events

All event name keys in `B2ComEventNormalizer.EVENT_MAP` are currently commented
out (placeholders). Fill in the left column with real B2Com event type strings
when the WS API documentation is available.

| B2Com event (raw) | Normalized event | callId | Notes |
|---|---|---|---|
| _(pending)_ | `registered` | — | Extension registered with B2Com |
| _(pending)_ | `unregistered` | — | Extension unregistered |
| _(pending)_ | `registrationFailed` | — | Registration error |
| _(pending)_ | `presenceChanged` | — | User presence update |
| _(pending)_ | `incomingCall` | ✓ new | New callId minted by normalizer |
| _(pending)_ | `outgoingCall` | ✓ new | New callId minted by normalizer |
| _(pending)_ | `ringing` | ✓ existing | Mapped via providerCallId |
| _(pending)_ | `answered` | ✓ existing | |
| _(pending)_ | `held` | ✓ existing | |
| _(pending)_ | `resumed` | ✓ existing | |
| _(pending)_ | `ended` | ✓ existing | callId removed from map after |
| _(pending)_ | `transferred` | ✓ existing | callId removed from map after |
| _(pending)_ | `dtmf` | ✓ existing | |
| _(pending)_ | `error` | — | |

### callId ownership

LabelGateway generates its own internal callId (format `call-{timestamp}`) when a
call-creation event arrives. The B2Com provider identifier (`providerCallId`) is
stored inside `payload.provider.providerCallId` so LabelPhone never has to deal
with B2Com internals.

```json
{
  "event":     "incomingCall",
  "callId":    "call-1751200000000",
  "timestamp": "2026-06-29T10:00:00.000Z",
  "payload": {
    "number":  "+34 611 100 001",
    "contact": null,
    "provider": {
      "name":           "b2com",
      "providerCallId": "b2com-abc-xyz",
      "raw":            { ... }
    }
  }
}
```

---

## Commands mapping table

| LabelGateway command | B2Com operation | Status |
|---|---|---|
| `call` | REST: initiate outbound call | Pending |
| `answer` | REST: answer incoming call | Pending |
| `reject` | REST: reject incoming call | Pending |
| `hangup` | REST: end call | Pending |
| `hold` | REST: hold call | Pending |
| `resume` | REST: resume call | Pending |
| `mute` | REST or WebRTC (TBD) | Pending |
| `unmute` | REST or WebRTC (TBD) | Pending |
| `setSpeaker` | WebRTC client-side only | N/A |
| `transfer` | REST: blind/attended transfer | Pending |
| `sendDTMF` | REST or WS (TBD) | Pending |
| `getContacts` | REST: contact list | Pending |
| `getHistory` | REST: call history | Pending |
| `simulateIncomingCall` | Not supported (mock only) | N/A |

---

## Limitations

- **No real B2Com API calls are made** — all methods throw `AdapterNotReadyError`
  (HTTP 200 with `{ "error": "ADAPTER_NOT_READY", ... }` in the WS response).
- **WebRTC** is out of scope for the server-side adapter. Mute, unmute, and speaker
  control may need to be handled client-side in LabelPhone via WebRTC track APIs
  once the full integration is understood.
- **Reconnect** is not yet implemented in `B2ComWsClient`. If the B2Com WS drops,
  the adapter stays disconnected until the LabelPhone client reconnects to
  LabelGateway (which creates a fresh adapter instance).
- **Contact resolution** in events: `B2ComEventNormalizer._buildPayload` sets
  `contact: null` for all events. A contact lookup step needs to be added once
  `getContacts()` is implemented.
- **Authentication flow**: The exact B2Com WS auth handshake is unknown. A
  placeholder TODO is in `B2ComWsClient.connect()` at the `once('open')` handler.
- **TELEPHONY_PROVIDER vs ADAPTER**: Both `TELEPHONY_PROVIDER` and `ADAPTER` env
  vars are recognised. `TELEPHONY_PROVIDER` is the preferred key; `ADAPTER` is
  kept for backward compatibility. They are read independently — set both to the
  same value in `.env`.

---

## Development workflow (once credentials are available)

1. `cp .env.example .env` and fill in B2Com credentials
2. `TELEPHONY_PROVIDER=b2com B2COM_DEBUG=true npm start`
3. Open LabelPhone with `mode: 'real'` and watch LabelGateway logs
4. Implement methods one at a time: start with `connect()` / registration,
   then `call()` / `hangup()`, then the rest
5. Update `EVENT_MAP` in `B2ComEventNormalizer.js` as real B2Com event names are confirmed
6. Uncomment endpoint stubs in `B2ComHttpClient.js` as paths are verified
7. Add integration tests alongside each implemented method
