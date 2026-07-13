Your stage-by-stage trace is useful, but the conclusion is not yet supported by the real test results.

The corrected encoder was reportedly tested against the PBX, and the audible symptom remained exactly unchanged.

Therefore, one of these must be true:

1. the corrected encoder was not actually loaded by the browser;
2. the diagnosis that the encoder is the primary cause is wrong;
3. another defect produces the same static independently of the encoder.

Before assigning 90% probability to the encoder again, verify which code is actually executing.

Please do the following without making further speculative fixes:

1. Confirm the source currently on disk

Show the exact current implementation of:

```text
LabelPhone/js/audio/g711.js
```

and confirm that the old code is no longer present:

```js
const seg = searchSeg(sample >> 4);
aval = (seg << 4) | ((sample >> (seg + 3)) & 0x0f);
```

2. Prove that the corrected file is loaded in the browser

Add a temporary version marker at module load:

```js
console.log("[G711] corrected encoder loaded - build 2");
```

Add a one-time marker inside `alawEncode()`:

```js
console.log("[G711] corrected encoder used for first microphone frame");
```

Also add cache-busting query parameters in `index.html`:

```html
<script src="js/audio/g711.js?v=2"></script>
<script src="js/services/audioManager.js?v=2"></script>
```

3. Add actual signal-content diagnostics

The existing diagnostics only prove frame lengths and transport. They do not prove that microphone samples or encoded bytes contain valid speech.

For approximately every 50 frames, log:

```text
[AUDIO RAW]
min
max
rms
inputSampleRate

[AUDIO ALAW]
uniqueByteCount
first16Bytes
```

Expected while speaking:

- raw min and max must be meaningfully different from zero;
- RMS must be greater than silence/noise-floor level;
- A-law uniqueByteCount must be significantly greater than 1;
- first16Bytes must change while speaking.

4. Add a controlled transport test

Generate two separate temporary RTP test sources:

A. PCMA silence:

```text
160 bytes of 0xD5
```

The remote phone should hear silence, not static.

B. A precomputed standard PCMA 440 Hz tone:

Generate the tone offline or with independently verified standard G.711 code, then send those fixed 160-byte frames directly from LabelGateway, bypassing:

- microphone;
- browser resampler;
- browser encoder;
- WebSocket.

Interpretation:

- If PCMA silence sounds like static, the RTP payload type/negotiation/telephone path is not what the code assumes.
- If silence is silent but the server-generated tone is static, RTP payload interpretation or the test encoder is wrong.
- If the server-generated tone is correct but browser microphone remains static, the fault is before the backend RTP layer.
- If the browser logs show no meaningful raw signal, the microphone capture path is wrong.
- If browser raw signal is valid but encoded bytes are invalid, the browser encoder/conversion is wrong.
- If encoded bytes are valid in the browser but differ on the backend, transport is corrupting them.

5. Recalculate probabilities using real observations

Do not continue treating the old encoder defect as the primary cause solely because it could theoretically produce static.

The unchanged result after the alleged fix is evidence that must be incorporated into the diagnosis.

Do not modify unrelated SIP or call-control code.
