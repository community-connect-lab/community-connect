import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { AppError } from '../lib/meta-api.mjs';
import {
  MAX_AUDIO_BYTES, MAX_TRANSCRIPT_CHARS, TRANSCRIPTION_API_URL, TRANSCRIPTION_MODEL,
  readTranscriptionConfig, validateRawWav, transcribeAudio, checkTranscriptionModelAccess,
} from '../lib/transcription.mjs';

const KEY = 'synthetic-model-key-test-only-1234567890';
const TEXT = 'The fictional caller requested Thursday. It has not been confirmed.';
const config = () => readTranscriptionConfig({ MODEL_API_KEY: KEY });
function wav({ sampleRate = 24000, dataBytes = sampleRate * 2, extraFormat = false } = {}) {
  const audio = Buffer.alloc(44 + dataBytes);
  audio.write('RIFF', 0); audio.writeUInt32LE(audio.length - 8, 4); audio.write('WAVEfmt ', 8);
  audio.writeUInt32LE(16, 16); audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22);
  audio.writeUInt32LE(sampleRate, 24); audio.writeUInt32LE(sampleRate * 2, 28);
  audio.writeUInt16LE(2, 32); audio.writeUInt16LE(16, 34); audio.write('data', 36); audio.writeUInt32LE(dataBytes, 40);
  if (!extraFormat) return audio;
  const extended = Buffer.concat([audio.subarray(0, 36), Buffer.alloc(2), audio.subarray(36)]);
  extended.writeUInt32LE(18, 16); extended.writeUInt32LE(extended.length - 8, 4);
  return extended;
}
function withMetadata(audio) {
  const marker = Buffer.from('synthetic-private-metadata-marker');
  const chunk = Buffer.alloc(8 + marker.length + marker.length % 2);
  chunk.write('JUNK', 0); chunk.writeUInt32LE(marker.length, 4); marker.copy(chunk, 8);
  const result = Buffer.concat([audio.subarray(0, 36), chunk, audio.subarray(36)]);
  result.writeUInt32LE(result.length - 8, 4);
  return result;
}
const payload = () => ({ sessionId: 'synthetic-provider-session', transcript: TEXT, audioDurationMs: 1000,
  turns: [{ turnId: 1, startMs: 0, endMs: 1000, transcript: TEXT, speaker: 'A' }] });
const response = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
const code = expected => error => error instanceof AppError && error.code === expected;

test('config has bounded defaults and never requires a key for manual-mode startup', async () => {
  const empty = readTranscriptionConfig({});
  assert.equal(empty.apiKey, '');
  assert.equal(empty.apiUrl, TRANSCRIPTION_API_URL);
  assert.equal(empty.model, TRANSCRIPTION_MODEL);
  assert.equal(empty.timeoutMs, 120000);
  assert.equal(empty.maxAudioBytes, MAX_AUDIO_BYTES);
  assert.equal(empty.maxAudioDurationSeconds, 300);
  for (const env of [null, { TRANSCRIPTION_MAX_SECONDS: '301' }, { TRANSCRIPTION_MAX_SECONDS: '0' }, { TRANSCRIPTION_TIMEOUT_MS: '120001' }, { TRANSCRIPTION_MODEL: '../unsafe' }, { MODEL_API_KEY: 'key\nvalue' }]) {
    assert.throws(() => readTranscriptionConfig(env), code('TRANSCRIPTION_CONFIG_ERROR'));
  }
  let requests = 0;
  for (const apiKey of ['', 'replace_with_your_model_key']) {
    await assert.rejects(transcribeAudio(wav(), { ...empty, apiKey }, { fetchImpl: () => { requests++; } }), code('TRANSCRIPTION_NOT_CONFIGURED'));
  }
  assert.equal(requests, 0);
});

test('WAV validation accepts complete mono integer PCM at 16/24 kHz, including a standard extended PCM fmt chunk', () => {
  for (const sampleRate of [16000, 24000]) {
    const result = validateRawWav(wav({ sampleRate }));
    assert.equal(result.durationSeconds, 1);
    assert.equal(result.channels, 1);
    assert.equal(result.bitsPerSample, 16);
    assert.equal(result.sampleRate, sampleRate);
    assert.equal(result.dataOffset, 44);
  }
  assert.equal(validateRawWav(wav({ extraFormat: true })).dataOffset, 46);
});

