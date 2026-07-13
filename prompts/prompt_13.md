We have identified the concrete root cause of the outbound static audio.

Do not perform another broad audio investigation. Apply a focused fix.

The faulty file is:

```text
LabelPhone/js/audio/g711.js
```

The current `linearToAlawSample(sample)` implementation does not produce standard G.711 A-law/PCMA bytes.

The decoder `alawToLinearSample()` appears correct, which explains why inbound audio works, while outbound audio produces static.

Reference comparisons show the current encoder is wrong:

```text
PCM16       Current output     Correct PCMA
0           0xD5               0xD5
100         0xD9               0xD3
1000        0xD8               0xFA
5000        0xCD               0x86
10000       0xFD               0xB6
30000       0xE1               0xA8
32767       0xE8               0xAA
```

The current problematic logic includes:

```js
const seg = searchSeg(sample >> 4);

aval = (seg << 4) | ((sample >> (seg + 3)) & 0x0f);
```

Replace `linearToAlawSample()` with a known-correct standard G.711 A-law encoder.

Use this implementation:

```js
function linearToAlawSample(sample) {
  let pcm = sample | 0;
  let mask;

  if (pcm >= 0) {
    mask = 0xd5;
  } else {
    mask = 0x55;
    pcm = -pcm - 1;
  }

  if (pcm > 32635) {
    pcm = 32635;
  }

  let seg;

  if (pcm >= 256) {
    seg = 1;

    let value = pcm >> 8;
    while (value > 1) {
      seg++;
      value >>= 1;
    }

    const aval = (seg << 4) | ((pcm >> (seg + 3)) & 0x0f);

    return (aval ^ mask) & 0xff;
  }

  return ((pcm >> 4) ^ mask) & 0xff;
}
```

Before accepting the implementation, verify it against deterministic vectors.

Required encoding results:

```js
linearToAlawSample(0) === 0xd5;
linearToAlawSample(1) === 0xd5;
linearToAlawSample(-1) === 0x55;
linearToAlawSample(100) === 0xd3;
linearToAlawSample(-100) === 0x53;
linearToAlawSample(1000) === 0xfa;
linearToAlawSample(-1000) === 0x7a;
linearToAlawSample(5000) === 0x86;
linearToAlawSample(-5000) === 0x06;
linearToAlawSample(10000) === 0xb6;
linearToAlawSample(-10000) === 0x36;
linearToAlawSample(30000) === 0xa8;
linearToAlawSample(-30000) === 0x28;
linearToAlawSample(32767) === 0xaa;
linearToAlawSample(-32768) === 0x2a;
```

Also verify encode/decode round trips using the existing `alawToLinearSample()` function.

Expected decoded values include approximately:

```text
0xD5 -> 8
0x55 -> -8
0xFA -> 1008
0x7A -> -1008
0x86 -> 4992
0x06 -> -4992
0xAA -> 32256
0x2A -> -32256
```

Keep the public API unchanged:

```js
g711.alawEncode(floatSamples);
g711.alawDecode(alawBytes);
```

Do not modify:

- SIP REGISTER
- SDP negotiation
- RTP destination
- RTP sequence/timestamp logic
- WebSocket binary transport
- inbound RTP playback
- call state logic
- BYE, ACK or CANCEL

After correcting the encoder, run syntax checks and report:

1. the exact defect in the previous encoder;
2. the new deterministic test results;
3. the files changed;
4. whether any unrelated code was modified.

There is also a secondary potential quality issue in `audioManager.js`: `_resampleLinear()` resets its source position for every ScriptProcessor callback. Do not change that yet unless required. First test the corrected A-law encoder against the real PBX.
