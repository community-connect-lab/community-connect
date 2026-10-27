import test from 'node:test';
import assert from 'node:assert/strict';
import { encodePcmWav, createAudioCapture } from '../public/agent/audio-capture.mjs';
import { CommunityConnectPcmProcessor } from '../public/agent/pcm-capture-worklet.mjs';

test('PCM WAV encoding has exact mono16k16bit headers, duration and signed samples', async () => {
  const blob = encodePcmWav([new Int16Array([-32768, 0, 32767]), new Int16Array([123])]);
  const bytes = await blob.arrayBuffer(), view = new DataView(bytes), ascii = (offset, count) => String.fromCharCode(...new Uint8Array(bytes, offset, count));
  assert.equal(ascii(0, 4), 'RIFF'); assert.equal(ascii(8, 4), 'WAVE'); assert.equal(ascii(36, 4), 'data');
  assert.equal(view.getUint16(20, true), 1); assert.equal(view.getUint16(22, true), 1); assert.equal(view.getUint32(24, true), 16000); assert.equal(view.getUint16(34, true), 16);
  assert.equal(view.getUint32(40, true), 8); assert.equal(view.getInt16(44, true), -32768); assert.equal(view.getInt16(48, true), 32767); assert.equal(blob.type, 'audio/wav');
  assert.throws(() => encodePcmWav([]), /empty/); assert.throws(() => encodePcmWav([new Int16Array(10)], 16000, 50), /limit/);
});

test('worklet resamples variable block sizes, clips safely and flushes on stop', () => {
  const processor = new CommunityConnectPcmProcessor({ processorOptions: { targetRate: 16000 } }), messages = [];
  processor.port.postMessage = message => messages.push(message);
  for (const length of [127, 257, 96]) processor.process([[new Float32Array(length).fill(0.5)]], [[new Float32Array(length)]]);
  processor.port.onmessage({ data: { type: 'stop' } });
  const samples = messages.filter(item => item.type === 'pcm').flatMap(item => [...new Int16Array(item.samples)]);
  assert.equal(samples.length, 160); assert.ok(samples.every(value => value === 16384)); assert.equal(messages.at(-1).type, 'done'); assert.equal(messages.at(-1).reason, 'stopped');
  assert.equal(processor.process([], [[new Float32Array(128)]]), false);
});

test('worklet enforces the exact sample limit rather than storing unbounded audio', () => {
  const processor = new CommunityConnectPcmProcessor({ processorOptions: { targetRate: 16000, maxSamples: 10 } }), messages = [];
  processor.port.postMessage = message => messages.push(message);
  assert.equal(processor.process([[new Float32Array(128).fill(5)]], [[new Float32Array(128)]]), false);
  const samples = messages.filter(item => item.type === 'pcm').flatMap(item => [...new Int16Array(item.samples)]);
  assert.equal(samples.length, 10); assert.ok(samples.every(value => value === 32767)); assert.equal(messages.at(-1).reason, 'limit');
});

function audioFixture() {
  const contexts = [], nodes = [], streams = [], ended = [], errors = [];
  const connection = () => ({ gain: { value: 1 }, connect() {}, disconnect() {} });
  class Context {
    constructor() { this.sampleRate = 48000; this.destination = {}; this.audioWorklet = { addModule: async path => assert.equal(path, '/agent/pcm-capture-worklet.mjs') }; this.closed = false; contexts.push(this); }
    async resume() {} async close() { this.closed = true; } createGain() { return connection(); }
    createMediaStreamSource(stream) { streams.push(stream); return connection(); }
  }
  class Node {
    constructor() { this.port = { onmessage: null, postMessage: message => { if (message.type === 'stop') { this.port.onmessage({ data: { type: 'pcm', samples: new Int16Array([100, -100]).buffer } }); this.port.onmessage({ data: { type: 'done', reason: 'stopped' } }); } } }; nodes.push(this); }
    connect() {} disconnect() {}
  }
  const stream = () => ({ getAudioTracks: () => [{ kind: 'audio' }] });
  const capture = createAudioCapture({ AudioContextImpl: Context, AudioWorkletNodeImpl: Node, onEnded: result => ended.push(result), onError: error => errors.push(error) });
  return { capture, contexts, nodes, streams, ended, errors, stream };
}

test('prepare captures nothing; accepted start mixes microphone+remote and produces WAV without playing the mix', async () => {
  const f = audioFixture(); await f.capture.prepare(); assert.equal(f.streams.length, 0); assert.equal(f.nodes.length, 0);
  await f.capture.start({ microphoneStream: f.stream(), remoteStream: f.stream() }); assert.equal(f.streams.length, 2);
  const result = await f.capture.stop(); assert.equal(result.blob.type, 'audio/wav'); assert.equal(f.ended.length, 1); assert.equal(f.contexts[0].closed, true);
});

test('no caller track is a visible capture failure and does not produce an uploadable agent-only WAV', async () => {
  const f = audioFixture(); await f.capture.prepare(); await f.capture.start({ microphoneStream: f.stream() });
  await assert.rejects(f.capture.stop(), /Caller audio was unavailable/); assert.equal(f.ended.length, 0); assert.equal(f.errors.length, 1); assert.equal(f.contexts[0].closed, true);
});

test('a remote track arriving during preparation is queued and attached only when accepted capture starts', async () => {
  const f = audioFixture(), remote = f.stream(); await f.capture.prepare(); f.capture.setRemoteStream(remote); assert.equal(f.streams.length, 0);
  await f.capture.start({ microphoneStream: f.stream() }); assert.equal(f.streams[1], remote); const result = await f.capture.stop(); assert.ok(result.blob instanceof Blob);
});
