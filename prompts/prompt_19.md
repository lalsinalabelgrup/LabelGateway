We need to implement the Mute feature for the LabelPhone product.

You are running from the LabelGateway workspace, but you have access to both repositories:

- LabelGateway
- LabelPhone

Treat this as one product-level feature spanning both repositories.

The implementation must preserve the current architecture and avoid unnecessary backend or SIP changes.

==================================================
FEATURE OBJECTIVE
==================================================

Implement a reliable microphone mute/unmute control during an active call.

When the user presses Mute:

- The remote party must stop receiving microphone audio.
- LabelPhone must continue receiving and playing remote audio.
- The SIP call must remain active.
- The RTP session must remain stable.
- The button must clearly show that mute is active.

When the user presses Mute again:

- Microphone transmission must resume immediately.
- The existing call and RTP session must continue without renegotiation.
- The button must return to its normal visual state.

==================================================
IMPORTANT ARCHITECTURAL DECISION
==================================================

Before implementing anything, inspect the current audio path in both repositories.

Expected architecture:

Microphone
→ LabelPhone AudioManager
→ G.711 encoding
→ WebSocket binary audio
→ LabelGateway
→ RTP
→ Remote party

For ordinary microphone mute, the preferred implementation is local audio suppression in LabelPhone.

Do not add SIP signalling, re-INVITE, SDP changes or provider-specific mute commands unless the current architecture proves that they are genuinely required.

Mute is not Hold.

The expected behaviour is:

- Stop sending microphone audio frames from LabelPhone.
- Continue receiving remote WebSocket/RTP audio.
- Keep the call state unchanged.
- Keep the microphone/audio pipeline initialized so unmute is immediate.

LabelGateway should normally not require telephony-provider changes for mute.

However, inspect the existing WebSocket protocol and audio implementation before deciding.

==================================================
BRANCHING
==================================================

Create a feature branch in each repository from its current updated main branch.

Use the same branch name in both repositories:

feature/mute-control

Before creating branches:

1. Confirm the working tree is clean.
2. Switch to main.
3. Pull the latest origin/main.
4. Create feature/mute-control.
5. Do not merge or push to main.

Do not discard existing local changes without reporting them.

==================================================
PHASE 1 — INSPECT THE CURRENT IMPLEMENTATION
==================================================

Before modifying code, inspect the real implementation.

In LabelPhone, identify:

- The active-call Mute button.
- Its DOM element and current event handler.
- Current call-state rendering.
- The AudioManager or equivalent microphone capture service.
- Where microphone PCM frames are generated.
- Where PCM is resampled to 8 kHz.
- Where G.711 A-law or μ-law encoding occurs.
- Where binary audio frames are sent to LabelGateway.
- How audio starts and stops on answered/ended/failed calls.
- Whether mute-related state already exists.
- Whether microphone tracks are disabled anywhere.
- Whether the button currently has mock-only behaviour.

Likely relevant files include, but are not limited to:

- LabelPhone/index.html
- LabelPhone/js/app.js
- LabelPhone/js/services/audioManager.js
- LabelPhone/js/services/telephonyGatewayClient.js
- LabelPhone/css/styles.css

Use the actual project structure rather than assuming these filenames are unchanged.

In LabelGateway, identify:

- WebSocket binary audio handling.
- How audio frames are forwarded to the provider/RTP layer.
- Whether any existing mute command exists.
- Whether the gateway currently needs to know the mute state.
- Whether audio statistics would be affected by silence or missing frames.

Likely relevant files include:

- WebSocket server/controller
- PromoSoft adapter/client
- RTP audio bridge
- Provider abstraction

Do not modify the gateway unless there is a demonstrated architectural need.

==================================================
PHASE 2 — DEFINE MUTE STATE
==================================================

Use one authoritative mute state in LabelPhone.

Suggested state:

isMuted: boolean

Do not create duplicate mute states in multiple components.

The state must belong to the active call/audio lifecycle, not to an unrelated UI-only variable.

Initial state:

false

Mute may only be active while a call is answered/active.

Reset mute to false when:

- A call ends.
- A call fails.
- A call is missed.
- The remote party hangs up.
- The user hangs up.
- The gateway disconnects.
- Audio is stopped or reset.
- A new call starts.

A new call must never inherit the previous call's mute state.

==================================================
PHASE 3 — AUDIO BEHAVIOUR
==================================================

Implement mute in the smallest reliable place in the outgoing audio pipeline.

Preferred behaviour:

- Keep microphone permission and capture active.
- Keep the audio context alive.
- Keep remote audio playback active.
- Prevent microphone audio frames from being transmitted while muted.

Possible implementation options, in preferred order:

1. Suppress outgoing encoded frames before calling sendAudioFrame().
2. Suppress outgoing PCM frames before encoding.
3. Replace outgoing frames with encoded silence only if continuous packet timing is required by the current gateway/RTP implementation.

First inspect the gateway behaviour before choosing between:

