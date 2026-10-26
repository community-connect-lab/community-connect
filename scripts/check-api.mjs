import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadLocalEnvironment, readConfig, isApiKeyConfigured } from '../lib/config.mjs';
import { AppError, requestModelText, generateDraft } from '../lib/meta-api.mjs';
import { scenario } from '../lib/scenario.mjs';

// Explicit opt-in smoke request. Never print the key, provider body, or raw model output.
try {
  loadLocalEnvironment(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
  const config = readConfig();
  if (!isApiKeyConfigured(config.apiKey)) {
    throw new AppError('MODEL_NOT_CONFIGURED', 'Enter the replacement MODEL_API_KEY locally in .env or the backend environment, then rerun this check. No API request was sent.', 503);
  }
  if (process.argv.includes('--draft')) {
    await generateDraft(scenario.notes, config);
    console.log('API_DRAFT_CHECK_PASSED: Real Meta API returned a completed, validated four-field draft from the synthetic scenario. No draft text, key or raw response logged.');
  } else {
    const result = await requestModelText(config, {
      instructions: 'This is a synthetic connectivity check. Reply with exactly OK, with no punctuation or explanation.',
      input: 'SYNTHETIC DEMO: confirm this small API check by replying OK.',
      maxOutputTokens: 1024,
    });
    if (result.text.trim() !== 'OK') {
      console.error('API_CHECK_UNEXPECTED_TEXT: The API returned completed text, but it did not match the requested OK response. No response text was logged.');
      process.exitCode = 1;
    } else {
      console.log('API_CHECK_PASSED: Real Meta API request completed; assistant output_text parsed and matched OK. store:false; no key or raw response logged.');
    }
  }
} catch (error) {
  console.error(error instanceof AppError ? `${error.code}: ${error.message}` : 'API_CHECK_FAILED: Could not complete the real API check. No credentials or raw response were logged.');
  process.exitCode = 1;
}
