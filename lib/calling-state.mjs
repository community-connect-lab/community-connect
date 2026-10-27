import { randomUUID } from 'node:crypto';

const MAX_SDP_BYTES = 64 * 1024;
const MAX_EVENTS = 1000;
const MAX_SEEN = 1000;
const MAX_BACKGROUND_REJECTIONS = 32;
const SEEN_TTL_MS = 5 * 60 * 1000;
const SETUP_TIMEOUT_MS = 20000;
const TERMINAL = new Set(['ended']);

const ERRORS = {
  CALLING_CLOSED: [503, 'The Calling gateway is unavailable.'],
  AGENT_INVALID: [400, 'The agent identifier is invalid.'],
  AGENT_BUSY: [409, 'Another agent browser is already ready or handling a call.'],
  AGENT_NOT_READY: [409, 'Make this agent browser ready before answering a call.'],
  CALL_ACTIVE: [409, 'Finish the current call before leaving Ready mode.'],
  CALL_NOT_FOUND: [404, 'The call is no longer available to this agent.'],
  CALL_STATE_CONFLICT: [409, 'That action is not available in the current call state.'],
  CALL_ACTION_BUSY: [409, 'A call action is already in progress.'],
  CALL_SDP_INVALID: [400, 'The audio connection description is missing or invalid.'],
  CALL_EVENT_INVALID: [400, 'The Calling event is invalid.'],
  CALL_API_AUTH: [502, 'Meta could not authenticate the call action. Check the backend WhatsApp token.'],
  CALL_API_PERMISSION: [502, 'Meta did not permit the call action. Check the app and number permissions.'],
  CALL_API_SDP: [502, 'Meta rejected the browser audio session.'],
  CALL_API_REJECTED: [502, 'Meta rejected the call action.'],
  CALL_API_TIMEOUT: [502, 'Meta did not respond before the call-action deadline.'],
  CALL_API_NETWORK: [502, 'The gateway could not reach Meta to confirm the call action.'],
  CALL_ACTION_UNCONFIRMED: [502, 'The call action could not be confirmed. Use Hang up to end any remaining connection.'],
};
const API_ERROR_CODES = new Set(['CALL_API_AUTH', 'CALL_API_PERMISSION', 'CALL_API_SDP', 'CALL_API_REJECTED', 'CALL_API_TIMEOUT', 'CALL_API_NETWORK', 'CALL_ACTION_UNCONFIRMED']);
const ACTIONS = new Set(['pre_accept', 'accept', 'reject', 'terminate']);

// Provider exceptions are not public messages. Read own data properties only:
// accessors, inherited values, raw bodies, messages and causes never escape.
function dataProperty(value, name) {
  if (value == null || (typeof value !== 'object' && typeof value !== 'function')) return undefined;
  try { return Object.getOwnPropertyDescriptor(value, name)?.value; } catch { return undefined; }
}

function safeDiagnostic(value, action) {
  const result = {};
  const suppliedAction = dataProperty(value, 'action');
  if (ACTIONS.has(action)) result.action = action;
  else if (ACTIONS.has(suppliedAction)) result.action = suppliedAction;
  for (const [name, minimum, maximum] of [['httpStatus', 100, 599], ['metaCode', 0, 999999999], ['metaSubcode', 0, 999999999]]) {
    const number = dataProperty(value, name);
    if (Number.isInteger(number) && number >= minimum && number <= maximum) result[name] = number;
  }
  return Object.keys(result).length ? Object.freeze(result) : undefined;
}

function providerError(error, action) {
  const suppliedCode = dataProperty(error, 'code');
  const code = API_ERROR_CODES.has(suppliedCode) ? suppliedCode : 'CALL_ACTION_UNCONFIRMED';
  return new CallStateError(code, safeDiagnostic(dataProperty(error, 'diagnostic'), action));
}

