# Implement PromoSoft SIP REGISTER

Work only inside `LabelGateway/`. Ignore GucLite / GucRestApi for this task.

Goal: register a SIP extension against a PromoSoft PBX exactly like a softphone does.

## Target PBX

```env
TELEPHONY_PROVIDER=promosoft
PROMOSOFT_SIP_SERVER=prelabel2.guccontactcenter.com
PROMOSOFT_SIP_PORT=5060
PROMOSOFT_SIP_TRANSPORT=udp
PROMOSOFT_SIP_DOMAIN=prelabel2.guccontactcenter.com
PROMOSOFT_STUN_SERVER=stun.3cx.com
```

Extension and password come only from the `login` WebSocket command — never from `.env`.

## SIP library

Use **sip.js** (already selected).

## Success outcome

When registration succeeds, `PromoSoftAdapter` must emit:

```json
{ "event": "registered", "timestamp": "<ISO8601>", "payload": { "extension": "<ext>" } }
```

## Registration flow

1. `PromoSoftAdapter.login({ extension, password })` is called
2. `PromoSoftSipClient.register({ extension, password })` is called (fire-and-forget)
3. SIP REGISTER is sent to the PBX
4. If challenged (401/407): compute digest auth (RFC 2617) and retry
5. If 200 OK: emit `registered({ extension })`
6. If error: emit `registrationFailed({ reason })`

## Re-REGISTER keepalive

Schedule re-REGISTER 60 seconds before expiry (default expiry: 3600 s → re-register at 3540 s).

## OPTIONS ping handling

Many PBXes send periodic OPTIONS and deregister clients that do not reply. Respond with `200 OK` to all inbound OPTIONS.

## NAT traversal

Add `rport` to the Via header (RFC 3581). STUN is not required for the initial implementation; `PROMOSOFT_STUN_SERVER` config var is added for future use.

## Security

- Do not log the password
- Do not store the password outside the SIP client (it is needed only for keepalive re-authentication)
- Clear the session (including password) on `unregister()` and `destroy()`
