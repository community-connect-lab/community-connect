import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { AppError } from './meta-api.mjs';

export const META_API_URL = 'https://api.meta.ai/v1/responses';
export const DEFAULT_MODEL = 'muse-wonder-1.0';

export function loadLocalEnvironment(directory) {
  const path = resolve(directory, '.env');
  if (!existsSync(path)) return;
  try {
    // Node's native loader leaves existing process environment values in place.
    process.loadEnvFile(path);
  } catch {
    throw new AppError('ENV_FILE_ERROR', 'Could not load .env. Check its format locally; no contents were logged.', 503);
  }
}

export function isApiKeyConfigured(key) {
  return typeof key === 'string' && key.trim().length > 0 &&
    !/replace_with|your[_-].*key|placeholder|changeme/i.test(key);
}

export function readConfig(env = process.env) {
  const apiKey = (env.MODEL_API_KEY || '').trim();
  const apiUrl = (env.MODEL_API_URL || META_API_URL).trim();
  const model = (env.MODEL_API_MODEL || DEFAULT_MODEL).trim();
  const port = Number(env.PORT || 3000);
  const timeoutMs = Number(env.MODEL_API_TIMEOUT_MS || 60000);
  if (apiUrl !== META_API_URL) {
    throw new AppError('MODEL_CONFIG_ERROR', 'MODEL_API_URL must be https://api.meta.ai/v1/responses.', 503);
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(model) || (apiKey && model.includes(apiKey))) {
    throw new AppError('MODEL_CONFIG_ERROR', 'MODEL_API_MODEL must be a valid model identifier.', 503);
  }
  if (/[\r\n]/.test(apiKey)) {
    throw new AppError('MODEL_CONFIG_ERROR', 'Check the backend API key format locally.', 503);
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new AppError('SERVER_CONFIG_ERROR', 'PORT must be an integer from 1 to 65535.', 503);
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000) {
    throw new AppError('MODEL_CONFIG_ERROR', 'MODEL_API_TIMEOUT_MS must be between 1000 and 120000.', 503);
  }
  if (env.DEMO_MODE && env.DEMO_MODE !== 'true') {
    throw new AppError('DEMO_ONLY', 'This milestone requires DEMO_MODE=true and synthetic notes only.', 503);
  }
  return { apiKey, apiUrl, model, port, timeoutMs };
}
