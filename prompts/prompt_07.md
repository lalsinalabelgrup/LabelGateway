# Refactor provider selection — remove it from LabelPhone

LabelPhone must never decide which telephony provider to use.

## Problem

Currently LabelPhone has provider-selection logic in the frontend (a field or config option that picks between mock, b2com, promosoft, etc.). This is wrong:

- Provider configuration belongs exclusively to LabelGateway via the `TELEPHONY_PROVIDER` env var
- The frontend should not need to be changed or redeployed when switching providers
- There must be no provider-specific branching inside LabelPhone

## Changes required

### LabelPhone

- Remove all provider-selection fields, dropdowns, and config keys from LabelPhone
- LabelPhone must not have a provider field in its config, state, or UI
- The only provider information LabelPhone may display is what it reads from `GET /api/status` (for the debug panel)

### LabelGateway `GET /api/status`

- Must include the currently active provider name in its response
- Example: `{ "provider": "mock", "status": "ok" }`

### LabelGateway `README.md`

- Document that provider selection is done exclusively via `TELEPHONY_PROVIDER` env var
- Explain the debug panel flow: LabelPhone → `GET /api/status` → display provider name

## Constraint

Mock mode and B2Com mode must continue to work correctly after this change.
