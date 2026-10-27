import test from 'node:test';
import assert from 'node:assert/strict';
import { CallStateError, createCallBroker } from '../lib/calling-state.mjs';

const OFFER = 'v=0\r\no=synthetic-offer\r\n';
const ANSWER = 'v=0\r\no=synthetic-answer\r\n';
const connect = (callId = 'synthetic-call-1') => ({ kind: 'connect', callId, offerSdp: OFFER });
const terminate = (callId = 'synthetic-call-1') => ({ kind: 'terminate', callId });
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function setup(options = {}) {
  let clock = 1000;
  const actions = [];
  const broker = createCallBroker({ now: () => clock, sendAction: async (action, data) => { actions.push({ action, ...data }); }, ...options });
  return { broker, actions, advance: value => { clock += value; } };
}
function readyCall(broker) {
  broker.setReady('agent-one', true);
  broker.ingest([connect()]);
  return broker.getState('agent-one').call.id;
}
const errorCode = code => error => error instanceof CallStateError && error.code === code;

test('one browser owns the lease; state does not expose actual call ID or SDP', () => {
  const { broker, actions } = setup();
  assert.deepEqual(broker.getState('agent-one'), { ready: false, busy: false, call: null });
  const id = readyCall(broker);
  assert.notEqual(id, 'synthetic-call-1');
  assert.equal(broker.getState('agent-one').ready, true);
  assert.deepEqual(broker.getState('agent-two'), { ready: false, busy: true, call: null });
  assert.throws(() => broker.setReady('agent-two', true), errorCode('AGENT_BUSY'));
  assert.throws(() => broker.getOffer('agent-two', id), errorCode('CALL_NOT_FOUND'));
  assert.deepEqual(broker.getOffer('agent-one', id), { sdp: OFFER });
  assert.ok(!JSON.stringify(broker.getState('agent-one')).includes('synthetic-call-1'));
  assert.ok(!JSON.stringify(broker.getState('agent-one')).includes(OFFER));
  assert.deepEqual(actions, []);
});

test('human Answer pre-accepts only; browser transport readiness must trigger separate accept with the same SDP', async () => {
  const { broker, actions } = setup();
  const id = readyCall(broker);
  assert.throws(() => broker.accept('agent-one', id), errorCode('CALL_STATE_CONFLICT'));
  assert.equal((await broker.answer('agent-one', id, ANSWER)).call.state, 'connecting');
  assert.deepEqual(actions, [{ action: 'pre_accept', callId: 'synthetic-call-1', sdp: ANSWER }]);
  assert.throws(() => broker.getOffer('agent-one', id), errorCode('CALL_STATE_CONFLICT'));
  assert.equal((await broker.accept('agent-one', id)).call.state, 'active');
  assert.deepEqual(actions, [
    { action: 'pre_accept', callId: 'synthetic-call-1', sdp: ANSWER },
    { action: 'accept', callId: 'synthetic-call-1', sdp: ANSWER },
  ]);
  assert.throws(() => broker.accept('agent-one', id), errorCode('CALL_STATE_CONFLICT'));
  await broker.hangup('agent-one', id);
  assert.equal(broker.getState('agent-one').call.state, 'ended');
  assert.deepEqual(actions.at(-1), { action: 'terminate', callId: 'synthetic-call-1' });
});

test('duplicate connect webhooks and late retries never create another ring or action', async () => {
  const { broker, actions } = setup();
  const id = readyCall(broker);
  broker.ingest([connect(), connect()]);
  assert.equal(broker.getState('agent-one').call.id, id);
  await broker.reject('agent-one', id);
  broker.ingest([connect()]);
  assert.equal(broker.getState('agent-one').call.state, 'ended');
  assert.deepEqual(actions, [{ action: 'reject', callId: 'synthetic-call-1' }]);
});

test('terminate arriving before connect prevents a stale ring', async () => {
  const { broker, actions } = setup();
  broker.setReady('agent-one', true);
  broker.ingest([terminate(), connect()]);
  await broker.idle();
  assert.equal(broker.getState('agent-one').call, null);
  assert.deepEqual(actions, []);
});

test('no ready browser causes a nonblocking technical rejection, with duplicate delivery deduplicated', async () => {
  const blocked = deferred();
  const actions = [];
  const { broker } = setup({ sendAction: (action, data) => { actions.push({ action, ...data }); return blocked.promise; } });
  assert.equal(broker.ingest([connect(), connect()]), undefined);
  assert.equal(broker.getState('agent-one').call, null);
  assert.deepEqual(actions, []);
  await Promise.resolve();
  assert.deepEqual(actions, [{ action: 'reject', callId: 'synthetic-call-1' }]);
  blocked.reject(new Error('provider-secret-sentinel'));
  await broker.idle();
  assert.deepEqual(broker.getState('agent-one'), { ready: false, busy: false, call: null });
});

