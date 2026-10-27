import { AppError } from './meta-api.mjs';

export const TRANSCRIPTION_API_URL = 'https://api.meta.ai/v1/asr/transcribe';
export const TRANSCRIPTION_MODEL = 'muse-voice-transcribe-1.0';
export const MAX_AUDIO_BYTES = 16 * 1024 * 1024;
export const MAX_AUDIO_SECONDS = 300;
export const MAX_TRANSCRIPT_CHARS = 36000;
const MODELS_URL = 'https://api.meta.ai/v1/models';
const MAX_RESPONSE_BYTES = 1024 * 1024;
const placeholder = /replace[_ -]?with|your[_ -].*key|placeholder|change[_ -]?me|<[^>]+>/i;

function failure(code, message, status = 502) { return new AppError(code, message, status); }
function invalidConfig() { return failure('TRANSCRIPTION_CONFIG_ERROR', 'Check the backend transcription configuration.', 503); }

function positiveInteger(value, fallback, maximum) {
  if (value != null && typeof value !== 'number' && typeof value !== 'string') throw invalidConfig();
  const number = value == null || value === '' ? fallback : Number(value);
  if (!Number.isInteger(number) || number < 1 || number > maximum) throw invalidConfig();
  return number;
}

function configuration(config = {}, requireKey = false) {
  if (config == null || typeof config !== 'object' || Array.isArray(config)) throw invalidConfig();
  const apiKey = typeof config.apiKey === 'string' ? config.apiKey.trim() : '';
  if (apiKey.length > 8192 || /\s/.test(apiKey)) throw invalidConfig();
  if (requireKey && (!apiKey || placeholder.test(apiKey))) {
    throw failure('TRANSCRIPTION_NOT_CONFIGURED', 'Set the backend Model API key and confirm transcription access. Manual notes have been kept.', 503);
  }
  const model = config.model || TRANSCRIPTION_MODEL;
  if (typeof model !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(model) || (apiKey && model.includes(apiKey)) || (config.apiUrl && config.apiUrl !== TRANSCRIPTION_API_URL)) throw invalidConfig();
  return {
    apiKey, apiUrl: TRANSCRIPTION_API_URL, model,
    timeoutMs: positiveInteger(config.timeoutMs, 120000, 120000),
    maxAudioBytes: positiveInteger(config.maxAudioBytes, MAX_AUDIO_BYTES, MAX_AUDIO_BYTES),
    maxAudioDurationSeconds: positiveInteger(config.maxAudioDurationSeconds, MAX_AUDIO_SECONDS, MAX_AUDIO_SECONDS),
  };
}

// Like the notes config, an absent key does not prevent the manual workflow from
// starting. Requests fail before network access until a real key is configured.
export function readTranscriptionConfig(env = process.env) {
  if (env == null || typeof env !== 'object' || Array.isArray(env)) throw invalidConfig();
  return configuration({
    apiKey: typeof env.MODEL_API_KEY === 'string' ? env.MODEL_API_KEY : '',
    model: env.TRANSCRIPTION_MODEL || TRANSCRIPTION_MODEL,
    timeoutMs: env.TRANSCRIPTION_TIMEOUT_MS,
    maxAudioDurationSeconds: env.TRANSCRIPTION_MAX_SECONDS,
  });
}

function invalidAudio() {
  return failure('INVALID_TRANSCRIPTION_AUDIO', 'Use a complete mono, 16-bit PCM WAV recording at 16 kHz or 24 kHz.', 400);
}

