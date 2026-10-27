export const PCM_SAMPLE_RATE = 16000;
export const MAX_CAPTURE_SECONDS = 300;
export const MAX_CAPTURE_BYTES = 16000000;

export function encodePcmWav(chunks, sampleRate = PCM_SAMPLE_RATE, maxBytes = MAX_CAPTURE_BYTES) {
  if (![16000, 24000].includes(sampleRate) || !Array.isArray(chunks) || !chunks.every(chunk => chunk instanceof Int16Array)) throw new Error('Capture audio is invalid.');
  const count = chunks.reduce((total, chunk) => total + chunk.length, 0);
  if (!count || count > sampleRate * MAX_CAPTURE_SECONDS || 44 + count * 2 > maxBytes) throw new Error('Capture audio is empty or exceeds the limit.');
  const bytes = new ArrayBuffer(44 + count * 2), view = new DataView(bytes);
  const text = (offset, value) => { for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i)); };
  text(0, 'RIFF'); view.setUint32(4, 36 + count * 2, true); text(8, 'WAVE'); text(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  text(36, 'data'); view.setUint32(40, count * 2, true);
  let offset = 44;
  for (const chunk of chunks) for (const sample of chunk) { view.setInt16(offset, sample, true); offset += 2; }
  return new Blob([bytes], { type: 'audio/wav' });
}

// Preparing an AudioContext does not attach a stream or collect any samples.
// start() is invoked only after the human accepts the call and audio attaches.
export function createAudioCapture({
  AudioContextImpl = globalThis.AudioContext ?? globalThis.webkitAudioContext,
  AudioWorkletNodeImpl = globalThis.AudioWorkletNode,
  maxSeconds = MAX_CAPTURE_SECONDS, maxBytes = MAX_CAPTURE_BYTES,
  onProgress = () => {}, onEnded = () => {}, onError = () => {},
  setTimer = globalThis.setTimeout, clearTimer = globalThis.clearTimeout,
} = {}) {
  maxSeconds = Math.min(MAX_CAPTURE_SECONDS, Math.max(1, Number(maxSeconds) || MAX_CAPTURE_SECONDS));
  maxBytes = Math.min(MAX_CAPTURE_BYTES, Math.max(44, Number(maxBytes) || MAX_CAPTURE_BYTES));
  let context, node, mixer, mute, microphoneSource, remoteSource, preparation, finalResult, pendingStop;
  let chunks = [], sampleCount = 0, active = false, disposed = false, ended = false, stopTimer, queuedRemoteStream = null, receivedRemoteTrack = false;
  let settle, reject;
  const completed = new Promise((resolve, fail) => { settle = resolve; reject = fail; });
  completed.catch(() => {});

  async function release() {
    clearTimer(stopTimer);
    for (const source of [microphoneSource, remoteSource, mixer, node, mute]) { try { source?.disconnect(); } catch {} }
    if (node) node.port.onmessage = null;
    try { await context?.close(); } catch {}
    microphoneSource = remoteSource = mixer = node = mute = context = null;
  }
  async function finish(reason) {
    if (ended || disposed) return;
    ended = true; active = false;
    try {
      if (!receivedRemoteTrack) throw new Error('Caller audio was unavailable. No call audio was uploaded; manual notes are preserved.');
      const blob = encodePcmWav(chunks, PCM_SAMPLE_RATE, maxBytes);
      finalResult = { blob, seconds: sampleCount / PCM_SAMPLE_RATE, reason };
      chunks = []; await release(); settle(finalResult);
      try { onEnded(finalResult); } catch {}
    } catch {
      chunks = []; await release(); const error = new Error(receivedRemoteTrack ? 'Call capture could not be finalized. Your manual notes are preserved.' : 'Caller audio was unavailable. No call audio was uploaded; manual notes are preserved.'); reject(error); try { onError(error); } catch {}
    }
  }
  function prepare() {
    if (preparation) return preparation;
    preparation = (async () => {
      if (disposed || !AudioContextImpl || !AudioWorkletNodeImpl) throw new Error('This browser cannot capture PCM call audio. You can still use manual notes.');
      try { context = new AudioContextImpl({ sampleRate: PCM_SAMPLE_RATE }); } catch { context = new AudioContextImpl(); }
      if (!context.audioWorklet || !Number.isFinite(context.sampleRate) || context.sampleRate < PCM_SAMPLE_RATE) throw new Error('PCM call capture is unavailable in this browser.');
      await context.resume();
      await context.audioWorklet.addModule('/agent/pcm-capture-worklet.mjs');
      if (disposed) throw new Error('Call capture was cancelled.');
    })();
    preparation.catch(() => { void release(); });
    return preparation;
  }
  async function start({ microphoneStream, remoteStream } = {}) {
    await prepare();
    if (disposed || ended || active || !microphoneStream?.getAudioTracks?.().length) throw new Error('The accepted call microphone is unavailable for capture.');
    mixer = context.createGain(); mixer.gain.value = 0.5;
    node = new AudioWorkletNodeImpl(context, 'community-connect-pcm', {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCount: 1, channelCountMode: 'explicit',
      processorOptions: { targetRate: PCM_SAMPLE_RATE, maxSamples: Math.min(Math.floor(maxSeconds * PCM_SAMPLE_RATE), Math.floor((maxBytes - 44) / 2)) },
    });
    node.port.onmessage = event => {
      if (disposed || ended) return;
      const data = event.data;
      if (data?.type === 'pcm' && data.samples instanceof ArrayBuffer) {
        const chunk = new Int16Array(data.samples);
        if (sampleCount + chunk.length > maxSeconds * PCM_SAMPLE_RATE || 44 + (sampleCount + chunk.length) * 2 > maxBytes) { void dispose(); reject(new Error('Call capture exceeded its limit.')); return; }
        chunks.push(chunk); sampleCount += chunk.length;
        try { onProgress({ seconds: sampleCount / PCM_SAMPLE_RATE }); } catch {}
      } else if (data?.type === 'done') void finish(data.reason === 'limit' ? 'limit' : 'stopped');
    };
    mute = context.createGain(); mute.gain.value = 0;
    mixer.connect(node); node.connect(mute); mute.connect(context.destination);
    microphoneSource = context.createMediaStreamSource(microphoneStream); microphoneSource.connect(mixer);
    active = true; setRemoteStream(remoteStream ?? queuedRemoteStream);
  }
  function setRemoteStream(stream) {
    if (!stream?.getAudioTracks?.().length) return;
    queuedRemoteStream = stream;
    if (!active || disposed) return;
    try { remoteSource?.disconnect(); } catch {}
    remoteSource = context.createMediaStreamSource(stream); remoteSource.connect(mixer); receivedRemoteTrack = true;
  }
  function stop() {
    if (finalResult) return Promise.resolve(finalResult);
    if (ended) return completed;
    if (pendingStop) return pendingStop;
    if (!active || disposed) return Promise.resolve(null);
    node.port.postMessage({ type: 'stop' });
    stopTimer = setTimer(() => { void dispose(); reject(new Error('Capture did not finish safely. No audio was uploaded.')); }, 2000);
    pendingStop = completed;
    return pendingStop;
  }
  async function dispose() {
    if (disposed) return;
    disposed = true; active = false; chunks = []; finalResult = null;
    await release(); settle(null);
  }
  return { prepare, start, setRemoteStream, stop, dispose, get active() { return active; } };
}
