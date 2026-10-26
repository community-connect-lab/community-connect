import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { WebhookError, readWebhookConfig, verifyChallenge, verifySignature, summarizeWebhook } from './lib/whatsapp-webhook.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const MAX_BODY_BYTES = 1024 * 1024;

export function webhookEnvironment(env = process.env, local = {}) {
  // The summary app's local PORT=3000 and model key are not used by this service.
  return {
    WHATSAPP_VERIFY_TOKEN: env.WHATSAPP_VERIFY_TOKEN ?? local.WHATSAPP_VERIFY_TOKEN,
    WHATSAPP_APP_SECRET: env.WHATSAPP_APP_SECRET ?? local.WHATSAPP_APP_SECRET,
    WHATSAPP_PHONE_NUMBER_ID: env.WHATSAPP_PHONE_NUMBER_ID ?? local.WHATSAPP_PHONE_NUMBER_ID,
    PORT: env.PORT ?? env.WEBHOOK_PORT ?? local.WEBHOOK_PORT ?? '10000',
  };
}

function reply(response, status, data) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(data));
}

function readBody(request) {
  return new Promise((resolveBody, reject) => {
    let bytes = 0;
    let rejected = false;
    // Fixed storage also bounds allocation overhead for many tiny network chunks.
    const buffer = Buffer.alloc(MAX_BODY_BYTES);
    request.on('data', chunk => {
      if (bytes + chunk.length > MAX_BODY_BYTES) {
        if (!rejected) reject(new WebhookError('BODY_TOO_LARGE', 'Webhook body exceeds the allowed size.', 413));
        rejected = true;
      } else if (!rejected) {
        chunk.copy(buffer, bytes);
        bytes += chunk.length;
      }
    });
    request.on('end', () => { if (!rejected) resolveBody(buffer.subarray(0, bytes)); });
    request.on('error', () => reject(new WebhookError('REQUEST_ERROR', 'Could not read the webhook request.', 400)));
    request.on('aborted', () => reject(new WebhookError('REQUEST_ERROR', 'The webhook request was interrupted.', 400)));
  });
}

export function createWebhookServer(config, { onEvent = () => {} } = {}) {
  const server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    try {
      const url = new URL(request.url, 'http://localhost');
      if (request.method === 'GET' && url.pathname === '/health') {
        reply(response, 200, { status: 'ok', service: 'community-connect-webhook', callHandling: 'not_implemented' });
        return;
      }
      if (url.pathname !== '/webhooks/whatsapp') {
        request.resume();
        throw new WebhookError('NOT_FOUND', 'Not found.', 404);
      }
      if (request.method === 'GET') {
        const challenge = verifyChallenge(url.searchParams, config.verifyToken);
        response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end(challenge);
        return;
      }
      if (request.method !== 'POST') {
        request.resume();
        response.setHeader('Allow', 'GET, POST');
        throw new WebhookError('METHOD_NOT_ALLOWED', 'Use GET for verification or POST for webhook events.', 405);
      }
      if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] || '')) {
        request.resume();
        throw new WebhookError('INVALID_CONTENT_TYPE', 'Webhook events must use application/json.', 415);
      }
      const signature = request.headers['x-hub-signature-256'];
      if (typeof signature !== 'string' || !/^sha256=[a-fA-F0-9]{64}$/.test(signature)) {
        request.resume();
        throw new WebhookError('INVALID_SIGNATURE', 'Webhook signature verification failed.', 403);
      }
      const body = await readBody(request);
      if (!verifySignature(body, signature, config.appSecret)) {
        throw new WebhookError('INVALID_SIGNATURE', 'Webhook signature verification failed.', 403);
      }
      let payload;
      try { payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)); } catch {
        throw new WebhookError('INVALID_JSON', 'Webhook body must contain valid JSON.', 400);
      }
      const summary = summarizeWebhook(payload, config.phoneNumberId);
      // Deliberately pass counts only. No caller IDs, numbers, SDP, messages or payload storage.
      await onEvent(summary);
      reply(response, 200, { received: true });
    } catch (error) {
      const safe = error instanceof WebhookError ? error : new WebhookError('INTERNAL_ERROR', 'The webhook request could not be completed.', 500);
      if (!response.headersSent && !response.destroyed) reply(response, safe.status, { error: { code: safe.code, message: safe.message } });
      else if (!response.destroyed) response.end();
    }
  });
  server.headersTimeout = 10000;
  server.requestTimeout = 15000;
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    let local = {};
    const localPath = resolve(root, '.env');
    if (existsSync(localPath)) {
      try { local = parseEnv(readFileSync(localPath, 'utf8')); } catch {
        throw new WebhookError('ENV_FILE_ERROR', 'Could not read local webhook configuration. No file contents were logged.', 503);
      }
    }
    const config = readWebhookConfig(webhookEnvironment(process.env, local));
    const server = createWebhookServer(config, {
      onEvent: summary => console.log(JSON.stringify({ event: 'whatsapp_webhook_received', ...summary })),
    });
    server.on('error', () => {
      console.error('Webhook server could not start. Check PORT and service configuration.');
      process.exitCode = 1;
    });
    server.listen(config.port, '0.0.0.0', () => {
      console.log(`Community Connect webhook listening on port ${config.port}. Health: /health; callback: /webhooks/whatsapp`);
      console.log('Receiver only. Answering calls, media, recording and transcription are not implemented.');
    });
  } catch (error) {
    console.error(error instanceof WebhookError ? `${error.code}: ${error.message}` : 'Webhook startup failed. Check backend configuration.');
    process.exitCode = 1;
  }
}