test('a second caller is rejected without replacing the current call or offer', async () => {
  const { broker, actions } = setup();
  const id = readyCall(broker);
  broker.ingest([connect('synthetic-second-call')]);
  await broker.idle();
  assert.equal(broker.getState('agent-one').call.id, id);
  assert.deepEqual(broker.getOffer('agent-one', id), { sdp: OFFER });
  assert.deepEqual(actions, [{ action: 'reject', callId: 'synthetic-second-call' }]);
});

test('a burst without an available agent bounds concurrent background mutations', async () => {
  const blocked = deferred();
  const actions = [];
  const { broker } = setup({ sendAction: (action, data) => { actions.push({ action, ...data }); return blocked.promise; } });
  broker.ingest(Array.from({ length: 100 }, (_, index) => connect(`synthetic-burst-${index}`)));
  await Promise.resolve();
  assert.equal(actions.length, 32);
  assert.ok(actions.every(value => value.action === 'reject'));
  blocked.resolve();
  await broker.idle();
  broker.ingest([connect('synthetic-after-burst')]);
  await broker.idle();
  assert.equal(actions.length, 33);
});

test('owner polling renews its lease; another browser polling cannot renew that lease', async () => {
  const { broker, actions, advance } = setup();
  const id = readyCall(broker);
  advance(14000);
  assert.equal(broker.getState('agent-one').ready, true);
  advance(14000);
  assert.equal(broker.getState('agent-two').busy, true);
  advance(1000);
  broker.sweep();
  await broker.idle();
  assert.equal(broker.getState('agent-one').call.id, id);
  assert.equal(broker.getState('agent-one').call.state, 'ended');
  assert.equal(broker.getState('agent-one').ready, false);
  assert.deepEqual(actions, [{ action: 'reject', callId: 'synthetic-call-1' }]);
  assert.equal(broker.setReady('agent-two', true).ready, true);
});

test('ring expiry rejects once and never pre-accepts automatically', async () => {
  const { broker, actions, advance } = setup({ leaseMs: 60000 });
  readyCall(broker);
  advance(30000);
  broker.sweep();
  await broker.idle();
  broker.sweep();
  await broker.idle();
  assert.deepEqual(actions, [{ action: 'reject', callId: 'synthetic-call-1' }]);
  assert.equal(broker.getState('agent-one').call.state, 'ended');
});

test('pre-accepted setup expires without automatic acceptance', async () => {
  const { broker, actions, advance } = setup({ leaseMs: 60000 });
  const id = readyCall(broker);
  await broker.answer('agent-one', id, ANSWER);
  advance(20000);
  broker.sweep();
  await broker.idle();
  assert.deepEqual(actions.map(value => value.action), ['pre_accept', 'terminate']);
  assert.equal(broker.getState('agent-one').call.state, 'ended');
});

test('lost agent lease terminates an active call and releases ownership after confirmation', async () => {
  const { broker, actions, advance } = setup();
  const id = readyCall(broker);
  await broker.answer('agent-one', id, ANSWER);
  await broker.accept('agent-one', id);
  advance(15000);
  broker.sweep();
  await broker.idle();
  assert.equal(actions.at(-1).action, 'terminate');
  assert.deepEqual(broker.getState('agent-two'), { ready: false, busy: false, call: null });
  assert.equal(broker.setReady('agent-two', true).ready, true);
});

test('concurrent human actions are rejected while pre-accept is pending', async () => {
  const blocked = deferred();
  const { broker } = setup({ sendAction: () => blocked.promise });
  const id = readyCall(broker);
  const first = broker.answer('agent-one', id, ANSWER);
  assert.throws(() => broker.answer('agent-one', id, ANSWER), errorCode('CALL_ACTION_BUSY'));
  assert.throws(() => broker.accept('agent-one', id), errorCode('CALL_ACTION_BUSY'));
  assert.throws(() => broker.hangup('agent-one', id), errorCode('CALL_ACTION_BUSY'));
  blocked.resolve();
  await first;
  assert.equal(broker.getState('agent-one').call.state, 'connecting');
});

test('terminate during pre-accept clears the call and cannot be resurrected', async () => {
  const blocked = deferred();
  const { broker } = setup({ sendAction: () => blocked.promise });
  const id = readyCall(broker);
  const first = broker.answer('agent-one', id, ANSWER);
  await Promise.resolve();
  broker.ingest([terminate()]);
  blocked.resolve();
  await first;
  assert.equal(broker.getState('agent-one').call.state, 'ended');
  assert.throws(() => broker.accept('agent-one', id), errorCode('CALL_STATE_CONFLICT'));
});

