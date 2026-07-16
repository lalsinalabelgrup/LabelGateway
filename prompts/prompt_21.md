The real Hold / Resume implementation is working correctly against the live PBX.

Hold succeeds, the remote party receives Music On Hold, and Resume restores the call.

However, while the call is held, LabelGateway logs approximately one warning for every incoming browser audio frame:

[AUDIO WS IN BACKEND] pushAudioFrame — no answered call, frame dropped
{"hasCall":true,"status":"held",...}

These warnings continue every ~20 ms until Resume.

This is functionally expected frame rejection, but operationally incorrect logging and unnecessary WebSocket/audio traffic.

We need a small, focused cleanup before closing feature/call-hold.

==================================================
ROOT BEHAVIOUR
==================================================

Current flow while held:

LabelPhone microphone/audio pipeline
→ continues producing and sending binary audio frames
→ LabelGateway receives them
→ PromoSoftAdapter.pushAudioFrame() sees status === "held"
→ drops every frame
→ logs one warning per frame

At a 20 ms audio cadence this can create approximately 50 warning messages per second.

This is not an exceptional condition.

Do not treat expected audio suppression during Hold as a warning-level error.

==================================================
OBJECTIVE
==================================================

While a call is held:

- LabelPhone should stop transmitting microphone audio frames to LabelGateway.
- LabelGateway should still defensively reject any unexpected audio frames.
- Expected dropped frames must not flood the logs.
- Resume must restore outgoing audio immediately.
- Do not stop incoming/outgoing call signalling or destroy the audio engine.
- Do not break Mute.

==================================================
PHASE 1 — INSPECT CURRENT AUDIO STATE FLOW
==================================================

Inspect both repositories and identify:

LabelPhone:

- Where binary microphone frames are sent.
- How Mute currently suppresses or replaces outgoing audio.
- How Hold state reaches app.js / AudioManager.
- Whether AudioManager already knows the call is held.
- Whether Hold currently only changes UI and Gateway state.

LabelGateway:

- PromoSoftAdapter.pushAudioFrame().
- The exact status guard producing the warning.
- Any RTP pacing or silence insertion behaviour.
- Existing rate-limited logging helpers, counters or diagnostics.

Before editing, explain the exact current flow.

==================================================
PHASE 2 — STOP BROWSER AUDIO TRANSMISSION ON HOLD
==================================================

Implement Hold suppression at the LabelPhone audio layer.

Preferred behaviour:

- Keep microphone permission and MediaStream alive.
- Keep AudioContext alive.
- Keep the capture pipeline ready.
- Discard current microphone frames while held.
- Do not queue microphone audio.
- Do not send binary WebSocket audio frames while held.
- Resume transmission immediately when the call returns to answered/active.

Do not stop the entire AudioManager unless the current architecture requires it.

Do not close and recreate the microphone stream for every Hold/Resume cycle.

Expose a clean audio-state API if needed, for example:

audioManager.setHeld(boolean)

or a generalized transmission state consistent with the existing design.

Avoid duplicating call state inside multiple modules.

==================================================
MUTE AND HOLD INDEPENDENCE
==================================================

Mute and Hold are distinct features.

Required behaviour:

Active + unmuted:

- Send microphone audio.

Active + muted:

- Apply the existing Mute behaviour.

Held + unmuted:

- Send no browser microphone frames.

Held + muted:

- Send no browser microphone frames.

Resume while mute is still active:

- Return to the muted behaviour, not unmuted transmission.

Resume while mute is inactive:

- Resume real microphone audio.

Do not reset Mute merely because Hold or Resume occurs.

A useful decision order is conceptually:

if held:
suppress outgoing frames
else if muted:
apply current mute behaviour
else:
send microphone frames

Adapt this to the existing architecture.

==================================================
PHASE 3 — DEFENSIVE GATEWAY GUARD
==================================================

Keep the Gateway status guard.

LabelGateway must still reject browser audio unless the call is in a media-transmitting state.

However, status === "held" is an expected condition, not a warning.

Change logging behaviour so:

- Missing call or invalid call identity may remain warning-level where appropriate.
- Frames received during held state should be silently dropped, counted, or logged only at debug/trace level.
- Do not emit one log entry per frame.