- Sending no WebSocket microphone frames while muted.
- Sending valid G.711 silence frames at the existing 20 ms cadence.

Do not guess.

Check whether LabelGateway's RTP pacing:

- Generates RTP only when browser frames arrive.
- Maintains its own queue and cadence.
- Requires continuous frames to avoid underflow.
- Already inserts silence on missing audio.

Recommended telephony behaviour:

- Maintain continuous RTP timing if the current implementation depends on it.
- Use valid codec silence rather than closing or restarting the RTP stream.
- Do not send arbitrary zero bytes unless zero is confirmed to represent silence for the negotiated codec.

For PCMA/G.711 A-law, use the codec's correct encoded silence value or reuse an existing silence-frame helper.

For PCMU, handle its correct silence value if PCMU is still supported.

Centralize silence-frame generation if required.

==================================================
DO NOT IMPLEMENT MUTE BY
==================================================

Do not:

- Stop the entire AudioManager.
- Close the AudioContext.
- Stop remote audio playback.
- End the microphone MediaStream unless unavoidable.
- Renegotiate SIP.
- Send hold SDP.
- Pause or terminate the RTP session.
- Disconnect the WebSocket.
- Change the call state to Hold.
- Modify provider registration.
- Use browser volume controls to mute incoming audio.

Mute must only affect the caller's outgoing microphone audio.

==================================================
PHASE 4 — USER INTERFACE
==================================================

Reuse the existing Mute control in the active-call screen.

Do not redesign the active-call layout.

The Mute button must support these visual states:

Unmuted:

- Existing/default button appearance.
- Existing microphone icon.
- Label: Mute or the existing localized text.

Muted:

- Clearly highlighted active state.
- Use the application's existing active/destructive visual language.
- Prefer a crossed-out microphone icon if the icon library already supports it.
- Keep the label understandable.
- Add an accessible pressed state.

Do not introduce a new icon library.

Use existing CSS variables, components and UI guidelines.

Recommended accessibility behaviour:

- `aria-pressed="false"` when unmuted.
- `aria-pressed="true"` when muted.
- Update `aria-label` appropriately.
- Keep keyboard activation working.
- Preserve visible focus styles.

==================================================
BUTTON AVAILABILITY
==================================================

The Mute button must be disabled when:

- There is no active call.
- The call is ringing but not answered.
- The call has ended.
- Audio has not started.
- The application is disconnected from the gateway.

The button becomes enabled only when the call is active and microphone audio is available.

Reuse the current call state.

Do not create a second call-state model.

==================================================
PHASE 5 — AUDIO MANAGER API
==================================================

Expose a clean API from the audio layer.

Suggested shape:

audioManager.setMuted(boolean)
audioManager.toggleMuted()
audioManager.isMuted()

or an equivalent API consistent with the current code style.

The UI must not directly manipulate internal MediaStream tracks or encoder variables.

The AudioManager should own outgoing-audio mute behaviour.

The UI should:

1. Request the mute state change.
2. Update from the resulting authoritative state.
3. Render the button consistently.

Avoid scattering mute checks throughout the application.

==================================================
PHASE 6 — LABELGATEWAY RESPONSIBILITY
==================================================

After inspection, decide whether LabelGateway needs any code change.

Expected result:

- No SIP/provider changes.
- Possibly no gateway change at all.

If LabelPhone sends no frames while muted and LabelGateway already handles missing frames correctly, document that no gateway code was needed.

If continuous RTP is required and silence insertion belongs in LabelGateway, implement it generically in the audio/RTP bridge.

Any gateway implementation must remain provider-agnostic.

Do not add mute logic only to PromoSoftAdapter unless the provider genuinely requires signalling, which is not expected for local microphone mute.

Do not send a new JSON mute command merely for UI state synchronization unless the gateway needs it functionally.

==================================================
PHASE 7 — STATE SYNCHRONIZATION
==================================================

The button and the audio pipeline must never disagree.

Examples of invalid states:

- UI says Muted but microphone frames are still sent.
- UI says Unmuted but outgoing frames are suppressed.
- Call ends but the next call starts muted.
- Gateway reconnects and the stale mute button remains active.

Use one state-change path.

Avoid optimistic UI changes that are not applied to the audio layer.

If `setMuted()` can fail, handle the error and restore the correct UI state.

==================================================
PHASE 8 — LOGGING AND DIAGNOSTICS
==================================================

Add concise diagnostic logging consistent with the project's current logging style.

LabelPhone examples:

[AUDIO MUTE] enabled
[AUDIO MUTE] disabled
[AUDIO MUTE] reset on call end

Do not log every muted audio frame.

Do not flood the console.

If silence frames are generated, expose useful counters through the existing audio debug object, if one exists:

- muted
- outgoingFramesSuppressed
- silenceFramesSent

Keep diagnostics optional and lightweight.

Do not log credentials, phone numbers unnecessarily or raw audio.

==================================================
PHASE 9 — TEST SCENARIOS
==================================================

