/**
 * MockAdapter — full in-process simulation of a telephony backend.
 *
 * Mirrors the behaviour of the in-browser mockGateway.js that shipped
 * with LabelPhone, so the demo experience is identical whether the
 * frontend's mode is "mock" (client-side) or "real" (this server).
 *
 * State is kept in memory per adapter instance (= per WebSocket session).
 * No database, no network calls.
 */

const BaseTelephonyAdapter = require('./BaseTelephonyAdapter');
const CallStateService      = require('../services/CallStateService');
const config                = require('../config/config');
const logger                = require('../utils/logger');

/* ─── Mock data ─────────────────────────────────────────────────────────── */

const MOCK_CONTACTS = [
  { id: 1,  name: 'Anna García',        phone: '+34 611 100 001', company: 'LabelGrup',  initials: 'AG', color: '#0a84ff', favorite: true  },
  { id: 2,  name: 'Carlos Martínez',    phone: '+34 611 100 002', company: 'LabelGrup',  initials: 'CM', color: '#30d158', favorite: true  },
  { id: 3,  name: 'Elena Rodríguez',    phone: '+34 611 100 003', company: 'B2Com',      initials: 'ER', color: '#ff9f0a', favorite: false },
  { id: 4,  name: 'Javier López',       phone: '+34 611 100 004', company: 'B2Com',      initials: 'JL', color: '#ff375f', favorite: false },
  { id: 5,  name: 'Laura Sánchez',      phone: '+34 611 100 005', company: 'Soporte',    initials: 'LS', color: '#5e5ce6', favorite: true  },
  { id: 6,  name: 'Miguel Torres',      phone: '+34 611 100 006', company: 'Soporte',    initials: 'MT', color: '#64d2ff', favorite: false },
  { id: 7,  name: 'Natalia Fernández',  phone: '+34 611 100 007', company: 'Ventas',     initials: 'NF', color: '#30b0c7', favorite: false },
  { id: 8,  name: 'Pablo Jiménez',      phone: '+34 611 100 008', company: 'Ventas',     initials: 'PJ', color: '#ffd60a', favorite: false },
  { id: 9,  name: 'Rosa Navarro',       phone: '+34 611 100 009', company: 'Dirección',  initials: 'RN', color: '#bf5af2', favorite: false },
  { id: 10, name: 'Sergio Moreno',      phone: '+34 611 100 010', company: 'Dirección',  initials: 'SM', color: '#32ade6', favorite: false },
  { id: 11, name: 'Teresa Alonso',      phone: '+34 611 100 011', company: 'RRHH',       initials: 'TA', color: '#ff6961', favorite: false },
  { id: 12, name: 'Lluis Alsina',       phone: '+34 611 100 012', company: 'LabelGrup',  initials: 'LA', color: '#636366', favorite: false },
];

const MOCK_HISTORY = [
  { id: 'h1', contactId: 2,    number: '+34 611 100 002', name: 'Carlos Martínez',  type: 'outgoing', duration: 187, label: 'history.today',     time: '10:23' },
  { id: 'h2', contactId: null, number: '+34 93 555 0001', name: '+34 93 555 0001',  type: 'missed',   duration: 0,   label: 'history.today',     time: '09:41' },
  { id: 'h3', contactId: 5,    number: '+34 611 100 005', name: 'Laura Sánchez',    type: 'incoming', duration: 432, label: 'history.today',     time: '09:15' },
  { id: 'h4', contactId: 1,    number: '+34 611 100 001', name: 'Anna García',      type: 'outgoing', duration: 65,  label: 'history.yesterday', time: '16:45' },
  { id: 'h5', contactId: 3,    number: '+34 611 100 003', name: 'Elena Rodríguez',  type: 'incoming', duration: 312, label: 'history.yesterday', time: '14:30' },
  { id: 'h6', contactId: null, number: '+34 91 444 0002', name: '+34 91 444 0002',  type: 'missed',   duration: 0,   label: 'history.yesterday', time: '11:22' },
];

/* ─── MockAdapter ────────────────────────────────────────────────────────── */

class MockAdapter extends BaseTelephonyAdapter {
  constructor(sendEvent, extension = '1001') {
    super(sendEvent);
    this._extension = extension;
    this._cs        = new CallStateService();
    this._contacts  = MOCK_CONTACTS.map(c => ({ ...c }));
    this._history   = MOCK_HISTORY.map(h => ({ ...h }));
    this._timers    = new Set();
    this._callTimer = null;
  }

