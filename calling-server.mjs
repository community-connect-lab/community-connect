import { createServer } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { WebhookError, verifyChallenge, verifySignature, summarizeWebhook } from './lib/whatsapp-webhook.mjs';
import { CallingError, callingEnvironment, readCallingConfig, parseCallingEvents, createCallingClient, validateSdp, safeCallingDiagnostic, safeCallFailureCode } from './lib/calling-api.mjs';
import { CallStateError, createCallBroker } from './lib/calling-state.mjs';
import { AppError } from './lib/meta-api.mjs';
import { readConfig } from './lib/config.mjs';
import { readTranscriptionConfig } from './lib/transcription.mjs';
import { CaseExportError } from './lib/case-export.mjs';
import { createCaseService } from './lib/case-service.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const digest = value => createHash('sha256').update(value).digest();
const csp = "default-src 'none'; script-src 'self'; worker-src 'self'; style-src 'self'; connect-src 'self'; media-src 'self' blob:; img-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

function reply(response, status, data) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(data));
}

function readBody(request, limit, timeoutMs = 15000) {
  return new Promise((resolveBody, reject) => {
    const buffer = Buffer.alloc(limit);
    let size = 0;
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      request.removeListener('data', data); request.removeListener('end', end);
      request.removeListener('error', interrupted); request.removeListener('aborted', interrupted);
    };
    const fail = error => { if (settled) return; settled = true; cleanup(); buffer.fill(0); request.once('error', () => {}); request.resume(); reject(error); };
    const data = chunk => {
      if (size + chunk.length > limit) fail(new CallingError('BODY_TOO_LARGE', 'The request exceeds the allowed size.', 413));
      else { chunk.copy(buffer, size); size += chunk.length; }
    };
    const end = () => { if (!settled) { settled = true; cleanup(); resolveBody(buffer.subarray(0, size)); } };
    const interrupted = () => fail(new CallingError('REQUEST_INTERRUPTED', 'The request was interrupted.'));
    const timer = setTimeout(() => fail(new CallingError('REQUEST_TIMEOUT', 'The request upload took too long. Your browser edits have been kept.', 408)), timeoutMs);
    request.on('data', data); request.once('end', end); request.once('error', interrupted); request.once('aborted', interrupted);
  });
}

async function readJson(request, limit = 131072) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] || '')) {
    request.resume();
    throw new CallingError('INVALID_CONTENT_TYPE', 'Use application/json.', 415);
  }
  const raw = await readBody(request, limit);
  let data;
  try { data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)); } catch {
    throw new CallingError('INVALID_JSON', 'The request must contain valid JSON.');
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new CallingError('INVALID_JSON', 'The request must contain a JSON object.');
  return data;
}

