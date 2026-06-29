# Add B2Com Adapter skeleton

Create a B2Com adapter skeleton for LabelGateway.

## Files to create

```
src/adapters/B2ComAdapter.js
src/adapters/b2com/B2ComConfig.js
src/adapters/b2com/B2ComHttpClient.js
src/adapters/b2com/B2ComWsClient.js
src/adapters/b2com/B2ComEventNormalizer.js
src/adapters/b2com/B2ComErrors.js
docs/B2COM_ADAPTER.md
```

## B2ComAdapter

- Extends `BaseTelephonyAdapter`
- Constructor receives the `sendEvent` callback
- `connect()` reads credentials from `B2ComConfig`, opens a WebSocket to B2Com
- All call-control methods are stubs that throw `AdapterNotReadyError` until the API is integrated
- Provider events are forwarded through `B2ComEventNormalizer` → `sendEvent`

## B2ComConfig

- Reads all `B2COM_*` env vars (all optional)
- `isConfigured()` → `true` when base URL + auth token (or username/password) are set
- `requireConfigured()` → throws `AdapterNotReadyError` if not configured

## B2ComEventNormalizer

- `normalize(raw)` → `{ event, callId, timestamp, payload }` or `null`
- Mints a new `call-${Date.now()}` callId for call-create events
- Tracks sipCallId → callId mapping for subsequent events
- Cleans up mapping on call-end events

## B2ComErrors

- `AdapterNotReadyError` — missing credentials or not yet connected
- `B2ComApiError` — failed REST response
- `B2ComWsError` — WebSocket connection failure

## Update existing files

- `src/config/config.js` — add `'b2com'` to `ADAPTER` and `TELEPHONY_PROVIDER` enums
- `.env.example` — add all `B2COM_*` vars with comments
- `src/websocket/wsServer.js` — add `b2com` to the adapter factory

## Documentation

`docs/B2COM_ADAPTER.md` — full reference for the adapter: config, wire format, event map, TODO list.