export function validateRawWav(audio, { maxAudioBytes = MAX_AUDIO_BYTES, maxAudioDurationSeconds = MAX_AUDIO_SECONDS } = {}) {
  const maxBytes = positiveInteger(maxAudioBytes, MAX_AUDIO_BYTES, MAX_AUDIO_BYTES);
  const maxSeconds = positiveInteger(maxAudioDurationSeconds, MAX_AUDIO_SECONDS, MAX_AUDIO_SECONDS);
  if (!(audio instanceof Uint8Array)) throw invalidAudio();
  if (audio.byteLength > maxBytes) throw failure('TRANSCRIPTION_AUDIO_TOO_LARGE', 'The recording exceeds the audio size limit. Use a shorter recording.', 413);
  if (audio.byteLength < 44) throw invalidAudio();
  const bytes = Buffer.from(audio.buffer, audio.byteOffset, audio.byteLength);
  if (bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE' || bytes.readUInt32LE(4) + 8 !== bytes.length) throw invalidAudio();
  let offset = 12, chunks = 0, format = null, dataOffset = -1, dataBytes = 0;
  while (offset < bytes.length) {
    if (++chunks > 128 || bytes.length - offset < 8) throw invalidAudio();
    const id = bytes.toString('ascii', offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    const start = offset + 8;
    const next = start + size + (size % 2);
    if (next > bytes.length) throw invalidAudio();
    if (id === 'fmt ') {
      if (format != null || size < 16 || size > 64) throw invalidAudio();
      format = {
        encoding: bytes.readUInt16LE(start), channels: bytes.readUInt16LE(start + 2),
        sampleRate: bytes.readUInt32LE(start + 4), byteRate: bytes.readUInt32LE(start + 8),
        blockAlign: bytes.readUInt16LE(start + 12), bitsPerSample: bytes.readUInt16LE(start + 14),
      };
    } else if (id === 'data') {
      if (dataOffset !== -1 || size < 2 || size % 2) throw invalidAudio();
      dataOffset = start; dataBytes = size;
    }
    offset = next;
  }
  if (!format || dataOffset < 0 || format.encoding !== 1 || format.channels !== 1 || format.bitsPerSample !== 16 ||
      ![16000, 24000].includes(format.sampleRate) || format.blockAlign !== 2 || format.byteRate !== format.sampleRate * 2) throw invalidAudio();
  const durationSeconds = dataBytes / format.byteRate;
  if (durationSeconds > maxSeconds) throw failure('TRANSCRIPTION_AUDIO_TOO_LONG', 'The recording exceeds the duration limit. Use a shorter recording.', 400);
  return { sampleRate: format.sampleRate, channels: 1, bitsPerSample: 16, durationSeconds, dataOffset, dataBytes };
}

function canonicalWav(audio, information) {
  // Strip extra RIFF metadata before upload. Only the bounded PCM samples and a
  // fresh 44-byte header leave this backend.
  const output = Buffer.alloc(44 + information.dataBytes);
  output.write('RIFF', 0); output.writeUInt32LE(output.length - 8, 4); output.write('WAVEfmt ', 8);
  output.writeUInt32LE(16, 16); output.writeUInt16LE(1, 20); output.writeUInt16LE(1, 22);
  output.writeUInt32LE(information.sampleRate, 24); output.writeUInt32LE(information.sampleRate * 2, 28);
  output.writeUInt16LE(2, 32); output.writeUInt16LE(16, 34); output.write('data', 36);
  output.writeUInt32LE(information.dataBytes, 40);
  output.set(audio.subarray(information.dataOffset, information.dataOffset + information.dataBytes), 44);
  return output;
}

function upstreamError(status) {
  if (status === 401 || status === 403) return failure('TRANSCRIPTION_AUTH_ERROR', 'Meta did not accept transcription access. Check the backend key and account model access. Manual notes have been kept.', 503);
  if (status === 429) return failure('TRANSCRIPTION_RATE_LIMITED', 'The transcription limit or quota was reached. Retry later; manual notes have been kept.', 503);
  if (status === 413) return failure('TRANSCRIPTION_AUDIO_TOO_LARGE', 'Meta rejected the recording size. Use a shorter recording.', 413);
  if (status >= 500) return failure('TRANSCRIPTION_UNAVAILABLE', 'Meta transcription is temporarily unavailable. Manual notes have been kept.');
  return failure('TRANSCRIPTION_BAD_RESPONSE', 'Meta did not accept the transcription request. Check the recording format and model access. Manual notes have been kept.');
}

function badResponse() { return failure('TRANSCRIPTION_BAD_RESPONSE', 'Meta returned an invalid or incomplete transcription. Manual notes have been kept.'); }

async function boundedJson(response, controller, abortError) {
  if (!response.body || typeof response.body.getReader !== 'function') throw badResponse();
  const reader = response.body.getReader();
  const buffer = new Uint8Array(MAX_RESPONSE_BYTES);
  let length = 0;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  controller.signal.addEventListener('abort', cancel, { once: true });
  try {
    if (Number(response.headers?.get('content-length')) > MAX_RESPONSE_BYTES) { cancel(); throw badResponse(); }
    while (true) {
      const { value, done } = await reader.read();
      if (controller.signal.aborted) throw abortError();
      if (done) break;
      if (!(value instanceof Uint8Array) || value.byteLength > MAX_RESPONSE_BYTES - length) { cancel(); throw badResponse(); }
      buffer.set(value, length); length += value.byteLength;
    }
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length))); } catch { throw badResponse(); }
  } finally {
    controller.signal.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
}