test('terminate during accept cannot be overwritten by a late success', async () => {
  const blocked = deferred();
  const { broker } = setup({ sendAction: action => action === 'accept' ? blocked.promise : Promise.resolve() });
  const id = readyCall(broker);
  await broker.answer('agent-one', id, ANSWER);
  const first = broker.accept('agent-one', id);
  await Promise.resolve();
  broker.ingest([terminate()]);
  blocked.resolve();
  await first;
  assert.equal(broker.getState('agent-one').call.state, 'ended');
});

test('lease lost during pre-accept waits for that action, then terminates without accepting', async () => {
  const blocked = deferred();
  const actions = [];
  const { broker, advance } = setup({ sendAction: (action, data) => { actions.push({ action, ...data }); return action === 'pre_accept' ? blocked.promise : Promise.resolve(); } });
  const id = readyCall(broker);
  const first = broker.answer('agent-one', id, ANSWER);
  await Promise.resolve();
  advance(15000);
  broker.sweep();
  assert.deepEqual(actions.map(value => value.action), ['pre_accept']);
  blocked.resolve();
  await first;
  await broker.idle();
  assert.deepEqual(actions.map(value => value.action), ['pre_accept', 'terminate']);
  assert.equal(broker.getState('agent-one').call.state, 'ended');
});

test('unknown provider outcome is sanitized, never automatically retried, and allows explicit cleanup', async () => {
  const actions = [];
  const { broker } = setup({ sendAction: async (action, data) => {
    actions.push({ action, ...data });
    if (action === 'pre_accept') throw new Error('graph-token-and-provider-body-sentinel');
  } });
  const id = readyCall(broker);
  await assert.rejects(broker.answer('agent-one', id, ANSWER), error => errorCode('CALL_ACTION_UNCONFIRMED')(error) && !error.message.includes('sentinel'));
  const state = broker.getState('agent-one');
  assert.equal(state.call.state, 'uncertain');
  assert.ok(!JSON.stringify(state).includes('sentinel'));
  assert.throws(() => broker.answer('agent-one', id, ANSWER), errorCode('CALL_STATE_CONFLICT'));
  assert.throws(() => broker.accept('agent-one', id), errorCode('CALL_STATE_CONFLICT'));
  await broker.hangup('agent-one', id);
  assert.deepEqual(actions.map(value => value.action), ['pre_accept', 'terminate']);
  assert.equal(broker.getState('agent-one').call.state, 'ended');
});

test('a failed technical cleanup is visible as uncertain, never repeatedly retried by sweep', async () => {
  const actions = [];
  const { broker, advance } = setup({ sendAction: async action => { actions.push(action); throw new Error('sensitive-provider-data'); } });
  readyCall(broker);
  advance(15000);
  broker.sweep();
  await broker.idle();
  broker.sweep();
  await broker.idle();
  assert.deepEqual(actions, ['reject']);
  assert.equal(broker.getState('agent-one').call.state, 'uncertain');
  assert.equal(broker.getState('agent-two').busy, true);
});

test('invalid SDP, invalid agents and invalid batches fail without sending actions or partial ingestion', () => {
  const { broker, actions } = setup();
  broker.setReady('agent-one', true);
  assert.throws(() => broker.ingest([connect(), { ...connect('synthetic-bad'), offerSdp: 'invalid' }]), errorCode('CALL_EVENT_INVALID'));
  assert.equal(broker.getState('agent-one').call, null);
  const id = readyCall(broker);
  for (const sdp of ['', 'invalid', 'v=0\0', `v=0${'é'.repeat(32768)}`]) {
    assert.throws(() => broker.answer('agent-one', id, sdp), errorCode('CALL_SDP_INVALID'));
  }
  assert.throws(() => broker.getState('agent\ninvalid'), errorCode('AGENT_INVALID'));
  assert.equal(broker.getState('agent-one').call.state, 'ringing');
  assert.deepEqual(actions, []);
});

test('leaving Ready requires finishing a live call, then another browser may take over', async () => {
  const { broker } = setup();
  const id = readyCall(broker);
  assert.throws(() => broker.setReady('agent-one', false), errorCode('CALL_ACTIVE'));
  await broker.reject('agent-one', id);
  assert.equal(broker.setReady('agent-one', false).ready, false);
  assert.equal(broker.setReady('agent-two', true).ready, true);
  assert.equal(broker.getState('agent-two').call, null);
});

test('close cleans up the current call once and prevents more operations', async () => {
  const { broker, actions } = setup();
  readyCall(broker);
  broker.close();
  broker.close();
  await broker.idle();
  assert.deepEqual(actions, [{ action: 'reject', callId: 'synthetic-call-1' }]);
  assert.throws(() => broker.getState('agent-one'), errorCode('CALLING_CLOSED'));
  assert.throws(() => broker.ingest([connect()]), errorCode('CALLING_CLOSED'));
});
