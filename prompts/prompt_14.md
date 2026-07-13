We have a real SIP softphone implementation composed of:

- LabelPhone (browser)
- LabelGateway (Node.js)
- A real PBX (PromoSoft/Asterisk compatible)

Current behaviour:

✔ Registration works.
✔ Outbound calls work.
✔ Inbound calls work.
✔ Call establishment is correct.
✔ BYE/CANCEL work correctly.
✔ LabelPhone hears the remote phone perfectly.
✔ The remote phone receives RTP packets from LabelPhone.

The only remaining issue is:

The remote phone does NOT hear the browser microphone.

Instead it hears continuous static/noise.

At this point I do NOT want another speculative fix.

I want a real root-cause investigation.

Assume absolutely nothing.

Please investigate the complete audio pipeline from the browser microphone to the RTP packets actually sent over UDP.

Do not start modifying code immediately.

Instead:

1. Trace every transformation performed on the audio.

For every stage explain:

- input format
- output format
- sample rate
- channel count
- sample size
- frame size
- timing
- ownership of buffers
- any assumptions made

The stages include:

Browser microphone
↓
WebAudio
↓
AudioManager
↓
resampler
↓
PCM conversion
↓
G711 encoder
↓
WebSocket
↓
Node Buffer
↓
PromoSoftAdapter
↓
PromoSoftSipClient
↓
RTP payload
↓
UDP socket

2.

At every stage identify:

- what should happen
- what the current implementation actually does
- any mismatch
- anything suspicious

3.

Look especially for subtle bugs such as:

- wrong typed array
- Buffer offset mistakes
- byte order
- frame alignment
- incorrect timing
- dropped frames
- duplicate frames
- resampler state resets
- payload overwrite
- RTP packet construction
- RTP pacing
- microphone callback timing
- browser AudioContext behaviour

4.

If necessary add temporary diagnostics.

But only after deciding WHY they are useful.

5.

Do not assume the encoder is wrong.

Do not assume RTP is wrong.

Do not assume SDP is wrong.

Treat the code as unknown.

6.

Only after the investigation produce:

A ranked list of the 5 most probable root causes.

For each:

- probability
- evidence
- files involved
- exact code responsible

Only then implement the most probable fix.

If that fix does not fully explain the symptom, stop and continue the investigation instead of making random changes.

Think like a senior VoIP engineer debugging a production RTP issue, not like an autocomplete model making speculative edits.