export function createCallingServer(config, { sendAction = createCallingClient(config), onSummary = () => {}, onDiagnostic = () => {}, broker: suppliedBroker, modelConfig, transcriptionConfig, generate, transcribe, exportCase, caseNow } = {}) {
  const cases = createCaseService({ modelConfig, transcriptionConfig, generate, transcribe, exportCase, now: caseNow });
  const broker = suppliedBroker || createCallBroker({ sendAction: async (...args) => {
    try { return await sendAction(...args); } catch (error) {
      try { onDiagnostic({ event: 'calling_action_failed', code: safeCallFailureCode(error?.code), ...safeCallingDiagnostic({ ...safeCallingDiagnostic(error?.diagnostic), action: args[0] }) }); } catch { /* Fixed diagnostics only. */ }
      throw error;
    }
  } });
  const assets = new Map([
    ['/agent', ['public/agent/index.html', 'text/html; charset=utf-8']],
    ['/agent/', ['public/agent/index.html', 'text/html; charset=utf-8']],
    ['/agent/styles.css', ['public/agent/styles.css', 'text/css; charset=utf-8']],
    ['/agent/app.mjs', ['public/agent/app.mjs', 'text/javascript; charset=utf-8']],
    ['/agent/case-desk.mjs', ['public/agent/case-desk.mjs', 'text/javascript; charset=utf-8']],
    ['/agent/audio-capture.mjs', ['public/agent/audio-capture.mjs', 'text/javascript; charset=utf-8']],
    ['/agent/pcm-capture-worklet.mjs', ['public/agent/pcm-capture-worklet.mjs', 'text/javascript; charset=utf-8']],
    ['/brand-icon.svg', ['assets/meta-app-icon.svg', 'image/svg+xml']],
  ]);
  const expectedAgentToken = digest(config.agentAccessToken);
  let deniedCount = 0;
  let deniedSince = Date.now();
  const server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', csp);
    response.setHeader('Permissions-Policy', 'microphone=(self), camera=(), geolocation=()');
    try {
      const url = new URL(request.url, 'http://localhost');
      if (request.method === 'GET' && url.pathname === '/health') {
        reply(response, 200, { status: 'ok', service: 'community-connect-calling', callHandling: 'agent_gateway' });
        return;
      }
      if (request.method === 'GET' && url.pathname === '/') {
        response.writeHead(302, { Location: '/agent' }); response.end(); return;
      }
      if (request.method === 'GET' && assets.has(url.pathname)) {
        const [path, mime] = assets.get(url.pathname);
        response.writeHead(200, { 'Content-Type': mime });
        response.end(readFileSync(resolve(root, path))); return;
      }
      if (url.pathname === '/webhooks/whatsapp') {
        if (request.method === 'GET') {
          const challenge = verifyChallenge(url.searchParams, config.verifyToken);
          response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }); response.end(challenge); return;
        }
        if (request.method !== 'POST') { request.resume(); throw new CallingError('METHOD_NOT_ALLOWED', 'Use GET or POST.', 405); }
        if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] || '')) { request.resume(); throw new CallingError('INVALID_CONTENT_TYPE', 'Use application/json.', 415); }
        const signature = request.headers['x-hub-signature-256'];
        if (typeof signature !== 'string' || !/^sha256=[a-fA-F0-9]{64}$/.test(signature)) { request.resume(); throw new CallingError('INVALID_SIGNATURE', 'Webhook signature verification failed.', 403); }
        const body = await readBody(request, 1024 * 1024);
        if (!verifySignature(body, signature, config.appSecret)) throw new CallingError('INVALID_SIGNATURE', 'Webhook signature verification failed.', 403);
        let payload;
        try { payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)); } catch { throw new CallingError('INVALID_JSON', 'The webhook body must contain valid JSON.'); }
        const summary = summarizeWebhook(payload, config.phoneNumberId);
        const events = parseCallingEvents(payload, config.phoneNumberId);
        broker.ingest(events);
        // Logs retain only counts. The broker keeps call IDs/SDP temporarily in memory.
        try { onSummary(summary); } catch { /* Diagnostics must not delay/retry delivery. */ }
        reply(response, 200, { received: true }); return;
      }
      if (!url.pathname.startsWith('/agent/api/')) { request.resume(); throw new CallingError('NOT_FOUND', 'Not found.', 404); }
      const auth = request.headers.authorization;
      const suppliedToken = typeof auth === 'string' && auth.startsWith('Bearer ') && auth.length <= 4103 ? auth.slice(7) : '';
      if (!timingSafeEqual(expectedAgentToken, digest(suppliedToken))) {
        request.resume();
        if (Date.now() - deniedSince > 60000) { deniedSince = Date.now(); deniedCount = 0; }
        deniedCount++;
        if (deniedCount > 30) { response.setHeader('Retry-After', '60'); throw new CallingError('AGENT_RATE_LIMIT', 'Wait a minute before trying another access token.', 429); }
        throw new CallingError('AGENT_UNAUTHORIZED', 'Enter the dedicated agent access token.', 401);
      }
      const agentId = request.headers['x-agent-id'];
      if (typeof agentId !== 'string' || !/^[a-zA-Z0-9-]{16,128}$/.test(agentId)) { request.resume(); throw new CallingError('INVALID_AGENT_ID', 'Reconnect the agent screen.'); }
      const origin = request.headers.origin;
      if ((origin && origin !== config.publicOrigin) || (request.method !== 'GET' && origin !== config.publicOrigin)) {
        request.resume(); throw new CallingError('ORIGIN_NOT_ALLOWED', 'Open the agent screen at the configured gateway address.', 403);
      }
      if (request.method === 'GET' && url.pathname === '/agent/api/state') {
        const state = broker.getState(agentId); cases.observeState(agentId, state);
        reply(response, 200, state); return;
      }
      if (request.method === 'POST' && url.pathname === '/agent/api/ready') {
        const data = await readJson(request, 4096);
        if (typeof data.ready !== 'boolean') throw new CallingError('INVALID_READY_STATE', 'Choose whether the agent is ready.');
        await broker.setReady(agentId, data.ready);
        reply(response, 200, broker.getState(agentId)); return;
      }
      if (url.pathname.startsWith('/agent/api/case/')) cases.observeState(agentId, broker.getState(agentId));
      if (await cases.handle({ request, response, pathname: url.pathname, agentId, readJson, readBody, reply })) return;
      const match = /^\/agent\/api\/calls\/([a-f0-9-]{36})\/(offer|answer|accept|reject|hangup)$/.exec(url.pathname);
      if (!match) { request.resume(); throw new CallingError('NOT_FOUND', 'Not found.', 404); }
      const [, id, action] = match;
      if (action === 'offer' && request.method === 'GET') { reply(response, 200, broker.getOffer(agentId, id)); return; }
      if (action === 'offer' || request.method !== 'POST') { request.resume(); throw new CallingError('METHOD_NOT_ALLOWED', 'Use the supported call action method.', 405); }
      const data = await readJson(request);
      if (action === 'answer') await broker.answer(agentId, id, validateSdp(data.sdp));
      else await broker[action](agentId, id);
      const state = broker.getState(agentId);
      if (action === 'accept' && state.call?.id === id && state.call.state === 'active') cases.rememberAccepted(agentId, id);
      cases.observeState(agentId, state);
      reply(response, 200, state);
    } catch (error) {
      const safe = error instanceof CallingError || error instanceof CallStateError || error instanceof WebhookError || error instanceof AppError || error instanceof CaseExportError ? error : new CallingError('INTERNAL_ERROR', 'The request could not be completed.', 500);
      const diagnostic = safeCallingDiagnostic(safe.diagnostic);
      if (!response.headersSent && !response.destroyed) reply(response, safe.status, { error: { code: safe.code, message: safe.message, ...(Object.keys(diagnostic).length ? { diagnostic } : {}) } });
      else if (!response.destroyed) response.end();
    }
  });
  const timer = setInterval(() => { broker.sweep(); cases.sweep(); }, 1000);
  timer.unref();
  server.on('close', () => { clearInterval(timer); broker.close(); cases.close(); });
  server.headersTimeout = 10000;
  // Audio has its own bounded upload window; JSON/webhooks retain the shorter
  // readBody deadline. Header parsing is still bounded separately.
  server.requestTimeout = 120000;
  server.callBroker = broker;
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    let local = {};
    const localPath = resolve(root, '.env');
    if (existsSync(localPath)) {
      try { local = parseEnv(readFileSync(localPath, 'utf8')); } catch { throw new CallingError('ENV_FILE_ERROR', 'Could not read local configuration. No file contents were logged.', 503); }
    }
    const config = readCallingConfig(callingEnvironment(process.env, local));
    const environment = { ...local, ...process.env };
    // Missing model credentials disable only case processing, not working calls.
    let modelConfig, transcriptionConfig;
    try { modelConfig = readConfig(environment); } catch { modelConfig = readConfig({}); }
    try { transcriptionConfig = readTranscriptionConfig(environment); } catch { transcriptionConfig = readTranscriptionConfig({}); }
    const server = createCallingServer(config, {
      modelConfig, transcriptionConfig,
      onSummary: counts => console.log(JSON.stringify({ event: 'whatsapp_webhook_received', ...counts })),
      onDiagnostic: diagnostic => console.log(JSON.stringify(diagnostic)),
    });
    server.on('error', () => { console.error('Calling gateway could not start. Check the port and server configuration.'); process.exitCode = 1; });
    server.listen(config.port, '0.0.0.0', () => { console.log(`Community Connect Calling gateway listening on port ${config.port}. Agent screen: ${config.publicOrigin}/agent`); });
    const shutdown = () => { server.callBroker.close(); server.close(); setTimeout(() => { server.closeAllConnections(); }, 1000).unref(); };
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
  } catch (error) {
    console.error(error instanceof CallingError ? `${error.code}: ${error.message}` : 'Calling startup failed. Check backend configuration.');
    process.exitCode = 1;
  }
}
