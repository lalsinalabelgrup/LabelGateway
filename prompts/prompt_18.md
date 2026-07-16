Before running the live PSTN tests, please perform one focused correctness review.

There is a potentially confusing statement in your summary:

- `lastRealFramePcm` is described as containing real A-law data.
- Concealment is described as operating in the PCM domain.

A-law bytes are not linear PCM samples.

Please verify the exact concealment pipeline.

The correct pipeline must be:

1. Receive or retain the last valid 160-byte PCMA frame.
2. Decode each A-law byte to signed linear PCM.
3. Apply progressive attenuation in the linear PCM domain.
4. Clamp samples correctly to the signed PCM range.
5. Re-encode the attenuated PCM samples to A-law.
6. Return exactly 160 bytes of valid PCMA.

Do not attenuate A-law bytes directly.

Please confirm:

- the actual type and content of `lastRealFramePcm`;
- whether its name is misleading;
- whether `_buildConcealmentFrame()` performs a full A-law decode → PCM attenuation → A-law encode cycle;
- that the original stored frame is never mutated;
- that concealment output is always exactly 160 bytes;
- that encoded A-law silence uses the correct byte value for the existing implementation;
- that the first real frame after an underrun immediately resets concealment state.

Also reconsider the default:

`RTP_AUDIO_CONCEALMENT_MAX_FRAMES=10`

Ten frames represent 200 ms and may produce audible robotic repetition. Unless there is a strong reason for 10, use a more conservative initial default of 4 frames, equivalent to 80 ms, while keeping it configurable.

Please also verify the AudioWorklet runtime conditions:

- LabelPhone is being served through HTTP/HTTPS and not `file://`.
- `audioContext.audioWorklet.addModule()` resolves the module URL correctly.
- The module request returns HTTP 200.
- Failure to load the worklet logs a clear warning and activates ScriptProcessorNode fallback.
- The application logs once per call which capture mode is active:
  - `AudioWorklet`
  - `ScriptProcessor fallback`

Do not make broader architectural changes.

After this review, provide the precise environment values recommended for the first test call and the exact log lines that I should capture.
