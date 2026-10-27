import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentController } from '../public/agent/app.mjs';

const secret = 'synthetic-agent-token-for-controller-checks-only';
const callId = 'synthetic-opaque-call';
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function until(predicate) { for (let i = 0; i < 30 && !predicate(); i++) await tick(); assert.ok(predicate(), 'expected async checkpoint was reached'); }
const response = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

function fixture(t, options = {}) {
  const requests = [], events = [], clones = [], timers = new Map();
  let timerId = 0, data = { ready: false, busy: false, call: null }, handler, micRequests = 0;
  const track = { kind: 'audio', stopped: false, stop() { this.stopped = true; }, clone() { const cloned = { kind: 'audio', stopped: false, stop() { this.stopped = true; } }; clones.push(cloned); return cloned; } };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  class Peer {
    static instances = [];
    constructor() {
      this.iceGatheringState = 'complete'; this.connectionState = 'new'; this.listeners = new Map(); this.closed = false;
      this.transceiver = { direction: 'recvonly', receiver: { track: { kind: 'audio' } }, sender: { track: null, replaceTrack: async value => { events.push('attach-microphone'); if (options.replaceTrack) await options.replaceTrack(value); this.transceiver.sender.track = value; } } };
      Peer.instances.push(this);
    }
    async setRemoteDescription(value) { assert.equal(value.type, 'offer'); events.push('remote-offer'); }
    getTransceivers() { return [this.transceiver]; }
    async createAnswer() { assert.equal(this.transceiver.direction, 'sendrecv'); assert.equal(this.transceiver.sender.track, null); return { type: 'answer', sdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n' }; }
    async setLocalDescription(value) { this.localDescription = value; }
    addEventListener(name, listener) { if (!this.listeners.has(name)) this.listeners.set(name, new Set()); this.listeners.get(name).add(listener); }
    removeEventListener(name, listener) { this.listeners.get(name)?.delete(listener); }
    emit(name) { for (const listener of [...this.listeners.get(name) ?? []]) listener(); this[`on${name}`]?.(); }
    close() { this.closed = true; this.connectionState = 'closed'; this.emit('connectionstatechange'); }
  }
  const desk = createAgentController({
    clientId: 'synthetic-tab-id', secureContext: true, PeerConnection: Peer,
    setTimer: fn => { const id = ++timerId; timers.set(id, fn); return id; }, clearTimer: id => timers.delete(id),
    mediaDevices: { async getUserMedia(constraints) { micRequests++; assert.deepEqual(constraints, { audio: true, video: false }); return options.getUserMedia ? options.getUserMedia() : stream; } },
    fetchImpl: async (url, init) => {
      requests.push({ url, ...init });
      assert.equal(init.headers.Authorization, `Bearer ${secret}`);
      assert.equal(init.headers['X-Agent-ID'], 'synthetic-tab-id');
      assert.ok(!url.includes(secret)); assert.equal(init.credentials, 'omit');
      if (handler) { const result = await handler(url, init); if (result) return result; }
      if (url.endsWith('/state')) return response(data);
      if (url.endsWith('/ready')) { data = { ...data, ready: JSON.parse(init.body).ready }; return response(data); }
      if (url.endsWith('/offer')) return response({ sdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n' });
      if (url.endsWith('/answer')) { events.push('pre-accept'); data = { ...data, call: { id: callId, state: 'connecting' } }; if (options.autoConnect !== false) Peer.instances.at(-1).connectionState = 'connected'; return response(data); }
      if (url.endsWith('/accept')) { events.push('accept'); data = { ...data, call: { id: callId, state: 'active' } }; return response(data); }
      if (url.endsWith('/hangup') || url.endsWith('/reject')) { events.push('cleanup'); data = { ...data, call: { id: callId, state: 'ended' } }; return response(data); }
      throw new Error('Unexpected route in controller check');
    },
    view: { render() {}, clearToken() { events.push('clear-token'); }, setRemoteStream() {}, async playAudio() {} },
  });
  t.after(() => desk.disconnect());
  return { desk, track, stream, requests, events, clones, Peer, set data(value) { data = value; }, get data() { return data; }, set handler(value) { handler = value; }, get micRequests() { return micRequests; },
    async ready() { await desk.connect(secret); await desk.setReady(true); },
    async ring() { data = { ready: true, busy: false, call: { id: callId, state: 'ringing' } }; await desk.poll(); },
  };
}

test('connecting never captures a microphone or automatically answers; token stays in headers', async t => {
  const f = fixture(t); await f.desk.connect(secret);
  assert.equal(f.desk.snapshot().connected, true); assert.equal(f.micRequests, 0);
  assert.deepEqual(f.requests.map(item => item.url), ['/agent/api/state']);
  assert.ok(f.events.includes('clear-token'));
  assert.ok(!JSON.stringify(f.desk.snapshot()).includes(secret));
});

test('microphone denial never registers a ready agent and presents a useful error', async t => {
  const f = fixture(t, { getUserMedia: async () => { const error = new Error('private device details'); error.name = 'NotAllowedError'; throw error; } });
  await f.ready();
  assert.equal(f.desk.snapshot().ready, false); assert.match(f.desk.snapshot().error, /not allowed/);
  assert.ok(!f.desk.snapshot().error.includes('private'));
  assert.equal(f.requests.filter(item => item.url.endsWith('/ready')).length, 0);
});

test('an old state poll cannot undo newly completed Ready or stop its microphone', async t => {
  const f = fixture(t); await f.desk.connect(secret);
  const oldPoll = deferred(); let held = false;
  f.handler = url => { if (url.endsWith('/state') && !held) { held = true; return oldPoll.promise; } };
  const polling = f.desk.poll(); await until(() => held);
  await f.desk.setReady(true);
  oldPoll.resolve(response({ ready: false, busy: false, call: null })); await polling;
  assert.equal(f.desk.snapshot().ready, true); assert.equal(f.track.stopped, false);
});

test('a microphone granted after disconnect is released and does not register readiness', async t => {
  const permission = deferred(); const f = fixture(t, { getUserMedia: () => permission.promise });
  await f.desk.connect(secret); const ready = f.desk.setReady(true);
  await until(() => f.micRequests === 1); f.desk.disconnect(); permission.resolve(f.stream); await ready;
  assert.equal(f.track.stopped, true); assert.equal(f.desk.snapshot().connected, false);
  assert.equal(f.requests.filter(item => item.url.endsWith('/ready')).length, 0);
});

test('Answer pre-accepts, waits for transport, explicitly accepts, then attaches microphone', async t => {
  const accept = deferred(); const f = fixture(t); await f.ready(); await f.ring();
  assert.ok(!f.requests.some(item => item.url.endsWith('/answer')));
  f.handler = url => { if (url.endsWith('/accept')) { f.events.push('accept-pending'); return accept.promise; } };
  const answering = f.desk.answer(); await until(() => f.events.includes('accept-pending'));
  assert.equal(f.Peer.instances[0].transceiver.sender.track, null); assert.equal(f.clones.length, 0);
  f.data = { ready: true, busy: false, call: { id: callId, state: 'active' } }; accept.resolve(response(f.data)); await answering;
  assert.equal(f.desk.snapshot().call.state, 'active'); assert.equal(f.clones.length, 1);
  assert.ok(f.events.indexOf('pre-accept') < f.events.indexOf('accept-pending'));
  assert.ok(f.events.indexOf('accept-pending') < f.events.indexOf('attach-microphone'));
});

test('pre-accept waits for connected ICE/DTLS before sending accept', async t => {
  const f = fixture(t, { autoConnect: false }); await f.ready(); await f.ring();
  const answering = f.desk.answer(); await until(() => f.events.includes('pre-accept'));
  assert.ok(!f.requests.some(item => item.url.endsWith('/accept')));
  const peer = f.Peer.instances[0]; peer.connectionState = 'connected'; peer.emit('connectionstatechange'); await answering;
  assert.equal(f.desk.snapshot().call.state, 'active');
});

test('an ended snapshot returned by accept never opens the microphone sender', async t => {
  const f = fixture(t); await f.ready(); await f.ring();
  f.handler = url => { if (url.endsWith('/accept')) return response({ ready: true, busy: false, call: { id: callId, state: 'ended' } }); };
  await f.desk.answer();
  assert.equal(f.clones.length, 0); assert.equal(f.Peer.instances[0].closed, true); assert.equal(f.desk.snapshot().call.state, 'ended');
});

test('terminate during a pending accept cannot resurrect the call or attach microphone', async t => {
  const accepting = deferred(); const f = fixture(t); await f.ready(); await f.ring();
  let reached = false; f.handler = url => { if (url.endsWith('/accept')) { reached = true; return accepting.promise; } };
  const answering = f.desk.answer(); await until(() => reached);
  f.data = { ready: true, busy: false, call: { id: callId, state: 'ended' } }; await f.desk.poll();
  accepting.resolve(response(f.data)); await answering;
  assert.equal(f.clones.length, 0); assert.equal(f.Peer.instances[0].closed, true); assert.equal(f.desk.snapshot().call.state, 'ended');
});

test('terminate while replaceTrack is pending closes peer and stops clone without restoring active', async t => {
  const replacing = deferred(); const f = fixture(t, { replaceTrack: () => replacing.promise }); await f.ready(); await f.ring();
  const answering = f.desk.answer(); await until(() => f.events.includes('attach-microphone'));
  f.data = { ready: true, busy: false, call: { id: callId, state: 'ended' } }; await f.desk.poll();
  assert.equal(f.clones[0].stopped, true); replacing.resolve(); await answering;
  assert.equal(f.Peer.instances[0].closed, true); assert.equal(f.desk.snapshot().call.state, 'ended');
});

test('a poll started during Answer cannot regress an accepted snapshot during replaceTrack', async t => {
  const accepting = deferred(), replacing = deferred(), stalePoll = deferred();
  const f = fixture(t, { replaceTrack: () => replacing.promise }); await f.ready(); await f.ring();
  let acceptingStarted = false, pollHeld = false;
  f.handler = url => {
    if (url.endsWith('/accept')) { acceptingStarted = true; return accepting.promise; }
    if (url.endsWith('/state')) { pollHeld = true; return stalePoll.promise; }
  };
  const answering = f.desk.answer(); await until(() => acceptingStarted);
  const polling = f.desk.poll(); await until(() => pollHeld);
  accepting.resolve(response({ ready: true, busy: false, call: { id: callId, state: 'active' } }));
  await until(() => f.events.includes('attach-microphone'));
  stalePoll.resolve(response({ ready: true, busy: false, call: { id: callId, state: 'connecting' } })); await polling;
  assert.equal(f.desk.snapshot().call.state, 'active'); replacing.resolve(); await answering;
  assert.equal(f.desk.snapshot().call.state, 'active');
});

test('Hang up during Answer stops local media immediately and cleans up after in-flight pre-accept', async t => {
  const preparing = deferred(); const f = fixture(t); await f.ready(); await f.ring();
  let reached = false; f.handler = url => { if (url.endsWith('/answer')) { reached = true; return preparing.promise; } };
  const answering = f.desk.answer(); await until(() => reached);
  const hangingUp = f.desk.hangup(); assert.equal(f.Peer.instances[0].closed, true);
  assert.ok(!f.requests.some(item => item.url.endsWith('/hangup')));
  f.data = { ready: true, busy: false, call: { id: callId, state: 'connecting' } }; preparing.resolve(response(f.data));
  await Promise.all([answering, hangingUp]);
  assert.equal(f.requests.filter(item => item.url.endsWith('/hangup')).length, 1);
  assert.equal(f.desk.snapshot().call.state, 'ended'); assert.equal(f.clones.length, 0);
});

test('structured provider failures retain a Hang up path; network failures stop all media', async t => {
  const f = fixture(t); await f.ready(); await f.ring();
  f.handler = url => { if (url.endsWith('/accept')) return response({ error: { code: 'CALLING_ACTION_FAILED', message: 'private response sentinel' } }, 502); };
  await f.desk.answer();
  assert.equal(f.desk.snapshot().connected, true); assert.equal(f.desk.snapshot().call.state, 'uncertain');
  assert.ok(!f.desk.snapshot().error.includes('sentinel')); assert.equal(f.Peer.instances[0].closed, true);
  f.handler = url => { if (url.endsWith('/state')) throw new Error('private network info'); };
  await f.desk.poll();
  assert.equal(f.desk.snapshot().connected, false); assert.equal(f.track.stopped, true);
  const count = f.requests.length; await f.desk.poll(); assert.equal(f.requests.length, count);
});