  /* ── Timer helpers ──────────────────────────────────────────────────── */

  _after(ms, fn) {
    const t = setTimeout(() => { this._timers.delete(t); fn(); }, ms);
    this._timers.add(t);
    return t;
  }

  _cancel(t) {
    if (!t) return;
    clearTimeout(t);
    this._timers.delete(t);
  }

  destroy() {
    this._timers.forEach(t => clearTimeout(t));
    this._timers.clear();
    this._callTimer = null;
    logger.debug('MockAdapter destroyed');
  }

  /* ── Internal emit ──────────────────────────────────────────────────── */

  /* callId is passed separately so wsServer.sendEvent can place it at the
     top level of the event envelope (not nested inside payload). */
  _emit(event, payload = {}, callId = null) {
    logger.debug({ event, callId, payload }, 'MockAdapter → client');
    this._sendEvent(event, payload, callId);
  }

  /* ── Connection ─────────────────────────────────────────────────────── */

  connect() {
    this._cs.setConnection('connecting');
    this._emit('connecting', {});
    return new Promise(resolve => {
      this._after(config.MOCK_CONNECT_DELAY_MS, () => {
        this._cs.setConnection('connected');
        this._cs.setRegistration('registered');
        this._emit('connected',  {});
        this._emit('registered', { extension: this._extension });
        resolve({});
      });
    });
  }

  disconnect() {
    this._timers.forEach(t => clearTimeout(t));
    this._timers.clear();
    this._callTimer = null;
    this._cs.setConnection('disconnected');
    this._cs.setRegistration('unregistered');
    this._cs.clearCall();
    this._emit('disconnected', {});
    this._emit('unregistered', {});
    return Promise.resolve({});
  }

  /* ── Outbound call ──────────────────────────────────────────────────── */

  call(number, contact) {
    if (this._cs.call) return Promise.reject(new Error('Call in progress'));

    const callId = `call-${Date.now()}`;
    this._cs.setCall({
      callId, direction: 'outbound', status: 'ringing',
      contact: contact || null, number,
      muted: false, speaker: false, held: false, startTime: null,
    });

    this._emit('outgoingCall', { number, contact: contact || null }, callId);
    this._emit('ringing',      {}, callId);

    this._callTimer = this._after(config.MOCK_CALL_CONNECT_MS, () => {
      if (!this._cs.call || this._cs.call.callId !== callId) return;
      this._cs.updateCall({ status: 'answered', startTime: Date.now() });
      const c = this._cs.call;
      this._emit('answered', { contact: c.contact, number: c.number, startTime: c.startTime }, callId);
    });

    return Promise.resolve({ callId });
  }

  /* ── Inbound call ───────────────────────────────────────────────────── */

  answer() {
    const c = this._cs.call;
    if (!c || c.direction !== 'inbound' || c.status !== 'ringing')
      return Promise.reject(new Error('No incoming call to answer'));
    const startTime = Date.now();
    this._cs.updateCall({ status: 'answered', startTime });
    this._emit('answered', { contact: c.contact, number: c.number, startTime }, c.callId);
    return Promise.resolve({});
  }

  reject() {
    const c = this._cs.call;
    if (!c || c.status !== 'ringing')
      return Promise.reject(new Error('No ringing call'));
    const callId = c.callId;
    const snap = { contact: c.contact, number: c.number, direction: c.direction };
    this._cs.clearCall();
    this._emit('ended', { ...snap, duration: 0, reason: 'declined' }, callId);
    return Promise.resolve({});
  }

  hangup() {
    this._cancel(this._callTimer);
    this._callTimer = null;
    const c = this._cs.call;
    if (!c) return Promise.reject(new Error('No active call'));
    const duration = c.startTime ? Math.floor((Date.now() - c.startTime) / 1000) : 0;
    const callId = c.callId;
    const snap = { contact: c.contact, number: c.number, direction: c.direction };
    this._cs.clearCall();
    this._emit('ended', { ...snap, duration, reason: 'normal' }, callId);
    return Promise.resolve({});
  }

  /* ── Hold / Resume ──────────────────────────────────────────────────── */

