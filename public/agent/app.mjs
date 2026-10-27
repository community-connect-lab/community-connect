const TERMINAL = new Set(['ended']);
const LIVE = new Set(['ringing', 'connecting', 'active', 'ending', 'uncertain']);

class DeskError extends Error {
  constructor(kind, message) { super(message); this.kind = kind; }
}

function stopTracks(stream) { for (const track of stream?.getTracks?.() ?? []) track.stop(); }

export function createAgentController({
  fetchImpl = globalThis.fetch.bind(globalThis),
  mediaDevices = globalThis.navigator?.mediaDevices,
  PeerConnection = globalThis.RTCPeerConnection,
  clientId = globalThis.crypto?.randomUUID(),
  view = { render() {}, clearToken() {}, setRemoteStream() {}, playAudio: async () => {} },
  setTimer = globalThis.setTimeout,
  clearTimer = globalThis.clearTimeout,
  secureContext = globalThis.isSecureContext,
} = {}) {
  let token = '', epoch = 0, revision = 0, pollTimer, pollInFlight = false;
  let microphone = null, peer = null, sender = null, outgoingTrack = null, answerAbort = null;
  let answerTask = null, cleanupQueued = false, mediaRevision = 0;
  let state = { connected: false, ready: false, busy: false, call: null, command: '', error: '', message: 'Connect your desk, then choose Ready to receive.', audioBlocked: false, microphoneActive: false };
  const pending = new Set();
  const snapshot = () => ({ ...state, call: state.call ? { ...state.call } : null });
  const render = () => { state.microphoneActive = Boolean(microphone); view.render(snapshot()); };

  function closePeer() {
    mediaRevision++;
    answerAbort?.abort(); answerAbort = null;
    if (peer) { peer.ontrack = null; peer.onconnectionstatechange = null; peer.close(); }
    peer = null; sender = null;
    outgoingTrack?.stop(); outgoingTrack = null;
    view.setRemoteStream(null); state.audioBlocked = false;
  }
  function stopMedia() { closePeer(); stopTracks(microphone); microphone = null; state.ready = false; }
  function disconnect(message = 'Desk disconnected. Microphone off.') {
    epoch++; revision++; token = ''; clearTimer(pollTimer); pollTimer = undefined;
    for (const request of pending) request.abort(); pending.clear();
    stopMedia(); state = { ...state, connected: false, ready: false, busy: false, call: null, command: '', error: '', message };
    view.clearToken(); render();
  }
  async function api(path, { method = 'GET', body, timeout = 25000 } = {}) {
    if (!token) throw new DeskError('auth', 'Connect your desk again.');
    const controller = new AbortController(); pending.add(controller);
    const timeoutId = setTimer(() => controller.abort(), timeout);
    try {
      const response = await fetchImpl(`/agent/api${path}`, {
        method, headers: { Authorization: `Bearer ${token}`, 'X-Agent-ID': clientId, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: controller.signal, cache: 'no-store', credentials: 'omit', redirect: 'error',
      });
      if (response.status === 401 || response.status === 403) throw new DeskError('auth', 'Access was not accepted. Check the agent token and reconnect.');
      let data;
      try { data = await response.json(); } catch { throw new DeskError('network', 'The gateway returned an unreadable response.'); }
      if (!response.ok) throw new DeskError('action', response.status === 409 ? 'The call or agent state changed. Check the current call before trying again.' : 'The gateway could not confirm this action. Use Hang up if the call needs cleanup.');
      return data;
    } catch (error) {
      if (error instanceof DeskError) throw error;
      throw new DeskError('network', 'Connection to the gateway was lost. Microphone stopped. Reconnect to check the call.');
    } finally { clearTimer(timeoutId); pending.delete(controller); }
  }
  function failure(error, fallback = 'This action could not be completed.') {
    if (error?.kind === 'auth' || error?.kind === 'network') {
      const message = error.message; disconnect(message); state.error = message; render();
    } else { state.error = error instanceof DeskError ? error.message : fallback; render(); }
  }
  function applyServer(data) {
    if (!data || typeof data !== 'object' || typeof data.ready !== 'boolean' || typeof data.busy !== 'boolean') throw new DeskError('network', 'The gateway returned an unexpected desk state.');
    const previous = state.call;
    state.busy = data.busy; state.ready = data.ready && Boolean(microphone);
    if (data.call != null && (typeof data.call.id !== 'string' || (!LIVE.has(data.call.state) && !TERMINAL.has(data.call.state)))) throw new DeskError('network', 'The gateway returned an unexpected call state.');
    state.call = data.call ? { id: data.call.id, state: data.call.state } : null;
    if (peer && (!state.call || state.call.id !== previous?.id || TERMINAL.has(state.call.state) || ['ending', 'uncertain'].includes(state.call.state))) closePeer();
    if (!data.ready && microphone && state.command !== 'ready') { closePeer(); stopTracks(microphone); microphone = null; }
    if (state.call?.state === 'uncertain') state.error = 'The gateway could not confirm the call’s state. Use Hang up to clean up this call.';
    render();
  }
  function schedulePoll() {
    clearTimer(pollTimer);
    if (state.connected) pollTimer = setTimer(() => { pollTimer = undefined; void poll(); }, 1000);
  }
  async function poll() {
    if (!state.connected || pollInFlight) return;
    pollInFlight = true; const currentEpoch = epoch, currentRevision = revision;
    try { const data = await api('/state', { timeout: 6000 }); if (currentEpoch === epoch && currentRevision === revision && state.command !== 'ready') applyServer(data); }
    catch (error) { if (currentEpoch === epoch && currentRevision === revision) failure(error); }
    finally { pollInFlight = false; if (currentEpoch === epoch) schedulePoll(); }
  }
  async function connect(suppliedToken) {
    if (state.connected || state.command) return;
    if (typeof suppliedToken !== 'string' || suppliedToken.trim().length < 32 || suppliedToken.length > 4096 || /[\r\n]/.test(suppliedToken) || !clientId) {
      state.error = 'Enter the dedicated agent access token, at least 32 characters long.'; view.clearToken(); render(); return;
    }
    token = suppliedToken.trim(); const currentEpoch = ++epoch; revision++;
    state.command = 'connect'; state.error = ''; render();
    try {
      const data = await api('/state', { timeout: 6000 });
      if (currentEpoch !== epoch) return;
      state.connected = true; state.command = ''; state.message = 'Desk connected. Put on a headset, then choose Ready to receive.';
      applyServer(data); view.clearToken(); schedulePoll();
    } catch (error) { if (currentEpoch === epoch) { token = ''; state.command = ''; failure(error); view.clearToken(); } }
  }
  async function setReady(ready) {
    if (!state.connected || state.command || state.busy || (ready === false && state.call && LIVE.has(state.call.state))) return;
    const currentEpoch = epoch; revision++; state.command = 'ready'; state.error = ''; render();
    let acquired;
    try {
      if (ready) {
        if (!secureContext || !mediaDevices?.getUserMedia || !PeerConnection) throw new DeskError('media', 'Microphone and calling require HTTPS or localhost in a supported browser.');
        acquired = await mediaDevices.getUserMedia({ audio: true, video: false });
        if (currentEpoch !== epoch) { stopTracks(acquired); return; }
        if (!(acquired.getAudioTracks?.().length > 0)) throw new DeskError('media', 'No microphone audio track is available. Check your headset and try again.');
      }
      const data = await api('/ready', { method: 'POST', body: { ready } });
      if (currentEpoch !== epoch) { stopTracks(acquired); return; }
      if (ready) {
        stopTracks(microphone); microphone = acquired; acquired = null;
        for (const track of microphone.getAudioTracks()) track.addEventListener?.('ended', () => {
          if (microphone?.getAudioTracks().includes(track)) disconnect('The microphone stopped. Desk disconnected. Reconnect and check your headset.');
        }, { once: true });
      }
      else stopMedia();
      revision++; state.command = ''; state.error = ''; state.message = ready ? 'Ready for an incoming WhatsApp test call. Keep this tab open.' : 'Not receiving calls. Microphone off.';
      if (data && typeof data.ready === 'boolean' && typeof data.busy === 'boolean') applyServer(data); else { state.ready = ready; render(); }
    } catch (error) {
      stopTracks(acquired);
      if (currentEpoch !== epoch) return;
      revision++; state.command = '';
      const mediaError = !error?.kind ? new DeskError('media', error?.name === 'NotAllowedError' ? 'Microphone access was not allowed. Allow it in your browser, then choose Ready again.' : 'The microphone is unavailable. Check your headset and browser audio settings.') : error;
      failure(mediaError);
    }
  }
  function waitForPeer(connection, eventName, satisfied, signal, timeoutMs, label) {
    return new Promise((resolve, reject) => {
      let timer;
      const cleanup = () => { clearTimer(timer); connection.removeEventListener(eventName, changed); signal.removeEventListener('abort', cancelled); };
      const done = (error) => { cleanup(); if (error) reject(error); else resolve(); };
      const changed = () => {
        if (satisfied()) done();
        else if (['failed', 'closed'].includes(connection.connectionState)) done(new DeskError('media', 'The audio connection failed. Use Hang up to clean up this call.'));
      };
      const cancelled = () => done(new DeskError('stale', 'The call changed before audio was ready.'));
      if (signal.aborted) { reject(new DeskError('stale', 'The call changed before audio was ready.')); return; }
      if (satisfied()) { resolve(); return; }
      if (['failed', 'closed'].includes(connection.connectionState)) { reject(new DeskError('media', 'The audio connection failed. Use Hang up to clean up this call.')); return; }
      connection.addEventListener(eventName, changed); signal.addEventListener('abort', cancelled, { once: true });
      timer = setTimer(() => done(new DeskError('media', label)), timeoutMs);
    });
  }
  async function runAnswer() {
    if (!state.connected || !state.ready || !microphone || state.command || state.call?.state !== 'ringing') return;
    const id = state.call.id, currentEpoch = epoch;
    revision++; state.command = 'answer'; state.error = ''; state.message = 'Preparing the audio connection…'; render();
    const operation = new AbortController(); answerAbort = operation;
    const current = () => currentEpoch === epoch && !operation.signal.aborted && state.call?.id === id && !TERMINAL.has(state.call.state) && !['ending', 'uncertain'].includes(state.call.state);
    let preaccepted = false;
    try {
      const offer = await api(`/calls/${encodeURIComponent(id)}/offer`);
      if (!current()) return;
      const connection = new PeerConnection(); peer = connection;
      connection.ontrack = event => {
        if (!current()) return;
        const stream = event.streams?.[0] ?? (globalThis.MediaStream ? new MediaStream([event.track]) : null);
        view.setRemoteStream(stream); void playAudio();
      };
      await connection.setRemoteDescription({ type: 'offer', sdp: offer.sdp });
      if (!current()) return;
      const transceiver = connection.getTransceivers().find(item => item.receiver?.track?.kind === 'audio');
      if (!transceiver || transceiver.sender?.track) throw new DeskError('media', 'The caller’s audio offer is not supported. Reject or hang up this call.');
      transceiver.direction = 'sendrecv'; sender = transceiver.sender;
      const answerDescription = await connection.createAnswer();
      await connection.setLocalDescription(answerDescription);
      await waitForPeer(connection, 'icegatheringstatechange', () => connection.iceGatheringState === 'complete', operation.signal, 12000, 'Audio network setup took too long. Use Hang up to clean up this call.');
      if (!current()) return;
      const sdp = connection.localDescription?.sdp;
      if (typeof sdp !== 'string' || !sdp || sdp.length > 65536) throw new DeskError('media', 'The browser could not prepare a supported audio answer.');
      const prepared = await api(`/calls/${encodeURIComponent(id)}/answer`, { method: 'POST', body: { sdp } });
      if (currentEpoch !== epoch) return;
      revision++;
      applyServer(prepared);
      preaccepted = true;
      if (!current() || !prepared.ready || prepared.call?.id !== id || prepared.call.state !== 'connecting') return;
      state.message = 'Connecting audio… Your microphone is not sent until acceptance.'; render();
      await waitForPeer(connection, 'connectionstatechange', () => connection.connectionState === 'connected', operation.signal, 15000, 'The audio connection could not be established. Use Hang up to clean up this call.');
      if (!current()) return;
      const accepted = await api(`/calls/${encodeURIComponent(id)}/accept`, { method: 'POST', body: {} });
      if (currentEpoch !== epoch) return;
      revision++;
      applyServer(accepted);
      if (!current() || !accepted.ready || accepted.call?.id !== id || accepted.call.state !== 'active') return;
      outgoingTrack = microphone.getAudioTracks()[0].clone();
      await sender.replaceTrack(outgoingTrack);
      if (!current()) { outgoingTrack?.stop(); return; }
      state.error = ''; state.message = 'Call connected. Listen and write your own fictional notes.';
      connection.onconnectionstatechange = () => {
        if (peer !== connection || !state.connected) return;
        if (connection.connectionState === 'failed') { closePeer(); state.call = { id, state: 'uncertain' }; state.error = 'The audio connection failed. Use Hang up to end this call.'; render(); }
      };
      await playAudio();
    } catch (error) {
      if (currentEpoch !== epoch) return;
      closePeer();
      if (error?.kind === 'stale' || state.call?.id !== id || TERMINAL.has(state.call.state)) return;
      if (preaccepted || error?.kind === 'action') state.call = { id, state: 'uncertain' };
      failure(error, 'The browser could not connect audio. Use Hang up or Reject to clean up this call.');
    } finally {
      if (currentEpoch === epoch) { revision++; state.command = cleanupQueued ? 'hangup' : ''; render(); }
      if (answerAbort === operation) answerAbort = null;
    }
  }
  function answer() {
    if (answerTask) return answerTask;
    answerTask = runAnswer().finally(() => { answerTask = null; });
    return answerTask;
  }
  async function callAction(action) {
    if (!state.connected || (state.command && !(state.command === 'answer' && action === 'hangup')) || !state.call || !LIVE.has(state.call.state)) return;
    if (action === 'reject' && state.call.state !== 'ringing') return;
    const id = state.call.id, currentEpoch = epoch; revision++;
    if (state.command === 'answer') {
      cleanupQueued = true; closePeer(); state.command = 'hangup'; state.message = 'Cancelling audio setup and ending this call…'; render();
      await answerTask; cleanupQueued = false;
      if (currentEpoch !== epoch || !state.connected) return;
      if (state.call?.id !== id || TERMINAL.has(state.call.state)) { state.command = ''; render(); return; }
    }
    state.command = action; state.error = ''; render();
    try {
      const result = await api(`/calls/${encodeURIComponent(id)}/${action}`, { method: 'POST', body: {} });
      if (currentEpoch !== epoch || state.call?.id !== id) return;
      revision++; closePeer(); applyServer(result); state.message = action === 'reject' ? 'Call rejected. Ready for the next test conversation.' : 'Call ended. Finish your notes before opening the summary app.';
    } catch (error) {
      if (currentEpoch !== epoch) return;
      closePeer(); if (state.call?.id === id && !TERMINAL.has(state.call.state)) state.call = { id, state: 'uncertain' };
      failure(error);
    } finally { if (currentEpoch === epoch) { revision++; state.command = ''; render(); } }
  }
  async function playAudio() {
    const currentMedia = mediaRevision;
    try { await view.playAudio(); if (currentMedia === mediaRevision) state.audioBlocked = false; }
    catch { if (currentMedia === mediaRevision) state.audioBlocked = true; }
    if (currentMedia === mediaRevision) render();
  }
  render();
  return { connect, setReady, answer, reject: () => callAction('reject'), hangup: () => callAction('hangup'), disconnect, poll, playAudio, snapshot };
}

export function mountAgentDesk(document, window = globalThis) {
  const element = id => document.getElementById(id);
  const audio = element('remote-audio');
  const callCopy = {
    ringing: ['INCOMING WHATSAPP CALL', 'A caller is waiting.', 'Choose Answer when you are ready to speak.'],
    connecting: ['CONNECTING AUDIO', 'Making the connection.', 'Keep this tab open while the audio connection is established.'],
    active: ['LIVE CONVERSATION', 'You’re connected.', 'Listen, speak and make your own notes.'],
    ending: ['ENDING CONVERSATION', 'Closing the call.', 'Waiting for the gateway to confirm.'],
    ended: ['CONVERSATION FINISHED', 'A moment for your notes.', 'Capture the confirmed facts and anything that still needs checking.'],
    uncertain: ['CALL NEEDS ATTENTION', 'Check this connection.', 'Use Hang up to clean up the call before starting another.'],
  };
  const text = (id, value) => { if (element(id).textContent !== value) element(id).textContent = value; };
  const controller = createAgentController({ view: {
    clearToken() { element('agent-token').value = ''; },
    setRemoteStream(stream) { audio.srcObject = stream; },
    async playAudio() { if (audio.srcObject) await audio.play(); },
    render(state) {
      element('connect-form').hidden = state.connected;
      element('connected-controls').hidden = !state.connected;
      element('disconnect-button').hidden = !state.connected;
      element('disconnect-button').disabled = Boolean(state.command) || LIVE.has(state.call?.state);
      element('connect-button').disabled = Boolean(state.command);
      element('agent-token').disabled = Boolean(state.command);
      text('connect-button', state.command === 'connect' ? 'Connecting…' : 'Connect desk');
      text('connection-badge', state.connected ? 'CONNECTED' : 'DISCONNECTED'); element('connection-badge').dataset.connected = String(state.connected);
      text('ready-button', state.command === 'ready' ? 'Please wait…' : state.ready ? 'Stop receiving' : 'Ready to receive');
      element('ready-button').disabled = Boolean(state.command) || state.busy || LIVE.has(state.call?.state);
      text('readiness-title', state.busy ? 'Another desk is receiving calls.' : state.ready ? 'Ready for a conversation.' : 'Get ready to listen.');
      text('readiness-help', state.busy ? 'This demo supports one ready agent at a time.' : state.ready ? 'Your microphone is ready. No microphone audio is sent until a call is accepted.' : 'Put on a headset, then allow microphone access when you choose Ready.');
      const copy = callCopy[state.call?.state] ?? ['YOUR NEXT CONVERSATION', state.ready ? 'Ready when someone calls.' : state.connected ? 'Choose Ready to receive.' : 'Connect your desk to begin.', 'Only an incoming WhatsApp test call will appear here.'];
      element('call-stage').dataset.state = state.call?.state ?? 'idle';
      text('call-kicker', copy[0]); text('call-title', copy[1]); text('call-help', copy[2]);
      const live = LIVE.has(state.call?.state), ringing = state.call?.state === 'ringing';
      element('call-actions').hidden = !live;
      element('answer-button').hidden = !ringing; element('reject-button').hidden = !ringing;
      element('hangup-button').hidden = !live || (ringing && !['answer', 'hangup'].includes(state.command));
      element('answer-button').disabled = Boolean(state.command) || !state.ready;
      element('reject-button').disabled = Boolean(state.command);
      element('hangup-button').disabled = Boolean(state.command && state.command !== 'answer') || state.call?.state === 'ending';
      text('answer-button', state.command === 'answer' ? 'Connecting…' : 'Answer call');
      text('hangup-button', state.command === 'hangup' ? 'Ending…' : 'Hang up');
      element('play-audio-button').hidden = !state.audioBlocked;
      text('activity-status', state.message); text('error-message', state.error); element('error-message').hidden = !state.error;
      text('microphone-status', state.microphoneActive ? 'Microphone ready · no recording' : 'Microphone off');
    },
  } });
  element('connect-form').addEventListener('submit', event => { event.preventDefault(); void controller.connect(element('agent-token').value); });
  element('ready-button').addEventListener('click', () => { void controller.setReady(!controller.snapshot().ready); });
  element('answer-button').addEventListener('click', () => { void controller.answer(); });
  element('reject-button').addEventListener('click', () => { void controller.reject(); });
  element('hangup-button').addEventListener('click', () => { void controller.hangup(); });
  element('disconnect-button').addEventListener('click', () => controller.disconnect());
  element('play-audio-button').addEventListener('click', () => { void controller.playAudio(); });
  element('agent-notes').addEventListener('input', () => text('notes-count', `${element('agent-notes').value.length.toLocaleString()} / 12,000`));
  window.addEventListener('beforeunload', event => { if (LIVE.has(controller.snapshot().call?.state)) { event.preventDefault(); event.returnValue = ''; } });
  window.addEventListener('pagehide', () => controller.disconnect());
  return controller;
}

if (typeof document !== 'undefined') mountAgentDesk(document);
