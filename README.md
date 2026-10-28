# Community Connect

A Meta hackathon prototype for **human-answered WhatsApp support calls and AI-assisted, human-reviewed case drafts**. The interface uses green and purple accents, light backgrounds and white panels.

## One page, from conversation to reviewed case

The Calling gateway serves the complete workflow at `/agent`:

1. **Call desk:** connect with the separate agent token, choose Ready, then answer, reject or hang up an incoming WhatsApp call.
2. **Manual notes:** type during the conversation. These remain independent of the transcript.
3. **Post-call transcript:** optionally capture an agreed test conversation and send its audio to Meta after the call. Inspect and correct the transcript separately; the original machine transcript remains available for comparison.
4. **Merge and create draft:** send the current notes and/or corrected transcript to Meta. Review four editable sections: enquiry, relevant details, uncertainties and conflicts, and suggested next steps.
5. **Approve and export:** explicitly confirm human review, then download **PDF, DOCX, TXT or PPTX**. All formats use the same reviewed case; exporting makes no further model request. Source appendices are optional.

Use fictional identities and support scenarios for this prototype. The AI is instructed to flag conflicting accounts, distinguish reported information from confirmed facts, and preserve uncertainty. It cannot establish which source is correct. The human resolves or retains uncertainties before approving. Creating a draft never sends messages, places calls, updates external cases or performs suggested actions.

The working Call desk remains available if the Model API is unconfigured or unavailable. There is no automatic voice agent or outbound calling feature.

## Setup

Requires **Node.js 22.19 or newer**. Clone the repository and install pinned dependencies:

```sh
git clone https://github.com/community-connect-lab/community-connect.git
cd community-connect
npm ci
```

Copy `.env.example` to `.env` once and enter your own backend credentials. Preserve an existing `.env`. In PowerShell:

```powershell
if (-not (Test-Path -LiteralPath .env)) {
    Copy-Item -LiteralPath .env.example -Destination .env
}
notepad .env
```

On macOS/Linux, use `cp .env.example .env` only if the destination does not already exist, then edit locally. Process environment variables take priority over `.env`. Restart after configuration changes. In PowerShell, use `npm.cmd` if execution policy prevents `npm` from running.

| Variable | Purpose |
| --- | --- |
| `WHATSAPP_VERIFY_TOKEN` | Random verification secret matching Meta's webhook verification field. |
| `WHATSAPP_APP_SECRET` | Meta app secret for raw-body webhook HMAC verification. |
| `WHATSAPP_PHONE_NUMBER_ID` | Intended Phone number ID from API Setup, not the phone number or WABA ID. |
| `WHATSAPP_ACCESS_TOKEN` | Graph system-user token with messaging access to the intended number and business assets. |
| `WHATSAPP_GRAPH_VERSION` | Graph version; example: `v26.0`. |
| `AGENT_ACCESS_TOKEN` | Separate random agent secret, at least 32 characters; not a Graph token or Model API key. |
| `CALLING_PUBLIC_ORIGIN` | Exact browser-facing origin, without a path or trailing slash. Local example: `http://127.0.0.1:10000`. |
| `CALLING_PORT` | Local gateway port, default `10000`. A hosted process `PORT` takes priority. |
| `MODEL_API_KEY` | Meta Model API key for drafting and optional transcription; backend only. |
| `MODEL_API_MODEL` | Case model, default `muse-wonder-1.0`. |
| `MODEL_API_TIMEOUT_MS` | Generation deadline, default `60000`; maximum `120000`. |
| `TRANSCRIPTION_MODEL` | Default `muse-voice-transcribe-1.0`; account access is checked separately. |
| `TRANSCRIPTION_TIMEOUT_MS` | Provider deadline, default and maximum `120000`. |
| `TRANSCRIPTION_MAX_SECONDS` | Capture limit, default and maximum `300` seconds. |

Keep credentials in backend configuration. The browser holds only the dedicated agent token entered by the operator, in tab memory. Model and WhatsApp credentials are never included in browser assets or downloads.

```sh
npm run start:calling
```

Open `http://127.0.0.1:10000/agent` locally. The gateway binds to `0.0.0.0`; match its configured origin exactly. Microphone access requires a secure context: HTTPS when hosted or localhost for development.

## Hosting

Use a Node web service on your preferred host. Replace `<your webhook server url>` with your full public HTTPS origin, without a trailing slash:

- Agent page: `<your webhook server url>/agent`
- Meta callback: `<your webhook server url>/webhooks/whatsapp`
- Health check: `<your webhook server url>/health`
- `CALLING_PUBLIC_ORIGIN`: `<your webhook server url>`

Build with `npm ci --omit=dev`, start with `npm run start:calling`, and set backend variables through the host's environment settings. Preserve a working Meta callback and verification token during an upgrade. Subscribe the intended app/account to `calls` and to `messages` if messaging is also being tested. Calling must be enabled for the intended number. An enabled setting or delivered webhook does not itself prove Graph call-control permissions.

Use one running instance: desk ownership, call state and case receipts are in memory. A sleeping free instance can delay signalling; an always-on instance is appropriate for dependable calls. Restarting or deploying interrupts call state and invalidates case receipts, so save work first. This repository contains no deployment-specific domain.

The health response identifies `community-connect-calling` and `agent_gateway`. Adding the Model API key enables the new features without changing the Calling start command. Missing model configuration does not prevent the Call desk from starting.

## Optional transcription

