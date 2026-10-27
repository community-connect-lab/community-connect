const ProcessorBase = globalThis.AudioWorkletProcessor ?? class { constructor() { this.port = { postMessage() {} }; } };

export class CommunityConnectPcmProcessor extends ProcessorBase {
  constructor(options = {}) {
    super();
    const requested = options.processorOptions ?? {};
    this.targetRate = requested.targetRate === 24000 ? 24000 : 16000;
    this.inputRate = globalThis.sampleRate || 48000;
    this.maxSamples = Math.max(1, Math.min(this.targetRate * 300, Number(requested.maxSamples) || this.targetRate * 300));
    this.buffer = new Int16Array(4096); this.used = 0; this.total = 0; this.phase = 0; this.sum = 0; this.inputCount = 0; this.stopped = false;
    this.port.onmessage = event => { if (event.data?.type === 'stop') this.finish('stopped'); };
  }
  flush() {
    if (!this.used) return;
    const samples = this.buffer.slice(0, this.used);
    this.port.postMessage({ type: 'pcm', samples: samples.buffer }, [samples.buffer]); this.used = 0;
  }
  finish(reason) {
    if (this.stopped) return;
    this.stopped = true; this.flush(); this.port.postMessage({ type: 'done', reason });
  }
  process(inputs, outputs) {
    if (this.stopped) return false;
    const channels = inputs[0] ?? [];
    const length = channels[0]?.length ?? outputs[0]?.[0]?.length ?? 0;
    for (let i = 0; i < length; i++) {
      let sample = 0;
      for (const channel of channels) sample += channel[i] || 0;
      if (channels.length) sample /= channels.length;
      this.sum += sample; this.inputCount++; this.phase += this.targetRate;
      if (this.phase >= this.inputRate) {
        this.phase -= this.inputRate;
        const value = Math.max(-1, Math.min(1, this.sum / this.inputCount));
        this.sum = 0; this.inputCount = 0;
        this.buffer[this.used++] = Math.round(value < 0 ? value * 32768 : value * 32767); this.total++;
        if (this.used === this.buffer.length) this.flush();
        if (this.total >= this.maxSamples) { this.finish('limit'); return false; }
      }
    }
    return true;
  }
}

globalThis.registerProcessor?.('community-connect-pcm', CommunityConnectPcmProcessor);
