# Add PromoSoft Adapter skeleton

Create a PromoSoft adapter skeleton for LabelGateway. Work only inside the `LabelGateway/` directory.

## Files to create

```
src/adapters/PromoSoftAdapter.js
src/adapters/promosoft/PromoSoftConfig.js
src/adapters/promosoft/PromoSoftSipClient.js
src/adapters/promosoft/PromoSoftEventNormalizer.js
src/adapters/promosoft/PromoSoftErrors.js
docs/PROMOSOFT_ADAPTER.md
```

## PromoSoftAdapter

- Extends `BaseTelephonyAdapter`
- Constructor receives the `sendEvent` callback
- `connect()` — if SIP server not configured, emits `registrationFailed`; otherwise stays silent waiting for a `login` command
- `login({ extension, password, displayName })` — validates params synchronously; fires SIP REGISTER as a background task; returns `Promise.resolve({})` immediately (fire-and-forget); emits `registered` on success or `registrationFailed` on failure
- `logout()` — unregisters, emits `unregistered`
- `destroy()` — cleans up SIP client
- All call methods — stub that throws `AdapterNotReadyError` if no session; throws `PromoSoftSipError('not yet implemented')` otherwise

## PromoSoftConfig

- Reads: `PROMOSOFT_SIP_SERVER`, `PROMOSOFT_SIP_PORT` (default 5060), `PROMOSOFT_SIP_TRANSPORT` (default `udp`), `PROMOSOFT_SIP_DOMAIN`, `PROMOSOFT_DEBUG`
- `isServerConfigured()` → true when `PROMOSOFT_SIP_SERVER` is set
- `requireServerConfigured()` → throws `AdapterNotReadyError` if not set
- `registrarUri` getter → `sip:<server>:<port>`
- `serverDomain` getter → domain for To/From headers

## PromoSoftSipClient

- Placeholder stub — methods accept params, throw `PromoSoftSipError('not yet implemented')`
- `register({ extension, password })`, `unregister()`, `destroy()`

## PromoSoftEventNormalizer

- `normalize(raw)` → `{ event, callId, timestamp, payload }` or `null`
- Mints new callId for call-create events
- Tracks sipCallId → callId mapping
- Cleans up on call-end events

## PromoSoftErrors

- `AdapterNotReadyError` (code: `ADAPTER_NOT_READY`)
- `PromoSoftSipError` (code: `PROMOSOFT_SIP_ERROR`, has `cause`)
- `PromoSoftLoginError` (code: `PROMOSOFT_LOGIN_ERROR`)

## Update existing files

- `src/config/config.js` — add `'promosoft'` to `ADAPTER` and `TELEPHONY_PROVIDER` enums
- `.env.example` — add all `PROMOSOFT_*` vars with comments
- `src/websocket/wsServer.js` — add `promosoft` case to adapter factory
- `src/adapters/BaseTelephonyAdapter.js` — add `login(_credentials)` and `logout()` stubs

## Security constraints

- Do **not** store extension or password in `.env`
- Do **not** log passwords anywhere
- No provider-specific code outside the `promosoft/` folder
- Mock and B2Com modes must remain working
