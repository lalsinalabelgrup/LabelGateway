# Fix simulateIncomingCall in real mode

`simulateIncomingCall` in real mode currently rejects locally with an error instead of doing anything useful.

Fix it so that when `telephonyGatewayClient` is in `real` mode and `simulateIncomingCall()` is called, it sends the command over the WebSocket to LabelGateway instead of rejecting.

LabelGateway's `wsServer.js` already routes `simulateIncomingCall` to the adapter. The fix belongs in the client layer — it must forward the command over the wire.