Test with a real active call where possible.

Mandatory scenarios:

1. Outgoing call answered:
   - Remote audio is heard.
   - Press Mute.
   - Remote party can no longer hear the LabelPhone microphone.
   - LabelPhone continues hearing the remote party.
   - Call remains active.
   - Press Mute again.
   - Remote party hears the microphone again immediately.

2. Incoming call answered:
   - Repeat the same mute/unmute validation.

3. Repeated toggling:
   - Toggle mute/unmute at least 10 times.
   - No audio pipeline restart.
   - No RTP interruption.
   - No duplicated audio.
   - No exception.

4. Hang up while muted:
   - Call ends normally.
   - Mute state resets.
   - Next call starts unmuted.

5. Remote hangup while muted:
   - State resets.
   - UI returns to idle correctly.

6. Gateway disconnect while muted:
   - Mute resets safely.
   - Button becomes disabled.

7. Call ringing:
   - Mute button remains disabled.

8. Hold interaction:
   - If Hold is not implemented yet, ensure mute changes do not create a fake Hold state.
   - Leave the code ready for a future independent Hold state.

9. Desktop/Embedded layout:
   - Button active state does not alter layout dimensions.
   - No clipping at small iframe sizes.

10. Mobile and Compact modes:

- Existing layouts remain usable.
- No visual regression.

==================================================
AUDIO VERIFICATION
==================================================

Do not validate mute only by checking the button.

Verify the actual outgoing audio flow.

At minimum, use one or more of:

- Existing `[AUDIO WS OUT]` counters.
- Gateway RTP transmission metrics.
- A real remote endpoint.
- Controlled microphone tone/test signal.
- Encoded frame inspection.

When muted, confirm the chosen expected behaviour:

A. Frame suppression:

- Browser outgoing frame counter stops.
- Gateway remains stable.

or

B. Silence substitution:

- Frame cadence continues.
- Encoded frames contain valid silence.
- Remote endpoint receives silence.

When unmuted:

- Real microphone frames resume.
- No burst of queued old audio is sent.
- No delayed buffered speech is played to the remote party.

Discard microphone audio while muted; never queue it for later transmission.

==================================================
AUTOMATED TESTS
==================================================

Add focused tests where the project structure supports them.

At minimum cover:

- Initial mute state is false.
- `setMuted(true)` suppresses or replaces outgoing microphone frames.
- Incoming audio remains unaffected.
- `setMuted(false)` restores outgoing audio.
- Call-end cleanup resets mute.
- Repeated toggling is idempotent.
- UI button state follows the audio state.

Do not introduce a large testing framework solely for this task.

Use existing test infrastructure.

==================================================
BACKWARD COMPATIBILITY
==================================================

Preserve:

- Existing registration.
- Outgoing calls.
- Incoming calls.
- Hangup.
- CANCEL while ringing.
- RTP pacing.
- PCMA/PCMU negotiation.
- Contact calling.
- Embedded/Desktop responsiveness.
- Mobile and Compact modes.

Do not change codec negotiation or SDP.

==================================================
DOCUMENTATION
==================================================

Update relevant internal documentation if the project maintains feature or architecture documents.

Document:

- Mute is a local outgoing-audio action.
- It is independent from SIP Hold.
- Whether silence frames or frame suppression are used.
- Which repository owns the mute state.
- Whether LabelGateway required changes.

Keep documentation concise.

==================================================
IMPLEMENTATION DISCIPLINE
==================================================

Before editing:

1. Inspect both repositories.
2. Explain the current audio path.
3. State whether LabelGateway changes are required.
4. Identify the exact files expected to change.

Then implement.

After implementation:

1. Review the complete git diff in both repositories.
2. Remove temporary debug code.
3. Run existing tests.
4. Perform real or simulated audio verification.
5. Confirm both working trees contain only mute-related changes.

Do not commit automatically unless explicitly requested.

==================================================
EXPECTED RESULT
==================================================

During an active call, the user can press Mute and immediately stop sending microphone audio to the remote party.

The user continues hearing the remote party.

The SIP call and RTP session remain stable.

Pressing Mute again restores microphone transmission immediately.

The UI clearly reflects the actual mute state.

The state resets safely when the call ends.

The implementation remains clean, provider-independent and ready to coexist with the future Hold and Transfer features.

==================================================
FINAL REPORT
==================================================

Provide:

1. Current audio path found in the code.
2. Exact mute implementation chosen:
   - frame suppression, or
   - valid codec silence substitution.
3. Why that implementation is correct for the existing RTP bridge.
4. Whether LabelGateway required changes and why.
5. Exact files modified in LabelPhone.
6. Exact files modified in LabelGateway.
7. Tests performed.
8. Real audio verification result.
9. Confirmation that remote audio remains audible while muted.
10. Confirmation that the next call starts unmuted.
11. Any limitations or follow-up recommendations.

Do not claim the feature works unless the outgoing audio behaviour was actually verified.