export class CallStateError extends Error {
  constructor(code, diagnostic) {
    const known = typeof code === 'string' && Object.hasOwn(ERRORS, code) ? code : 'CALL_ACTION_UNCONFIRMED';
    super(ERRORS[known][1]);
    this.name = 'CallStateError';
    this.code = known;
    this.status = ERRORS[known][0];
    const safe = safeDiagnostic(diagnostic);
    if (safe) this.diagnostic = safe;
  }
}

function validAgentId(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
}

function validCallId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\s\x00-\x1f\x7f]/.test(value);
}

function validSdp(value) {
  return typeof value === 'string' && value.startsWith('v=0') && !value.includes('\0') && Buffer.byteLength(value, 'utf8') <= MAX_SDP_BYTES;
}

// A single ready browser owns a renewable lease and at most one live call.
// The Graph call ID and SDP remain inside this broker; snapshots contain only
// an unrelated opaque handle. No caller numbers, names, audio, or history are kept.
export function createCallBroker({ sendAction, now = Date.now, ringTimeoutMs = 30000, leaseMs = 15000 } = {}) {
  if (typeof sendAction !== 'function' || typeof now !== 'function' || !Number.isFinite(ringTimeoutMs) || ringTimeoutMs < 1 || !Number.isFinite(leaseMs) || leaseMs < 1) {
    throw new TypeError('A Calling action handler and positive timeouts are required.');
  }
  let owner = null;
  let current = null;
  let closed = false;
  let backgroundRejections = 0;
  const seen = new Map();
  const pending = new Set();

  function assertOpen() {
    if (closed) throw new CallStateError('CALLING_CLOSED');
  }

  function assertAgent(agentId) {
    if (!validAgentId(agentId)) throw new CallStateError('AGENT_INVALID');
  }

  function live(call = current) {
    return call != null && !TERMINAL.has(call.state);
  }

  function ownerReady(agentId = owner?.agentId) {
    return owner != null && owner.agentId === agentId && owner.ready && now() - owner.lastSeen < leaseMs;
  }

  function remember(callId) {
    seen.delete(callId);
    seen.set(callId, now() + SEEN_TTL_MS);
    while (seen.size > MAX_SEEN) seen.delete(seen.keys().next().value);
  }

  function clearDescriptions(call) {
    call.offerSdp = null;
    call.answerSdp = null;
    call.preaccepted = false;
  }

  function finish(call) {
    if (call.callId != null) remember(call.callId);
    clearDescriptions(call);
    call.callId = null;
    call.state = 'ended';
    call.error = null;
    call.errorCode = null;
    call.diagnostic = null;
    call.cleanupRequested = false;
    if (owner != null && !owner.ready) owner = null;
  }

  function snapshot(agentId) {
    return {
      ready: ownerReady(agentId),
      busy: (owner != null && owner.agentId !== agentId) || (live() && current.ownerId !== agentId),
      call: current?.ownerId === agentId ? {
        id: current.id,
        state: current.state,
        ...(current.error ? { error: current.error } : {}),
        ...(current.errorCode ? { errorCode: current.errorCode } : {}),
        ...(current.diagnostic ? { diagnostic: { ...current.diagnostic } } : {}),
      } : null,
    };
  }

  function track(promise) {
    pending.add(promise);
    promise.then(() => pending.delete(promise), () => pending.delete(promise));
    return promise;
  }

  function uncertain(call, error) {
    if (!live(call)) return;
    clearDescriptions(call);
    call.state = 'uncertain';
    // Keep the first meaningful provider failure visible through later polls or
    // a less informative cleanup failure. A confirmed terminal event clears it.
    if (!call.errorCode || (call.errorCode === 'CALL_ACTION_UNCONFIRMED' && error.code !== 'CALL_ACTION_UNCONFIRMED')) {
      call.error = error.message;
      call.errorCode = error.code;
      call.diagnostic = error.diagnostic || null;
    }
  }

  function requireCall(agentId, id) {
    assertOpen();
    assertAgent(agentId);
    sweep();
    if (!current || current.id !== id || current.ownerId !== agentId || owner?.agentId !== agentId) {
      throw new CallStateError('CALL_NOT_FOUND');
    }
    return current;
  }

  function requireNoOperation(call) {
    if (call.operation != null) throw new CallStateError('CALL_ACTION_BUSY');
  }

  // Every provider action starts in a microtask, so ingest() never waits for Graph.
  // Human actions reject concurrent attempts; technical cleanup waits for an
  // in-flight action before sending reject/terminate for the same call.
  function operate(call, perform, action) {
    const operation = Promise.resolve().then(perform);
    call.operation = operation;
    const result = operation.then(
      () => snapshot(call.ownerId),
      error => {
        const safe = providerError(error, action);
        uncertain(call, safe);
        throw safe;
      },
    ).finally(() => {
      call.operation = null;
      if (live(call) && call.cleanupRequested) startCleanup(call);
    });
    return track(result);
  }

  function requestCleanup(call) {
    if (!live(call) || call.cleanupAttempted) return;
    call.cleanupRequested = true;
    call.cleanupAction = call.state === 'ringing' ? 'reject' : 'terminate';
    call.state = 'ending';
    clearDescriptions(call);
    if (call.operation == null) startCleanup(call);
  }

  function startCleanup(call) {
    if (!live(call) || !call.cleanupRequested || call.operation != null || call.cleanupAttempted) return;
    call.cleanupRequested = false;
    call.cleanupAttempted = true;
    const actualId = call.callId;
    // A failed background cleanup is represented as uncertain state. It does not
    // cause an unhandled rejection or an automatic retry of a Graph mutation.
    operate(call, async () => {
      if (!live(call)) return;
      await sendAction(call.cleanupAction, { callId: actualId });
      if (live(call)) finish(call);
    }, call.cleanupAction).catch(() => {});
  }

  function rejectUnassigned(callId) {
    // A burst of signed calls must not create an unbounded number of pending
    // network requests. Overflow remains unanswered and expires on Meta's side.
    if (backgroundRejections >= MAX_BACKGROUND_REJECTIONS) return;
    backgroundRejections++;
    track(Promise.resolve().then(() => sendAction('reject', { callId })).catch(() => {}).finally(() => { backgroundRejections--; }));
  }

  function sweep() {
    const time = now();
    for (const [id, expires] of seen) if (expires <= time) seen.delete(id);
    if (owner != null && time - owner.lastSeen >= leaseMs) {
      owner.ready = false;
      if (live()) requestCleanup(current);
      else owner = null;
    }
    if (live() && (current.state === 'ringing' ? current.ringExpires <= time : current.setupExpires != null && current.state === 'connecting' && current.setupExpires <= time)) {
      requestCleanup(current);
    }
  }

  function setReady(agentId, ready) {
    assertOpen();
    assertAgent(agentId);
    if (typeof ready !== 'boolean') throw new CallStateError('AGENT_INVALID');
    sweep();
    if ((owner != null && owner.agentId !== agentId) || (live() && current.ownerId !== agentId)) throw new CallStateError('AGENT_BUSY');
    if (!ready) {
      if (live()) throw new CallStateError('CALL_ACTIVE');
      owner = null;
    } else {
      owner = { agentId, ready: true, lastSeen: now() };
      if (current != null && !live() && current.ownerId !== agentId) current = null;
    }
    return snapshot(agentId);
  }

  function getState(agentId) {
    assertOpen();
    assertAgent(agentId);
    sweep();
    if (owner?.agentId === agentId) owner.lastSeen = now();
    return snapshot(agentId);
  }

  function getOffer(agentId, id) {
    const call = requireCall(agentId, id);
    if (!ownerReady(agentId)) throw new CallStateError('AGENT_NOT_READY');
    if (call.state !== 'ringing' || call.offerSdp == null) throw new CallStateError('CALL_STATE_CONFLICT');
    return { sdp: call.offerSdp };
  }

  function ingest(events) {
    assertOpen();
    if (!Array.isArray(events) || events.length > MAX_EVENTS || events.some(event => event == null || !['connect', 'terminate'].includes(event.kind) || !validCallId(event.callId) || (event.kind === 'connect' && !validSdp(event.offerSdp)))) {
      throw new CallStateError('CALL_EVENT_INVALID');
    }
    sweep();
    for (const event of events) {
      if (event.kind === 'terminate') {
        remember(event.callId);
        if (current?.callId === event.callId && live()) finish(current);
        continue;
      }
      if (current?.callId === event.callId || seen.has(event.callId)) continue;
      remember(event.callId);
      if (!ownerReady() || live()) {
        rejectUnassigned(event.callId);
        continue;
      }
      current = {
        id: randomUUID(),
        callId: event.callId,
        ownerId: owner.agentId,
        state: 'ringing',
        offerSdp: event.offerSdp,
        answerSdp: null,
        preaccepted: false,
        ringExpires: now() + ringTimeoutMs,
        setupExpires: null,
        operation: null,
        cleanupRequested: false,
        cleanupAttempted: false,
        cleanupAction: null,
        error: null,
        errorCode: null,
        diagnostic: null,
      };
    }
  }

  function answer(agentId, id, sdp) {
    const call = requireCall(agentId, id);
    requireNoOperation(call);
    if (!ownerReady(agentId)) throw new CallStateError('AGENT_NOT_READY');
    if (call.state !== 'ringing') throw new CallStateError('CALL_STATE_CONFLICT');
    if (!validSdp(sdp)) throw new CallStateError('CALL_SDP_INVALID');
    call.state = 'connecting';
    call.offerSdp = null;
    call.answerSdp = sdp;
    call.setupExpires = now() + SETUP_TIMEOUT_MS;
    const actualId = call.callId;
    return operate(call, async () => {
      if (!live(call) || call.cleanupRequested) return;
      await sendAction('pre_accept', { callId: actualId, sdp });
      if (!live(call)) return;
      if (!ownerReady(agentId) || now() >= call.setupExpires || call.cleanupRequested || closed) {
        requestCleanup(call);
        return;
      }
      call.preaccepted = true;
    }, 'pre_accept');
  }

  function accept(agentId, id) {
    const call = requireCall(agentId, id);
    requireNoOperation(call);
    if (!ownerReady(agentId)) throw new CallStateError('AGENT_NOT_READY');
    if (call.state !== 'connecting' || !call.preaccepted || call.answerSdp == null) throw new CallStateError('CALL_STATE_CONFLICT');
    const actualId = call.callId;
    const sdp = call.answerSdp;
    // The caller invokes this only after the browser reports ICE/DTLS connected.
    // This broker cannot independently observe the browser transport state.
    return operate(call, async () => {
      if (!live(call) || call.cleanupRequested) return;
      await sendAction('accept', { callId: actualId, sdp });
      if (!live(call)) return;
      if (!ownerReady(agentId) || now() >= call.setupExpires || call.cleanupRequested || closed) {
        requestCleanup(call);
        return;
      }
      clearDescriptions(call);
      call.setupExpires = null;
      call.state = 'active';
    }, 'accept');
  }

  function endCall(agentId, id, rejectionOnly) {
    const call = requireCall(agentId, id);
    requireNoOperation(call);
    if (!live(call) || (rejectionOnly && call.state !== 'ringing') || call.state === 'ending') throw new CallStateError('CALL_STATE_CONFLICT');
    const action = call.state === 'ringing' ? 'reject' : 'terminate';
    const actualId = call.callId;
    call.state = 'ending';
    clearDescriptions(call);
    return operate(call, async () => {
      if (!live(call)) return;
      await sendAction(action, { callId: actualId });
      if (live(call)) finish(call);
    }, action);
  }

  function close() {
    if (closed) return;
    closed = true;
    if (owner != null) owner.ready = false;
    if (live()) requestCleanup(current);
    else owner = null;
  }

  async function idle() {
    while (pending.size > 0) await Promise.allSettled([...pending]);
  }

  return {
    setReady, getState, getOffer, ingest, answer, accept,
    reject: (agentId, id) => endCall(agentId, id, true),
    hangup: (agentId, id) => endCall(agentId, id, false),
    sweep, close, idle,
  };
}
