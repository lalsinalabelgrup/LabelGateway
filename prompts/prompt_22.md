We are currently working on feature/call-hold.

Hold / Resume and Music On Hold are working correctly in real calls.

However, the Mute button currently shows a message saying that Mute is not implemented.

You are running from the LabelGateway workspace and have access to both repositories:

- LabelGateway
- LabelPhone

Implement Mute again so that Mute and Hold both work together.

==================================================
SAFETY RULES
==================================================

Do not perform any Git history or branch operation.

Do not run:

- git merge
- git cherry-pick
- git rebase
- git reset
- git restore
- git checkout
- git clean
- git stash
- git pull
- git commit
- git push

Remain on the current feature/call-hold branches.

Do not discard or overwrite existing Hold changes.

==================================================
OBJECTIVE
==================================================

Restore a real microphone Mute / Unmute feature.

When Mute is enabled:

- The remote party must stop hearing the LabelPhone microphone.
- LabelPhone must continue hearing the remote party.
- The SIP call must remain active.
- Hold / Resume must continue working.
- The UI must clearly show that Mute is active.

When Mute is disabled:

- Live microphone audio must resume immediately.
- The audio pipeline must not restart unnecessarily.

==================================================
FIRST — INSPECT CURRENT CODE
==================================================

Before editing, inspect both repositories.

In LabelPhone identify:

- The Mute button in index.html.
- Every handler connected to it.
- The code showing the “not implemented” message.
- The AudioManager outgoing microphone pipeline.
- Existing mute-related state or methods.
- The current Hold suppression logic.
- How binary audio frames are sent to LabelGateway.

Likely files include:

- LabelPhone/index.html
- LabelPhone/js/app.js
- LabelPhone/js/ui.js
- LabelPhone/js/services/audioManager.js
- LabelPhone/js/services/telephonyGatewayClient.js

Use the actual project structure.

In LabelGateway inspect:

- Binary audio reception.
- PromoSoftAdapter.pushAudioFrame().
- Current Hold-related audio guards.
- Whether any Gateway change is genuinely required for Mute.

Before modifying anything, state:

1. The exact source of the “not implemented” message.
2. Whether an existing mute implementation still partially exists.
3. Which exact files will need changes.

==================================================
ARCHITECTURE
==================================================

Mute should preferably be implemented in LabelPhone’s outgoing microphone path.

Expected path:

Microphone
→ AudioManager
→ G.711 encoding
→ WebSocket binary frame
→ LabelGateway
→ RTP
→ Remote party

Do not implement Mute with SIP signalling.

Do not use re-INVITE.

Do not reuse Hold.

Mute is a local outgoing-audio action.

LabelGateway should normally not require provider-specific changes.

==================================================
MUTE STATE
==================================================

Use one authoritative Mute state in LabelPhone.

Suggested state:

isMuted

Initial state:

false

Reset Mute to false when:

- The call ends.
- The call fails.
- The remote party hangs up.
- The user hangs up.
- The Gateway disconnects.
- A new call starts.

Do not duplicate mute state across multiple modules.

==================================================
AUDIO BEHAVIOUR
==================================================

Implement Mute in the outgoing audio pipeline.

Preferred behaviour:

- Keep microphone permission active.
- Keep MediaStream active.
- Keep AudioContext active.
- Keep incoming remote audio playback active.
- Suppress or replace outgoing microphone frames while muted.
- Never queue muted microphone audio for later transmission.

Inspect the current RTP bridge before choosing:

A. Stop sending browser audio frames while muted.

or

B. Send valid codec silence frames while muted.

Use the option that best matches the existing audio pacing architecture.

Do not send invalid zero-filled frames unless zero is confirmed as valid silence for the negotiated codec.

==================================================
HOLD AND MUTE INTERACTION
==================================================

Hold and Mute must remain independent.

Required state precedence:

Active + unmuted:

- Send real microphone audio.

Active + muted:

- Apply Mute behaviour.

Held + unmuted:

- Send no browser microphone audio.

Held + muted:

- Send no browser microphone audio.

Resume while muted:

- Return to the muted state.
- Do not expose microphone audio.

Resume while unmuted:

- Resume live microphone audio.

Hold must not reset Mute.

Mute must not trigger Hold.

==================================================
USER INTERFACE
==================================================

Reuse the existing Mute button.

Do not redesign the active-call screen.

Remove or replace the obsolete “not implemented” behaviour.

Button states:

Unmuted:

- Existing normal appearance.
- aria-pressed="false"

Muted:

- Existing active/highlighted appearance.
- Prefer a crossed-out microphone icon if already available.
- aria-pressed="true"

Do not add a new icon library.

The button must only be active during an answered or held call, according to the current UX.

==================================================
AUDIO MANAGER API
==================================================

Expose or restore a clean API consistent with the current code style, for example:

audioManager.setMuted(boolean)
audioManager.toggleMuted()
audioManager.isMuted()

The UI must not directly manipulate internal MediaStream tracks or encoder details.

The AudioManager should own outgoing-audio mute behaviour.

==================================================
LABELGATEWAY
==================================================

Only modify LabelGateway if a real functional need is proven.

Do not add SIP or PromoSoft-specific Mute logic.

Keep the existing Hold guards.

If LabelPhone suppresses outgoing frames correctly, LabelGateway may require no Mute changes.

Document this clearly.

==================================================
TESTS
==================================================

Mandatory real-call tests:

1. Active call → Mute
   - Remote party no longer hears LabelPhone.
   - LabelPhone still hears remote audio.
   - No “not implemented” message.

2. Mute off
   - Remote party hears LabelPhone again immediately.

3. Mute → Hold → Resume
   - Music On Hold still works.
   - After Resume, Mute remains active.
   - Remote party still does not hear LabelPhone.

4. Disable Mute after Resume
   - Microphone audio returns.

5. Hold → Resume → Mute
   - Mute still works normally.

6. Repeated toggling
   - Toggle Mute at least 10 times.
   - No duplicated handlers.
   - No audio pipeline restart.
   - No delayed audio burst.

7. Hang up while muted
   - Next call starts unmuted.

==================================================
DO NOT MODIFY
==================================================

Do not modify the working:

- SIP Hold / Resume.
- re-INVITE logic.
- SDP sendonly / sendrecv.
- Music On Hold.
- CSeq handling.
- RTP pacing.
- Registration.
- Contacts.
- Desktop layout.
- Transfer.

==================================================
IMPLEMENTATION DISCIPLINE
==================================================

Make the smallest reasonable change.

Do not replace entire files.

Do not copy files from another branch.

Do not perform Git history operations.

After implementation:

- Review the complete diff in both repositories.
- Remove temporary debugging.
- Leave all changes uncommitted.
- Confirm only Mute-related files changed.

==================================================
FINAL REPORT
==================================================

Provide:

1. Exact source of the “not implemented” message.
2. Existing mute-related code found.
3. Exact implementation chosen.
4. Exact LabelPhone files modified.
5. Exact LabelGateway files modified.
6. Why Gateway changes were or were not required.
7. Real-call test results.
8. Confirmation that Mute works.
9. Confirmation that Hold / Resume still works.
10. Confirmation that Mute remains active across Hold / Resume.
11. Confirmation that the next call starts unmuted.

Do not commit automatically.
