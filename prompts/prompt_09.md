# Add login/logout WebSocket commands

LabelPhone sends:

```json
{ "id": "req-login-1", "command": "login", "params": { "extension": "101", "password": "secret" } }
```

LabelGateway responds with: `unknown command: login`

## Fix

Route `login` and `logout` commands through the COMMANDS router to `adapter.login()` / `adapter.logout()`.

### Response

The command reply must be immediate:

```json
{ "id": "req-login-1", "result": { "ok": true } }
```

The actual registration result arrives later as a push event:

```json
{ "event": "registered", "timestamp": "...", "payload": { "extension": "101" } }
```

or

```json
{ "event": "registrationFailed", "timestamp": "...", "payload": { "reason": "..." } }
```

### Adapter behaviour

**MockAdapter:**
- Accept any extension and password
- Emit `registered({ extension })`

**PromoSoftAdapter:**
- Receive extension and password from the `login` command
- Try SIP REGISTER if configured
- Emit `registered` only if verified; otherwise emit `registrationFailed`

**B2ComAdapter:**
- Return a controlled `ADAPTER_NOT_READY` error if not implemented

### Security

- **Never log the password**
- **Never send the password back to the frontend**
- **Do not store extension or password in `.env`**
