import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { AppError, generateDraft } from './lib/meta-api.mjs';
import { isApiKeyConfigured, loadLocalEnvironment, readConfig } from './lib/config.mjs';
import { scenario, simulateDraft } from './lib/scenario.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const assets = new Map([
  ['/', ['public/index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['public/index.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['public/styles.css', 'text/css; charset=utf-8']],
  ['/app.mjs', ['public/app.mjs', 'text/javascript; charset=utf-8']],
  ['/workflow.mjs', ['public/workflow.mjs', 'text/javascript; charset=utf-8']],
  ['/brand-icon.svg', ['assets/meta-app-icon.svg', 'image/svg+xml']],
]);
const MAX_BODY_BYTES = 65536;
const MAX_NOTES = 12000;

function json(response, status, data) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(data));
}

function readJson(request) {
  return new Promise((resolveBody, reject) => {
    let size = 0;
    let rejected = false;
    const chunks = [];
    request.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        if (!rejected) reject(new AppError('BODY_TOO_LARGE', 'Request is too large. Use at most 12,000 characters of synthetic notes.', 413));
        rejected = true;
        chunks.length = 0;
      } else if (!rejected) chunks.push(chunk);
    });
    request.on('end', () => {
      if (rejected) return;
      try {
        resolveBody(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new AppError('INVALID_JSON', 'The request must contain valid JSON.', 400));
      }
    });
    request.on('error', () => reject(new AppError('REQUEST_ERROR', 'The request could not be read. Your browser edits have not been changed.', 400)));
  });
}

export function createApp(config, { generate = generateDraft } = {}) {
  let generating = false;
  const server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    try {
      const port = server.address()?.port;
      const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
      if (!hosts.includes(request.headers.host)) {
        throw new AppError('INVALID_HOST', 'Open this app through its local localhost address.', 403);
      }
      const url = new URL(request.url, `http://${request.headers.host}`);
      const pathname = url.pathname;
      if (request.method === 'GET' && pathname === '/api/bootstrap') {
        json(response, 200, { scenario, apiConfigured: isApiKeyConfigured(config.apiKey), model: config.model });
        return;
      }
      if (pathname === '/api/draft') {
        if (request.method !== 'POST') {
          response.setHeader('Allow', 'POST');
          throw new AppError('METHOD_NOT_ALLOWED', 'Use POST to generate a draft.', 405);
        }
        const origin = request.headers.origin;
        if ((origin && origin !== `http://${request.headers.host}`) ||
            (request.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(request.headers['sec-fetch-site']))) {
          throw new AppError('INVALID_ORIGIN', 'Generate drafts from this app’s local browser page.', 403);
        }
        if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] || '')) {
          throw new AppError('INVALID_CONTENT_TYPE', 'Send notes as application/json.', 415);
        }
        const body = await readJson(request);
        if (!body || typeof body !== 'object' || Array.isArray(body) ||
            Object.keys(body).some(key => !['notes', 'mode'].includes(key))) {
          throw new AppError('INVALID_REQUEST', 'Provide only synthetic notes and the selected generation mode.', 400);
        }
        if (typeof body.notes !== 'string' || !body.notes.trim() || body.notes.length > MAX_NOTES) {
          throw new AppError('INVALID_NOTES', 'Enter between 1 and 12,000 characters of synthetic notes.', 400);
        }
        if (!['meta', 'simulation'].includes(body.mode)) {
          throw new AppError('INVALID_MODE', 'Explicitly select Meta API or simulation mode.', 400);
        }
        if (body.mode === 'simulation') {
          json(response, 200, simulateDraft(body.notes));
          return;
        }
        if (!isApiKeyConfigured(config.apiKey)) {
          throw new AppError('MODEL_NOT_CONFIGURED', 'Set MODEL_API_KEY in the backend environment or local .env, then restart the server. Your notes and draft are preserved. Simulation is available only when explicitly selected.', 503);
        }
        if (generating) {
          throw new AppError('GENERATION_BUSY', 'A Meta draft is already being generated. Wait for it to finish before retrying.', 429);
        }
        generating = true;
        try {
          const result = await generate(body.notes, config);
          json(response, 200, result);
        } finally {
          generating = false;
        }
        return;
      }
      const asset = assets.get(pathname);
      if (request.method === 'GET' && asset) {
        const content = await readFile(resolve(root, asset[0]));
        response.writeHead(200, { 'Content-Type': asset[1] });
        response.end(content);
        return;
      }
      throw new AppError('NOT_FOUND', 'Not found.', 404);
    } catch (error) {
      // Never serialize/log request bodies, upstream error bodies, environment or stacks.
      const safe = error instanceof AppError ? error : new AppError('INTERNAL_ERROR', 'The request could not be completed. Your notes and draft are preserved.', 500);
      if (!response.headersSent && !response.destroyed) json(response, safe.status, { error: { code: safe.code, message: safe.message } });
      else response.end();
    }
  });
  server.headersTimeout = 10000;
  server.requestTimeout = 15000;
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    loadLocalEnvironment(root);
    const config = readConfig();
    const server = createApp(config);
    server.on('error', () => {
      console.error('Could not start the local server. Check whether PORT is already in use.');
      process.exitCode = 1;
    });
    server.listen(config.port, '127.0.0.1', () => {
      console.log(`Community Connect: http://localhost:${config.port}`);
      console.log('Synthetic scenario only. Live Calling and transcription are not implemented.');
      console.log(isApiKeyConfigured(config.apiKey) ? 'Backend key configured; run npm.cmd run check:api to verify access.' : 'Backend key missing. Add it locally and restart, or explicitly select simulation.');
    });
  } catch (error) {
    console.error(error instanceof AppError ? `${error.code}: ${error.message}` : 'Could not initialize the local server. Check local configuration.');
    process.exitCode = 1;
  }
}
