'use strict';

/**
 * SipRtcStub
 *
 * Minimal RTCPeerConnection + RTCSessionDescription shim for server-side JsSIP.
 *
 * JsSIP was designed for browsers and references the global RTCPeerConnection
 * and window.RTCPeerConnection before placing any outgoing call.  In Node.js
 * those globals don't exist, so we install lightweight stubs that satisfy
 * JsSIP's internal contract without requiring a real WebRTC stack.
 *
 * What the stub does:
 *  - createOffer()  → returns a minimal but valid SIP SDP offer (G.711 audio)
 *  - createAnswer() → same SDP (used by JsSIP when it re-offers on 200 OK)
 *  - setLocalDescription()  → stores desc, advances signalingState
 *  - setRemoteDescription() → stores desc, resets signalingState to 'stable'
 *  - iceGatheringState = 'complete' → _createLocalDescription() resolves immediately
 *    without waiting for ICE candidates (no real ICE in a server context)
 *  - addEventListener/removeEventListener → stored but never dispatched;
 *    iceConnectionState stays 'new' so the 'failed' guard in RTCSession never fires
 *
 * Audio note:
 *  The SDP offer advertises G.711 PCMU/PCMA on port 9 ("discard").  This is enough
 *  for the PBX to accept the INVITE and ring the target extension.  No actual RTP
 *  socket is opened on LabelGateway — audio routing is a later milestone.
 */

const SDP_OFFER = [
  'v=0',
  'o=- 0 0 IN IP4 127.0.0.1',
  's=LabelGateway',
  'c=IN IP4 0.0.0.0',
  't=0 0',
  'm=audio 9 RTP/AVP 0 8 101',
  'a=rtpmap:0 PCMU/8000',
  'a=rtpmap:8 PCMA/8000',
  'a=rtpmap:101 telephone-event/8000',
  'a=fmtp:101 0-15',
  'a=sendrecv',
  '',
].join('\r\n');

class SipRtcStub {
  constructor() {
    // iceGatheringState='complete' makes _createLocalDescription() resolve immediately
    // without waiting for onicegatheringstatechange events.
    this.iceGatheringState  = 'complete';
    this.iceConnectionState = 'new';
    // 'stable' → 'have-local-offer' after setLocalDescription(offer)
    // 'have-local-offer' → 'stable' after setRemoteDescription(answer)
    this.signalingState    = 'stable';
    this.localDescription  = null;
    this.remoteDescription = null;
    this._listeners        = {};
  }

  addEventListener(type, fn) {
    if (!this._listeners[type]) this._listeners[type] = [];
    this._listeners[type].push(fn);
  }

  removeEventListener(type, fn) {
    if (!this._listeners[type]) return;
    this._listeners[type] = this._listeners[type].filter(f => f !== fn);
  }

  // Track management — no real tracks, JsSIP only calls these when a MediaStream is given
  addTrack()    {}
  removeTrack() {}
  getSenders()   { return []; }
  getReceivers() { return []; }

  createOffer()  { return Promise.resolve({ type: 'offer',  sdp: SDP_OFFER }); }
  createAnswer() { return Promise.resolve({ type: 'answer', sdp: SDP_OFFER }); }

  setLocalDescription(desc) {
    this.localDescription = desc;
    // Mirror real RTCPeerConnection signalingState transitions
    if (desc && desc.type === 'offer')  this.signalingState = 'have-local-offer';
    if (desc && desc.type === 'answer') this.signalingState = 'stable';
    return Promise.resolve();
  }

  setRemoteDescription(desc) {
    this.remoteDescription = desc;
    this.signalingState    = 'stable';
    return Promise.resolve();
  }

  close() {
    this.signalingState = 'closed';
  }
}

/**
 * Install the RTCPeerConnection and RTCSessionDescription globals that JsSIP
 * reads at call time.  Safe to call multiple times — only installs once.
 */
function installGlobals() {
  if (global._sipRtcStubInstalled) return;
  global._sipRtcStubInstalled = true;

  // JsSIP checks `window.RTCPeerConnection` inside RTCSession.connect()
  if (!global.window) global.window = {};
  global.window.RTCPeerConnection = SipRtcStub;

  // JsSIP also references the bare global in _createRTCConnection()
  global.RTCPeerConnection = SipRtcStub;

  // Used as `new RTCSessionDescription({ type, sdp })` in _receiveInviteResponse()
  global.RTCSessionDescription = function RTCSessionDescription(init) {
    this.type = init.type;
    this.sdp  = init.sdp;
  };
}

module.exports = { SipRtcStub, installGlobals };