async function requestJson(url, config, request, { fetchImpl = globalThis.fetch, signal } = {}) {
  if (signal?.aborted) throw failure('TRANSCRIPTION_CANCELLED', 'Transcription was cancelled. Manual notes have been kept.', 409);
  if (signal != null && (typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function')) throw invalidConfig();
  const controller = new AbortController();
  let timer, stopped;
  let rejectStopped;
  const stopPromise = new Promise((_, reject) => { rejectStopped = reject; });
  const stop = (code, message, status) => {
    if (stopped) return;
    stopped = failure(code, message, status);
    controller.abort(); rejectStopped(stopped);
  };
  const cancel = () => stop('TRANSCRIPTION_CANCELLED', 'Transcription was cancelled. Manual notes have been kept.', 409);
  signal?.addEventListener('abort', cancel, { once: true });
  timer = setTimeout(() => stop('TRANSCRIPTION_TIMEOUT', 'Transcription took too long. Manual notes have been kept; retry when ready.', 504), config.timeoutMs);
  try {
    return await Promise.race([
      (async () => {
        const response = await fetchImpl(url, {
          ...request, redirect: 'error', signal: controller.signal,
          headers: { Authorization: `Bearer ${config.apiKey}`, Accept: 'application/json' },
        });
        if (!response.ok) {
          void response.body?.cancel().catch(() => {});
          throw upstreamError(response.status);
        }
        const payload = await boundedJson(response, controller, () => stopped || badResponse());
        if (JSON.stringify(payload).includes(config.apiKey)) throw badResponse();
        return payload;
      })(), stopPromise,
    ]);
  } catch (error) {
    if (stopped) throw stopped;
    if (error instanceof AppError) throw error;
    throw failure('TRANSCRIPTION_NETWORK_ERROR', 'The gateway could not reach Meta transcription. Manual notes have been kept.');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
  }
}

function transcriptResult(payload, config) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || payload.error != null || payload.type === 'error' ||
      typeof payload.sessionId !== 'string' || !payload.sessionId || payload.sessionId.length > 512 ||
      typeof payload.transcript !== 'string' || payload.transcript.length > MAX_TRANSCRIPT_CHARS || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(payload.transcript) ||
      !Number.isInteger(payload.audioDurationMs) || payload.audioDurationMs < 0 || payload.audioDurationMs > config.maxAudioDurationSeconds * 1000 + 1000 ||
      !Array.isArray(payload.turns) || payload.turns.length > 2000) throw badResponse();
  let lastId = -1, textLength = 0;
  const turns = payload.turns.map(turn => {
    if (!turn || typeof turn !== 'object' || Array.isArray(turn) || !Number.isInteger(turn.turnId) || turn.turnId < 0 || turn.turnId > 2147483647 || turn.turnId <= lastId ||
        !Number.isInteger(turn.startMs) || !Number.isInteger(turn.endMs) || turn.startMs < 0 || turn.endMs < turn.startMs || turn.endMs > payload.audioDurationMs + 1000 ||
        typeof turn.transcript !== 'string' || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(turn.transcript)) throw badResponse();
    lastId = turn.turnId; textLength += turn.transcript.length;
    if (textLength > MAX_TRANSCRIPT_CHARS) throw badResponse();
    return { startMs: turn.startMs, endMs: turn.endMs, transcript: turn.transcript.trim(), speaker: typeof turn.speaker === 'string' && /^[A-Z]{1,3}$/.test(turn.speaker) ? turn.speaker : 'unknown' };
  });
  if (!payload.transcript.trim()) throw failure('TRANSCRIPTION_EMPTY', 'Meta returned no speech text. Manual notes have been kept; try a clearer recording or continue with notes alone.', 422);
  return {
    transcript: payload.transcript.trim(), turns, audioDurationMs: payload.audioDurationMs,
    provenance: { kind: 'meta_transcription', model: config.model, generatedAt: new Date().toISOString() },
  };
}

export async function transcribeAudio(audio, suppliedConfig, options = {}) {
  const config = configuration(suppliedConfig, true);
  const information = validateRawWav(audio, config);
  const form = new FormData();
  form.append('request', new Blob([JSON.stringify({ model: config.model, mode: 'DIARIZATION', audioEncoding: 'WAV' })], { type: 'application/json' }));
  form.append('audio', new Blob([canonicalWav(audio, information)], { type: 'audio/wav' }), 'call.wav');
  const payload = await requestJson(TRANSCRIPTION_API_URL, config, { method: 'POST', body: form }, options);
  return transcriptResult(payload, config);
}

export async function checkTranscriptionModelAccess(suppliedConfig, options = {}) {
  const config = configuration(suppliedConfig, true);
  const payload = await requestJson(MODELS_URL, config, { method: 'GET' }, options);
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.data)) throw badResponse();
  if (!payload.data.some(item => item != null && typeof item === 'object' && item.id === config.model)) {
    throw failure('TRANSCRIPTION_MODEL_UNAVAILABLE', 'The transcription model is not listed for this account. Confirm account access before enabling transcription.', 503);
  }
  return { available: true, model: config.model };
}