  hold() {
    const c = this._cs.call;
    if (!c || c.status !== 'answered')
      return Promise.reject(new Error('No active call to hold'));
    this._cs.updateCall({ held: true, status: 'held' });
    this._emit('held', {}, c.callId);
    return Promise.resolve({});
  }

  resume() {
    const c = this._cs.call;
    if (!c || c.status !== 'held')
      return Promise.reject(new Error('Call is not on hold'));
    this._cs.updateCall({ held: false, status: 'answered' });
    this._emit('resumed', {}, c.callId);
    return Promise.resolve({});
  }

  /* ── Audio controls ─────────────────────────────────────────────────── */

  mute() {
    const c = this._cs.call;
    if (!c) return Promise.reject(new Error('No active call'));
    this._cs.updateCall({ muted: true });
    return Promise.resolve({ muted: true });
  }

  unmute() {
    const c = this._cs.call;
    if (!c) return Promise.reject(new Error('No active call'));
    this._cs.updateCall({ muted: false });
    return Promise.resolve({ muted: false });
  }

  setSpeaker(enabled) {
    const c = this._cs.call;
    if (!c) return Promise.reject(new Error('No active call'));
    this._cs.updateCall({ speaker: !!enabled });
    return Promise.resolve({ speaker: !!enabled });
  }

  /* ── Transfer ───────────────────────────────────────────────────────── */

  transfer(target) {
    const c = this._cs.call;
    if (!c) return Promise.reject(new Error('No active call'));
    const callId = c.callId;
    const snap = { contact: c.contact, number: c.number, direction: c.direction };
    logger.info({ target }, 'MockAdapter: simulating blind transfer');
    return new Promise(resolve => {
      this._after(config.MOCK_TRANSFER_DELAY_MS, () => {
        this._cancel(this._callTimer);
        this._callTimer = null;
        this._cs.clearCall();
        this._emit('ended', { ...snap, duration: 0, reason: 'transferred' }, callId);
        resolve({});
      });
    });
  }

  /* ── DTMF ───────────────────────────────────────────────────────────── */

  sendDTMF(digit) {
    const c = this._cs.call;
    if (!c) return Promise.reject(new Error('No active call'));
    this._emit('dtmf', { digit }, c.callId);
    return Promise.resolve({});
  }

  /* ── Contacts & History ─────────────────────────────────────────────── */

  getContacts() {
    return Promise.resolve(this._contacts.map(c => ({ ...c })));
  }

  getHistory() {
    return Promise.resolve(this._history.map(h => ({ ...h })));
  }

  addHistoryEntry(entry) {
    if (!entry) return Promise.reject(new Error('entry is required'));
    this._history.unshift({ ...entry });
    this._emit('historyUpdated', { history: this._history.slice(0, 50) });
    return Promise.resolve({});
  }

  /* ── Simulation (dev) ───────────────────────────────────────────────── */

  simulateIncomingCall(contact) {
    if (this._cs.call) return Promise.reject(new Error('A call is already in progress'));
    this._after(config.MOCK_INCOMING_DELAY_MS, () => {
      const callId = `call-${Date.now()}`;
      const number = contact ? contact.phone : 'Desconocido';
      this._cs.setCall({
        callId, direction: 'inbound', status: 'ringing',
        contact: contact || null, number,
        muted: false, speaker: false, held: false, startTime: null,
      });
      this._emit('incomingCall', { contact: contact || null, number }, callId);
      this._emit('ringing',      {}, callId);
    });
    return Promise.resolve({});
  }

  /* ── Authentication ─────────────────────────────────────────────────── */

  login({ extension, password: _password, displayName: _displayName } = {}) {
    const ext = extension || this._extension;
    this._extension = ext;
    setImmediate(() => {
      this._cs.setRegistration('registered');
      this._emit('registered', { extension: ext });
    });
    return Promise.resolve({});
  }

  logout() {
    const ext = this._extension;
    setImmediate(() => {
      this._cs.setRegistration('unregistered');
      this._emit('unregistered', ext ? { extension: ext } : {});
    });
    return Promise.resolve({});
  }

  /* ── Unsupported (stubs that satisfy the interface) ─────────────────── */

  conference()     { return Promise.reject(new Error('Conference not available in this adapter')); }
  startRecording() { return Promise.reject(new Error('Recording not available in this adapter')); }
  stopRecording()  { return Promise.reject(new Error('Recording not available in this adapter')); }
}

module.exports = MockAdapter;