test('WAV validation rejects incomplete files, unsupported formats and inconsistent sample headers', () => {
  const invalid = [new Uint8Array(10), 'not-audio', wav({ dataBytes: 0 }), wav().subarray(0, 50)];
  for (const [offset, value, wide] of [[20, 3], [22, 2], [24, 44100, true], [28, 12345, true], [32, 4], [34, 32]]) {
    const audio = wav();
    wide ? audio.writeUInt32LE(value, offset) : audio.writeUInt16LE(value, offset);
    invalid.push(audio);
  }
  const duplicate = Buffer.concat([wav(), Buffer.from('data'), Buffer.from([2, 0, 0, 0, 0, 0])]);
  duplicate.writeUInt32LE(duplicate.length - 8, 4);
  invalid.push(duplicate);
  for (const audio of invalid) assert.throws(() => validateRawWav(audio), code('INVALID_TRANSCRIPTION_AUDIO'));
});

test('WAV byte and decoded-duration limits are enforced before network access', async () => {
  assert.throws(() => validateRawWav(Buffer.alloc(MAX_AUDIO_BYTES + 1)), code('TRANSCRIPTION_AUDIO_TOO_LARGE'));
  assert.throws(() => validateRawWav(wav({ dataBytes: 24000 * 2 * 301 })), code('TRANSCRIPTION_AUDIO_TOO_LONG'));
  let requests = 0;
  await assert.rejects(transcribeAudio(wav({ dataBytes: 96000 }), { ...config(), maxAudioDurationSeconds: 1 }, { fetchImpl: () => { requests++; } }), code('TRANSCRIPTION_AUDIO_TOO_LONG'));
  assert.equal(requests, 0);
});

test('multipart upload uses only official endpoint, header auth, JSON settings and canonical WAV without metadata', async () => {
  const original = withMetadata(wav());
  const result = await transcribeAudio(original, config(), { fetchImpl: async (url, request) => {
    assert.equal(url, TRANSCRIPTION_API_URL);
    assert.equal(request.method, 'POST');
    assert.equal(request.redirect, 'error');
    assert.equal(request.headers.Authorization, `Bearer ${KEY}`);
    assert.equal(request.headers.Accept, 'application/json');
    assert.equal(request.headers['Content-Type'], undefined);
    assert.deepEqual([...request.body.keys()], ['request', 'audio']);
    assert.deepEqual(JSON.parse(await request.body.get('request').text()), { model: TRANSCRIPTION_MODEL, mode: 'DIARIZATION', audioEncoding: 'WAV' });
    const uploaded = request.body.get('audio');
    assert.equal(uploaded.name, 'call.wav');
    assert.equal(uploaded.type, 'audio/wav');
    const bytes = Buffer.from(await uploaded.arrayBuffer());
    assert.deepEqual(bytes, wav());
    assert.ok(!bytes.includes(Buffer.from('metadata-marker')));
    return response(payload());
  } });
  assert.equal(result.transcript, TEXT);
  assert.equal(result.provenance.kind, 'meta_transcription');
  assert.equal(result.provenance.model, TRANSCRIPTION_MODEL);
  assert.ok(Number.isFinite(Date.parse(result.provenance.generatedAt)));
  assert.deepEqual(result.turns, [{ startMs: 0, endMs: 1000, transcript: TEXT, speaker: 'A' }]);
  assert.ok(!JSON.stringify(result).includes(KEY));
  assert.ok(!JSON.stringify(result).includes('synthetic-provider-session'));
});

test('speaker attribution remains model labels or unknown, never a verified caller identity', async () => {
  const value = payload();
  value.turns[0].speaker = 'Caller Ada';
  const result = await transcribeAudio(wav(), config(), { fetchImpl: async () => response(value) });
  assert.equal(result.turns[0].speaker, 'unknown');
  assert.ok(!JSON.stringify(result).includes('Caller Ada'));
});

test('an empty successful ASR response is an explicit empty-transcription failure', async () => {
  const value = { ...payload(), transcript: '  ', turns: [] };
  await assert.rejects(transcribeAudio(wav(), config(), { fetchImpl: async () => response(value) }), code('TRANSCRIPTION_EMPTY'));
});

test('upstream authentication, quota, rejection and unavailability errors never expose provider text', async () => {
  for (const [status, expected] of [[401, 'TRANSCRIPTION_AUTH_ERROR'], [403, 'TRANSCRIPTION_AUTH_ERROR'], [429, 'TRANSCRIPTION_RATE_LIMITED'], [413, 'TRANSCRIPTION_AUDIO_TOO_LARGE'], [500, 'TRANSCRIPTION_UNAVAILABLE'], [400, 'TRANSCRIPTION_BAD_RESPONSE'], [302, 'TRANSCRIPTION_BAD_RESPONSE']]) {
    await assert.rejects(transcribeAudio(wav(), config(), { fetchImpl: async () => new Response(`source-and-key-sentinel ${KEY}`, { status }) }), error => code(expected)(error) && !error.message.includes(KEY) && !error.message.includes('sentinel'));
  }
});

