# Fix B2Com unconfigured state

When B2Com env vars are missing (no `B2COM_*` credentials in `.env`), `B2ComAdapter.connect()` currently emits `registered({ extension: 'unconfigured' })` instead of signalling a failure.

Fix this so that when B2Com is not configured:

- `connect()` emits `registrationFailed` with a clear message (e.g. `"B2Com credentials not configured"`)
- The server does **not** crash
- The client receives a push event that explains why registration failed
- `registered` is never emitted with a fake or placeholder extension

The mock adapter and all other adapters must remain unaffected.
