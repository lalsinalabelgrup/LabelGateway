Yes, implement A and B first, but do it as a controlled and measurable change.

The diagnosis is convincing, especially the measurable outbound queue underruns and the browser delivering audio in approximately 85 ms bursts.

Please proceed with the following scope.

## 1. Replace ScriptProcessorNode with AudioWorkletNode

Implement AudioWorkletNode as the primary microphone capture path.

Requirements:

- Keep ScriptProcessorNode only as a compatibility fallback.
- Do not break the existing microphone permission flow.
- Do not change SIP signalling, SDP or codec negotiation.
- Keep the current PCMA RTP payload format.
- AudioWorklet must produce small and regular audio chunks.
- Preserve streaming state across worklet messages.
- Avoid allocating unnecessary arrays or buffers in the real-time callback.
- Do not perform expensive logging inside the AudioWorklet processor.
- Confirm that microphone start, stop, mute, call end and reconnection remain idempotent.

Document the real callback cadence before and after the change.

## 2. Increase and redesign the RTP queue priming buffer

Increase RTP_AUDIO_QUEUE_START_FRAMES conservatively.

Start with a configurable value equivalent to approximately 160–240 ms, not a hard-coded unexplained number.

For example:

- 8 frames = 160 ms
- 10 frames = 200 ms
- 12 frames = 240 ms

Select a reasonable default and explain the latency trade-off.

The queue should not start sending RTP until the configured priming threshold is reached.

Once transmission has started, do not repeatedly wait for the full priming threshold after every minor underrun. Define a separate recovery threshold if necessary.

Add safeguards so the queue cannot grow indefinitely.

Track and log:

- current queue depth;
- minimum queue depth;
- maximum queue depth;
- average queue depth;
- queue underrun count;
- queue overflow or dropped-frame count;
- number of inserted concealment frames.

## 3. Replace hard-silence underrun substitution

Do not insert an abrupt full-silence frame immediately when the outbound queue is empty.

Implement a simple and safe packet-loss concealment strategy suitable for G.711.

Preferred initial strategy:

- retain the last valid PCM frame before G.711 encoding, if available;
- progressively attenuate repeated samples across consecutive underruns;
- use the attenuated frame for a very small number of missing frames;
- transition to encoded silence if the underrun continues for too long.

Do not repeat an unattenuated voiced frame indefinitely, because that would create a buzzing or robotic repetition.

Reset the concealment state as soon as real audio resumes.

Make the maximum concealment duration configurable and conservative.

If working only with already encoded PCMA frames is safer in the current architecture, implement the fade in the PCM domain before encoding rather than applying arbitrary scaling to A-law bytes.

## 4. Preserve RTP correctness

Do not change:

- RTP clock rate: 8000 Hz;
- frame duration: 20 ms;
- payload size: 160 bytes for PCMA;
- timestamp increment: 160;
- sequence-number increment: 1;
- SSRC during a call.

Even when a concealment frame is generated, sequence number and RTP timestamp must continue normally.

## 5. Improve measurements

Before making conclusions, capture a baseline from the current implementation and compare it with the updated implementation.

For each PSTN test call, report:

- call duration;
- total RTP packets sent;
- average send interval;
- minimum send interval;
- maximum send interval;
- standard deviation;
- percentage outside 20 ms ±2 ms;
- percentage outside 20 ms ±5 ms;
- queue underruns;
- concealment frames;
- maximum consecutive underruns;
- queue depth percentiles if practical;
- WebSocket audio frame arrival cadence;
- AudioWorklet callback/message cadence.

Use aggregated logs. Avoid logging every RTP packet unless a temporary diagnostic flag is enabled, because excessive logging may itself affect the event loop.

## 6. Inspect event-loop stalls

Add lightweight event-loop delay monitoring around the call.

Correlate large RTP send-spacing deviations with:

- event-loop delay;
- garbage collection if measurable;
- WebSocket receive gaps;
- queue depth;
- synchronous logging or synchronous file operations.

Do not attribute all timing variation to Windows until this correlation has been checked.

## 7. Configuration

Make the relevant values configurable:

- RTP_AUDIO_QUEUE_START_FRAMES;
- RTP_AUDIO_QUEUE_RECOVERY_FRAMES if introduced;
- RTP_AUDIO_QUEUE_MAX_FRAMES;
- RTP_AUDIO_CONCEALMENT_MAX_FRAMES;
- diagnostic logging enabled/disabled.

Provide safe defaults and document each one.

## 8. Testing

After implementation, run or prepare the following tests:

1. LabelPhone to internal 3CX extension.
2. LabelPhone to external PSTN phone.
3. At least one 60-second continuous speech test.
4. A test with short pauses between sentences.
5. Mute and unmute.
6. Call hangup while audio is active.
7. Two sequential calls without reloading the browser.
8. Temporary simulated WebSocket delay or missing audio frames to validate concealment and recovery.

For simulated underruns, confirm that:

- there is no abrupt hard click;
- RTP timestamps remain continuous;
- the queue recovers;
- no stale repeated speech continues after real audio returns.

## 9. Do not implement OPUS yet

Do not implement OPUS in this iteration.

The current measurable faults are local pacing and queue-supply issues. Fix and measure those first.

After A and B are implemented and tested, provide:

- exact files modified;
- explanation of each change;
- before/after metrics;
- remaining limitations;
- whether Windows pacing still appears to be the dominant issue;
- whether a Linux A/B test is justified.

Please implement the changes directly, but keep them narrowly scoped and easy to revert.
