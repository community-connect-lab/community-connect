import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, stat } from 'node:fs/promises';
import { loadLocalEnvironment, readConfig } from '../lib/config.mjs';
import { AppError } from '../lib/meta-api.mjs';
import { MAX_AUDIO_BYTES, readTranscriptionConfig, validateRawWav, checkTranscriptionModelAccess, transcribeAudio } from '../lib/transcription.mjs';

// Explicit account probe. No key, audio, transcript, file path or provider body
// is printed. Run only on synthetic audio supplied deliberately by the operator.
try {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') {
    console.log('Usage: node scripts/check-transcription.mjs [--models-only | --audio SYNTHETIC_WAV_PATH]');
    console.log('Default: check model visibility only. --audio additionally transcribes the supplied synthetic speech recording.');
  } else {
    if (!(args.length === 0 || (args.length === 1 && args[0] === '--models-only') || (args.length === 2 && args[0] === '--audio' && args[1] && !args[1].startsWith('--')))) {
      throw new AppError('TRANSCRIPTION_CHECK_ARGUMENTS', 'Use --models-only or --audio with a synthetic WAV path. No request was sent.', 400);
    }
    loadLocalEnvironment(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
    const base = readConfig();
    const config = readTranscriptionConfig({ ...process.env, MODEL_API_KEY: base.apiKey });
    let audio;
    if (args[0] === '--audio') {
      try {
        const metadata = await stat(args[1]);
        if (!metadata.isFile() || metadata.size > MAX_AUDIO_BYTES) throw new Error('invalid');
        audio = await readFile(args[1]);
      } catch { throw new AppError('TRANSCRIPTION_CHECK_AUDIO', 'Could not read the supplied synthetic WAV within the audio size limit. No request was sent.', 400); }
      validateRawWav(audio, config);
    }
    await checkTranscriptionModelAccess(config);
    console.log('TRANSCRIPTION_MODEL_VISIBLE: The target model is listed for this account. This check alone does not prove transcription endpoint access.');
    if (audio) {
      const result = await transcribeAudio(audio, config);
      console.log(`TRANSCRIPTION_CHECK_PASSED: A real upload returned a validated result with ${result.transcript.length} transcript characters and ${result.turns.length} turns. No transcript text, key, audio or raw response logged.`);
    }
  }
} catch (error) {
  console.error(error instanceof AppError ? `${error.code}: ${error.message}` : 'TRANSCRIPTION_CHECK_FAILED: The check could not complete. No credentials or source/provider content were logged.');
  process.exitCode = 1;
}
