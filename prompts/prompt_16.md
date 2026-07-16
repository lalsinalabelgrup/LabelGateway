We have reached a point where SIP signalling is working correctly.

Current status:

- SIP registration works.
- Incoming calls work.
- Outgoing calls work.
- Answer / BYE / CANCEL all work.
- Audio exists in both directions.

Current problem:

LabelPhone <-> 3CX audio is perfect.

However:

LabelPhone -> external PSTN phone

has audible interruptions.

The external phone receives audio but it sounds choppy, broken and inconsistent.

This strongly suggests an RTP/audio transport issue rather than a SIP signalling issue.

I do NOT want to randomly change codecs.

I want a full technical audit of the entire audio pipeline.

Please inspect every component involved in audio transmission.

In particular investigate:

1. RTP packet generation

- packet interval
- packet size
- timestamp increment
- sequence increment
- marker bit
- SSRC stability

Verify that packets are emitted exactly every 20 ms.

2. RTP scheduling

Check whether Node.js timers (setInterval/setTimeout) are introducing jitter.

If audio transmission depends on the event loop, redesign it to minimise timing variations.

3. PCM generation

Inspect the conversion:

WebRTC PCM
↓

G711 encoder

↓

RTP packet

Verify:

- sample alignment
- endianess
- frame boundaries

4. Sample-rate conversion

If WebRTC produces 48 kHz audio and SIP requires 8 kHz:

Inspect the resampling algorithm.

Replace any naive downsampling with a proper high-quality resampler if necessary.

5. Jitter buffering

Determine whether the gateway forwards audio immediately or uses any jitter buffer.

If no jitter buffer exists, evaluate implementing one.

6. G711 encoder

Inspect:

- PCMA
- PCMU

Verify correct encoding.

Verify frame length.

Verify payload size.

7. RTP timing

Measure:

actual packet emission interval

minimum

maximum

average

standard deviation

Log these values.

8. Network

Inspect whether packets are queued, delayed or blocked by async operations.

9. CPU

Determine whether synchronous work is blocking RTP transmission.

10. Codec negotiation

Inspect whether B2Com supports OPUS.

If OPUS is supported:

Implement an experimental branch allowing OPUS negotiation.

Compare objectively:

- packet loss
- jitter
- MOS estimation
- subjective quality

Do not switch to OPUS unless the provider actually supports it.

11. Logging

Create detailed diagnostics showing:

timestamp

sequence number

RTP timestamp

payload length

inter-packet delay

packet loss

late packets

12. Wireshark validation

Ensure the generated RTP stream follows RFC3550 correctly.

13. Optimisation

If better libraries exist for:

- RTP generation
- G711 encoding
- resampling
- jitter buffering

propose them.

Goal:

External PSTN audio must sound as smooth and stable as LabelPhone <-> 3CX.

Do not stop after one hypothesis.

Continue investigating until the RTP stream quality is objectively correct.