Transcription is off by default. The operator confirms that all participants agreed before enabling capture. Audio is captured only for an accepted call, never while ringing. Capture mixes local and remote WebRTC audio into a temporary mono 16 kHz PCM WAV and stops at the configured limit or when stopped by the operator. Upload requires an ended call and a recent accepted-call receipt from the same authenticated desk.

When capture is enabled, audio is automatically sent after the call ends through `muse-voice-transcribe-1.0` at `https://api.meta.ai/v1/asr/transcribe`. Stop capture keeps the captured segment; Discard removes it before upload. ASR speaker labels do not establish caller/agent identity. Failed requests preserve notes, transcript and draft. Temporary audio stays in tab memory for an explicit retry; successful transcription clears it. Server audio buffers are cleared after processing and are not written to disk. A transcript can also be typed or pasted without capturing audio.

Capture is limited to five minutes; the server accepts at most 16 MiB of supported PCM WAV. Upload permission expires after 15 minutes; accepted-call context and draft receipts expire after four hours or a service restart. Working state is not durable case storage. Save working text before closing or reloading the page.

Check account access without printing credentials or provider bodies:

```sh
npm run check:transcription
```

This checks model visibility only. To test real recognition, deliberately supply a short fictional mono 16-bit PCM WAV at 16 or 24 kHz:

```sh
npm run check:transcription -- --audio path/to/synthetic-test.wav
```

The explicit upload uses the account's API allowance. It prints validation counts, not audio or transcript contents. On 27 October 2026, the development account listed the model and successfully transcribed a synthetic spoken example. A separate real check passed through the new HTTP endpoint, Meta transcription, Meta case generation and all four exports. This establishes development-account access, not access for every account or deployment.

## Review, recovery and exports

- Current notes and corrected transcript are drafting sources. The original machine transcript is an audit reference and is not merged back into the prompt after corrections.
- Source changes require a fresh successful draft. Draft edits, regeneration and new results revoke approval. Export remains blocked until current human review.
- Failed transcription, generation or export preserves existing text. Late results are rejected if the case or sources changed. Errors never switch to simulated AI results.
- Server receipts bind generation to the current sources and authenticated desk, retaining source hashes and provenance rather than case bodies.
- All four formats use the approved snapshot. Long sections continue onto additional pages/slides. Optional appendices identify manual notes, corrected transcript and original transcript separately.
- PDF embeds licensed Noto Sans for supported Latin, Greek and Cyrillic text. Unsupported PDF glyphs cause a clear error while preserving the case; choose another format. DOCX, TXT and PPTX preserve Unicode text, with Office rendering dependent on installed fonts.

The prototype has no case database or server-side audio archive. Use the working-copy download or reviewed exports to retain work. Drafting uses `store:false`; this is not a claim about every aspect of provider retention. Logs contain fixed diagnostic codes and aggregate webhook counts, not source text, SDP, phone numbers, credentials or raw provider bodies.

## Save and resume notes

**Save working copy (.txt)** still downloads a readable snapshot of notes, transcripts and any unreviewed working draft. To continue source text later, choose **Save to resume** to download a resumable JSON file, then **Load saved notes** on this or another computer. Saving and loading happen in the browser and make no model request.

The resumable file contains only manual notes and the current editable transcript. Loading validates the file before replacing work and asks for confirmation if a case or temporary audio is already present. Invalid files, cancelled loading and edits made while a file is opening preserve current work. Files are limited to 512 KiB and the existing source-text limits.

Loaded text starts a new manual case. Drafts, approval, original-machine transcript claims, recordings, credentials and call/generation receipts are not restored. Check the loaded text, create a fresh Meta draft and complete human review before exporting. Loading is blocked during calls or processing; choose **New case** before answering a call while restored notes are open.

## Checks

```sh
npm test
npm audit --omit=dev
```

Automated checks use synthetic fixtures and fake provider responses. They cover existing call lifecycle and microphone gates, signed webhooks, authentication/origin rules, bounded audio validation, cancellation, preservation, stale results, conflict instructions, approval invalidation, receipt isolation, and the contents of all four exports. Real API checks are separate explicit commands.

The earlier standalone notes application remains available with `npm start` at `http://localhost:3000`; its real API check is `npm run check:api`. The receiver-only entry point remains `npm run start:webhook`. The integrated workflow uses `npm run start:calling` and does not require opening the older notes application.

## Meta references

[Model API responses](https://dev.meta.ai/docs/api-reference/responses/create-response), [models](https://dev.meta.ai/docs/models), [speech](https://dev.meta.ai/docs/speech-to-text), [user-initiated WhatsApp Calling](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/user-initiated-calls), [Calling FAQ](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/faq), [Calling API](https://developers.facebook.com/documentation/business-messaging/whatsapp/reference/whatsapp-business-phone-number/calling-api), [tokens and assets](https://developers.facebook.com/documentation/business-messaging/whatsapp/access-tokens).

For `CALL_API_PERMISSION`, privately inspect the exact backend Graph token and verify its `whatsapp_business_messaging` scope plus the system user's access to the intended WhatsApp and linked Messaging assets. App assignment, scopes and asset assignment are separate requirements.

## Public-project boundaries

Use synthetic fixtures and demonstrations. Keep environment files, credentials, recordings, transcripts, private working documents and generated exports out of Git. Ignore rules do not sanitize tracked files; inspect staged changes before publishing. Do not copy private source, history or customer data from another project. Noto Sans is included under its [SIL Open Font License](assets/fonts/OFL.txt).