Preferred implementation:

- Return early for held state without warning.
- Optionally increment a lightweight counter.
- Optionally emit one debug message only when transitioning into held state, not per frame.

Do not globally hide genuine audio errors.

==================================================
RATE-LIMIT UNEXPECTED FRAME LOGGING
==================================================

For other non-answered states, inspect whether per-frame warnings could also flood logs during ringing, ending or race conditions.

If useful, add a rate-limited warning strategy:

- At most one warning per call/status every few seconds.
- Include a suppressed-frame count in the next diagnostic message.
- Reset the rate limiter when the call changes or becomes answered.

Keep the implementation small.

Do not introduce a large logging framework.

==================================================
PHASE 4 — INBOUND AUDIO DURING HOLD
==================================================

The previous Hold implementation reportedly added an inbound audio-relay guard to prevent PBX Music On Hold from leaking into LabelPhone.

Verify this remains correct:

- The remote held party may hear PBX MOH.
- LabelPhone should not necessarily hear that MOH unless product requirements say otherwise.
- Incoming RTP during held state must not be forwarded to the browser.
- This expected suppression must also avoid per-frame warning floods.

Do not change the working SIP re-INVITE behaviour.

==================================================
PHASE 5 — STATE RESET
==================================================

Ensure held audio suppression resets correctly on:

- Resume.
- Local hangup.
- Remote BYE.
- Call failure.
- Gateway disconnect.
- New call.
- Application audio reset.

A new call must start with:

held = false

Preserve the current Mute reset semantics.

==================================================
PHASE 6 — TESTS
==================================================

Mandatory real-call tests:

1. Active call:
   - Confirm normal bidirectional audio.

2. Hold:
   - PBX MOH remains functional for the remote party.
   - LabelPhone stops sending binary microphone frames.
   - LabelGateway no longer floods warning logs.
   - SIP dialog remains active.

3. Resume:
   - Microphone audio resumes immediately.
   - No AudioContext or MediaStream recreation delay.
   - No queued speech burst.
   - No RTP regression.

4. Repeated Hold/Resume:
   - Run at least 10 cycles.
   - No increasing memory usage.
   - No duplicate audio handlers.
   - No log flood.

5. Mute → Hold → Resume:
   - Call remains muted after Resume.

6. Hold → Resume while unmuted:
   - Real microphone audio returns.

7. Hangup while held:
   - No continued microphone frames.
   - State clears correctly.

8. Remote hangup while held:
   - State clears correctly.

==================================================
DIAGNOSTIC VERIFICATION
==================================================

Use existing audio counters where possible.

Before Hold:

- Browser outgoing WS audio frames increment normally.

During Hold:

- Browser outgoing WS audio frames stop incrementing, or the send counter remains stable.
- Gateway held-frame-drop warning count remains zero or rate-limited.
- No per-20-ms warning stream.

After Resume:

- Browser outgoing audio frames increment again.
- Remote party hears current live audio.
- No queued historical microphone frames are transmitted.

Do not consider the cleanup complete based only on the absence of logs.

Confirm actual audio transmission behaviour.

==================================================
DO NOT MODIFY
==================================================

Do not modify:

- Working SIP re-INVITE Hold/Resume.
- SDP direction logic.
- CSeq handling.
- Music On Hold generation.
- Registration.
- Transfer.
- Contacts.
- Desktop layout.
- Codec negotiation.
- RTP pacing unless a proven issue is found.

==================================================
FINAL REPORT
==================================================

Provide:

1. Exact reason LabelPhone continued sending audio while held.
2. Exact LabelPhone files modified.
3. Exact LabelGateway files modified.
4. How Hold now suppresses outgoing browser frames.
5. How Mute and Hold state precedence works.
6. How Gateway logging was changed.
7. Whether any rate limiting was added.
8. Real-call Hold/Resume test results.
9. Confirmation that MOH still works.
10. Confirmation that log flooding is gone.
11. Confirmation that audio resumes immediately.
12. Confirmation that Mute remains active across Hold/Resume when applicable.

Do not commit automatically.
