# Add VSCode Debug Support

Create `.vscode/launch.json` inside `LabelGateway/` with the following debug configurations for Node.js.

## Configurations

### "Debug LabelGateway"

- Type: `node`
- Entry point: `src/server.js`
- Load `.env` via `envFile: "${workspaceFolder}/.env"`
- Set `NODE_ENV=development`
- No provider override — uses whatever `TELEPHONY_PROVIDER` is in `.env`

### "Debug LabelGateway with PromoSoft"

- Same as above
- Override `TELEPHONY_PROVIDER=promosoft` and `ADAPTER=promosoft` in the `env` block

### "Debug LabelGateway with Mock"

- Same as above
- Override `TELEPHONY_PROVIDER=mock` and `ADAPTER=mock` in the `env` block

## Constraints

- Do **not** put secrets (passwords, API keys, SIP credentials) in `launch.json`
- Use `.env` for all URLs, API keys, and passwords
- Use `skipFiles: ["<node_internals>/**"]`
- Use `console: "integratedTerminal"`

## README update

Add a "Debugging with VSCode" section to `README.md` with these steps:

1. Open the `LabelGateway/` folder in VSCode
2. Copy `.env.example` to `.env` and fill in credentials
3. Open the Run & Debug panel (Ctrl+Shift+D)
4. Pick a debug configuration from the dropdown
5. Press F5 to start

Include a table of recommended breakpoint locations:

| File | Purpose |
|------|---------|
| `src/websocket/wsServer.js` | Command routing |
| `src/adapters/PromoSoftAdapter.js` | Login/register flow |
| `src/adapters/promosoft/PromoSoftSipClient.js` | SIP REGISTER |
| `src/adapters/promosoft/PromoSoftEventNormalizer.js` | Event mapping |
| `src/adapters/B2ComAdapter.js` | B2Com command handling |
