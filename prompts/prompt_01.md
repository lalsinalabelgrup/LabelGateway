# Rename gatewayClient.js to telephonyGatewayClient.js

Rename `gatewayClient.js` to `telephonyGatewayClient.js`.

Update all references across the codebase so nothing still imports or mentions the old filename.

Document the architecture clearly:

- What `telephonyGatewayClient.js` does and where it lives
- The split between LabelPhone (frontend) and LabelGateway (backend)
- How commands flow from UI → client → gateway → provider adapters

Enforce naming conventions:

- The module must always be referenced as `telephonyGatewayClient` (no abbreviations)
- No other file should contain telephony provider logic

Update config keys where needed to reflect the new naming.

Update the README to match.

Ensure full compatibility — no existing functionality should break.