test('invalid JSON, incomplete schemas, unsafe echoes and excessive transcript output are discarded', async () => {
  const variants = [
    '{',
    { ...payload(), sessionId: null },
    { ...payload(), transcript: KEY },
    { ...payload(), transcript: 'x'.repeat(MAX_TRANSCRIPT_CHARS + 1) },
    { ...payload(), transcript: 'unsafe\0text' },
    { ...payload(), audioDurationMs: 99999999 },
    { ...payload(), turns: [{ turnId: 1, startMs: 30, endMs: 10, transcript: TEXT }] },
    { ...payload(), turns: [...payload().turns, ...payload().turns] },
    { ...payload(), error: { message: 'private-provider-sentinel' } },
  ];
  for (const value of variants) {
    await assert.rejects(transcribeAudio(wav(), config(), { fetchImpl: async () => typeof value === 'string' ? new Response(value) : response(value) }), error => code('TRANSCRIPTION_BAD_RESPONSE')(error) && !error.message.includes(KEY) && !error.message.includes('sentinel'));
  }
});

test('declared or streamed oversized responses and invalid UTF-8 are bounded', async () => {
  const responses = [
    () => new Response('{}', { headers: { 'Content-Length': String(1024 * 1024 + 1) } }),
    () => new Response(new Uint8Array(1024 * 1024 + 1)),
    () => new Response(new Uint8Array([255, 254, 253])),
  ];
  for (const make of responses) await assert.rejects(transcribeAudio(wav(), config(), { fetchImpl: async () => make() }), code('TRANSCRIPTION_BAD_RESPONSE'));
});

test('timeout covers a stalled fetch and a stalled response body', async () => {
  const options = { ...config(), timeoutMs: 20 };
  await assert.rejects(transcribeAudio(wav(), options, { fetchImpl: async () => new Promise(() => {}) }), code('TRANSCRIPTION_TIMEOUT'));
  await assert.rejects(transcribeAudio(wav(), options, { fetchImpl: async () => new Response(new ReadableStream({ start() {} })) }), code('TRANSCRIPTION_TIMEOUT'));
});

test('caller cancellation works before upload and while reading the response', async () => {
  const before = new AbortController(); before.abort();
  let requests = 0;
  await assert.rejects(transcribeAudio(wav(), config(), { signal: before.signal, fetchImpl: async () => { requests++; } }), code('TRANSCRIPTION_CANCELLED'));
  assert.equal(requests, 0);
  const during = new AbortController();
  const result = transcribeAudio(wav(), config(), { signal: during.signal, fetchImpl: async () => new Response(new ReadableStream({ start() {} })) });
  setTimeout(() => during.abort(), 10);
  await assert.rejects(result, code('TRANSCRIPTION_CANCELLED'));
});

test('network exceptions are sanitized rather than returning errors that contain source data or secrets', async () => {
  await assert.rejects(transcribeAudio(wav(), config(), { fetchImpl: async () => { throw new Error(`source-and-key-sentinel ${KEY}`); } }), error => code('TRANSCRIPTION_NETWORK_ERROR')(error) && !error.message.includes(KEY) && !error.message.includes('sentinel'));
  await assert.rejects(transcribeAudio(wav(), { ...config(), apiUrl: 'https://untrusted.invalid/transcribe' }, { fetchImpl: async () => { throw new Error('must-not-run'); } }), code('TRANSCRIPTION_CONFIG_ERROR'));
});

test('model visibility probe is a bounded authenticated GET and distinguishes unavailable models', async () => {
  const result = await checkTranscriptionModelAccess(config(), { fetchImpl: async (url, request) => {
    assert.equal(url, 'https://api.meta.ai/v1/models');
    assert.equal(request.method, 'GET');
    assert.equal(request.body, undefined);
    assert.equal(request.headers.Authorization, `Bearer ${KEY}`);
    return response({ data: [{ id: TRANSCRIPTION_MODEL }] });
  } });
  assert.deepEqual(result, { available: true, model: TRANSCRIPTION_MODEL });
  await assert.rejects(checkTranscriptionModelAccess(config(), { fetchImpl: async () => response({ data: [{ id: 'different-model' }] }) }), code('TRANSCRIPTION_MODEL_UNAVAILABLE'));
  await assert.rejects(checkTranscriptionModelAccess(config(), { fetchImpl: async () => response({ data: [{ id: TRANSCRIPTION_MODEL }], unsafe: KEY }) }), code('TRANSCRIPTION_BAD_RESPONSE'));
});

test('check-script help and argument errors run without any account request or secret output', () => {
  const help = spawnSync(process.execPath, ['scripts/check-transcription.mjs', '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--models-only/);
  const invalid = spawnSync(process.execPath, ['scripts/check-transcription.mjs', '--audio', '--help'], { encoding: 'utf8' });
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /TRANSCRIPTION_CHECK_ARGUMENTS/);
  assert.ok(!`${help.stdout}${help.stderr}${invalid.stdout}${invalid.stderr}`.includes(KEY));
});
