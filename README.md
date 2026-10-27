# Community Connect

A standalone Meta hackathon prototype exploring **WhatsApp Business Calling in a contact-centre workflow, with Meta AI-assisted case summaries and human review**.

## Demo goal

1. A person makes an inbound WhatsApp support call.
2. A human agent handles the conversation.
3. The backend uses the Meta Model API to draft a case summary: the enquiry, relevant details and suggested next steps.
4. The agent reviews and edits the draft before saving it or taking further action.

Summaries must be grounded in agent notes or a transcript obtained through a verified, supported integration. Suggested next steps are proposals for the agent to assess. Generating a draft must never send messages, make calls, update external cases or trigger follow-up actions automatically.

## Current status

Milestone 1 is implemented: a dependency-free Node.js backend and browser interface turn **editable synthetic agent notes from a simulated support call** into a draft, require human review, and export the reviewed case as a local JSON download. Real Meta generation is the default. A source-copy simulation is available only through explicit selection and is labelled in the interface and exported case.

All demo data must be synthetic. The source notes remain visible beside the four editable draft sections: enquiry, relevant details, missing or uncertain information, and suggested next steps. A separate Calling gateway and browser WebRTC agent are implemented and deployed, including Answer, Reject and Hang up. The deployed health and agent-page endpoints respond successfully; browser microphone operation, real Meta calls and two-way audio remain unverified. Recording, transcription, automated voice responses and outbound calling are not implemented.

## Workspace and Git

Clone the repository and change into its directory:

```sh
git clone https://github.com/community-connect-lab/community-connect.git
cd community-connect
```

- Git branch: `main`.
- GitHub remote: `https://github.com/community-connect-lab/community-connect.git`.

The notes application runs locally. The separate Render service now runs the Calling gateway, following the receiver-only checkpoint below. The public repository contains no runtime credentials; `.env.example` contains placeholders and non-secret defaults.

## Interface theme

The interface uses green and purple accents (`#2f8a56` and `#9b6dff`) with light backgrounds and white panels. Darker green and purple variants keep small text and button labels readable. Source notes use green accents; drafting and review use purple accents, while warnings and errors retain separate semantic colours.

The header and browser icon use `assets/meta-app-icon.svg`. The matching 1024 × 1024 PNG at `assets/meta-app-icon-1024.png` is suitable for Meta's app-icon upload. The notes server exposes the SVG only through its explicit `/brand-icon.svg` asset route.

## Windows setup and start

Requires **Node.js 22.19 or newer**. There are no runtime or development package dependencies and no build step. From the cloned repository directory, use PowerShell:

```powershell
# Create once; preserve an existing local key.
if (-not (Test-Path -LiteralPath .env)) {
    Copy-Item -LiteralPath .env.example -Destination .env
}
notepad .env
```

Replace only the `MODEL_API_KEY` placeholder locally and save. Keep the filename exactly `.env`. The backend uses Node's native environment-file loader; existing process environment variables take precedence over `.env`. Restart the server after configuration changes. Never put the key in frontend code, a URL, logs, source control or chat.

First verify a small real API request, then start the app:

```powershell
npm.cmd run check:api
npm.cmd start
```

Open **http://localhost:3000** in your browser. Stop the server with `Ctrl+C`. `npm.cmd` avoids PowerShell's `npm.ps1` execution-policy restriction. Equivalent commands are `node scripts/check-api.mjs` and `node server.mjs`. If the port is occupied, set a different `PORT` in `.env` and use the printed URL. The backend binds to `127.0.0.1` only.

The explicit API check sends a small synthetic request and checks for `OK`; it never prints the key or raw response. To verify a full four-field synthetic draft instead:

```powershell
npm.cmd run check:api -- --draft
```

Both check commands make real API requests using your account; automated tests below do not. An absent or placeholder key causes a clear error without sending a request. You can still start the app and explicitly select **Simulated summary** without a key.

| Variable | Purpose |
| --- | --- |
| `PORT` | Local backend port; defaults to `3000`. |
| `DEMO_MODE` | Synthetic-data mode; must remain `true` for this milestone. |
| `MODEL_API_KEY` | Secret Meta Model API key; backend environment only. |
| `MODEL_API_URL` | Verified endpoint: `https://api.meta.ai/v1/responses`. |
| `MODEL_API_MODEL` | Verified model: `muse-wonder-1.0`. |
| `MODEL_API_TIMEOUT_MS` | Backend deadline for the full API response; defaults to `60000`, allowed range `1000`–`120000`. |

No WhatsApp credentials are needed for the first milestone. Add a live Calling configuration only after the integration and required permissions have been verified.

## Use the notes-to-reviewed-case workflow

1. Read the clearly labelled synthetic scenario and edit the source notes. Use synthetic information only.
2. Leave **Real Meta Model API** selected and click **Generate draft**. Only the backend receives the API key. It sends the notes with instructions to ground the draft in those notes, identify uncertainty and propose next steps for a human. No tools or case actions are invoked.
3. Compare all four editable draft sections with the source notes and correct them. During generation, editors are temporarily disabled so an incoming response cannot overwrite concurrent edits.
4. Explicitly check the human-review confirmation. **Export reviewed case** then downloads JSON to your device. The JSON records the synthetic scenario, source notes used for generation, current notes, edited draft, real/simulated provenance, model/response ID for real results, and review time.

Any draft edit revokes review. Changing source notes or generation mode requires successful generation again before review, even if the change is later undone. Regeneration revokes review immediately; a failure preserves the previous notes and draft edits while keeping export blocked until successful generation and fresh review.

API authentication/access, rate-limit/quota, network, timeout, malformed response and incomplete-output failures are shown clearly. No failure automatically switches to a simulation. Choose **Simulated summary** explicitly for a practice draft that copies source text and supplies review prompts; edit it manually. Its provenance and download filename remain visibly labelled as simulated.

Working notes and draft edits stay in browser memory while the page remains open; the backend does not save cases or log notes, draft text, provider bodies or credentials. Reloading or closing the page discards this working state. The reviewed JSON download is the persistence mechanism.

## Checks and verification

Run the focused automated suite:

```powershell
npm.cmd test
```

**Verified on 26 October 2026 using Node.js 22.19.0:**

- All **61 automated tests passed**: 43 notes-workflow checks and 18 webhook checks. They use synthetic fixtures and fake provider responses. Notes-workflow coverage includes output parsing across reasoning/message blocks, malformed/refused/incomplete output, HTTP/network/timeout failures, bounded streaming responses, backend secret/static-file isolation, input/origin validation, explicit simulation, preservation of edits, stale-response rejection and review/export invalidation. Five controller checks exercise the actual browser controller against a test DOM, including input events, the review checkbox, failed regeneration, and the JSON Blob and filename created by export. Webhook coverage includes GET verification, raw-body HMAC, malformed/tampered events, bounded request bodies, phone filtering, secret isolation and safe event counts.
- A small **real Meta API request passed**, returning the expected `OK` through the backend client with `store:false`.
- A full **real synthetic draft passed** through the local HTTP backend, Meta API, four-field parser and client workflow state. JSON serialization was blocked before review, permitted after review, and blocked again after draft/source edits.
- A subsequent checkpoint inspected the real draft: Thursday availability remained unconfirmed, no collection change was claimed, and next steps remained conditional proposals. A reviewed JSON file was saved and reloaded; all four draft fields matched the human-edited content exactly, with matching source notes and provenance. Regeneration and source/draft edits revoked review. Checkpoint artifacts stay ignored in `tmp/`; they are not application storage.
- HTTP checks verified the page, browser assets and bootstrap endpoint. `.env` and alternate `*.env` filenames are ignored and cannot be served by the static asset allowlist.

Browser control was unavailable for the checkpoint, so visual layout and an actual browser download-manager interaction have not been verified. The controller's export click handler, generated Blob contents, filename and gate logic were tested programmatically. To check the final browser interaction manually, generate a draft, confirm export is disabled, review and download, then edit notes or a draft field and confirm export is disabled again.

**Calling implementation verified locally on 27 October 2026:** `npm.cmd test -- --test-reporter=dot` passed all **107 tests**: the 61 existing checks plus 7 Calling API, 20 broker, 7 gateway HTTP and 12 agent-controller checks. The new checks use synthetic fixtures and fake Graph responses; they make no live Meta requests. They cover action payloads, signed/filtered webhook handling, stale-event rejection, single-agent ownership, timeouts and uncertain outcomes, authentication/origin restrictions, secret isolation, cancellation and late-response races, and withholding the microphone sender until acceptance. Native browser preview could not establish the current Chrome URL, so no screenshot or visual QA was achieved. Real Meta acceptance of the initial answer with no attached microphone track, media connectivity and two-way audio remain unverified.

Subsequent local startup, call-error diagnostic and browser-state fixes passed **141 tests**. These changes are not part of the deployed `9be6f64` revision. The focused checks include preserving permission failures through the broker and HTTP boundary, rejecting unsafe diagnostic fields, clearing failed-call messages on termination, preventing stale snapshots from restoring Answer, and distinguishing a call that ended before audio connected from a connected conversation.

## Deploy the separate webhook receiver on Render

`webhook-server.mjs` is a small, dependency-free receiver. It answers Meta's verification challenge and verifies POST events with raw-body HMAC-SHA256 using the **Community Connect App secret**. It acknowledges valid events and logs fixed event counts only; it does not persist or forward caller IDs, numbers, message text, SDP or raw event payloads. A phone-number filter can ignore events for other numbers. This receiver does **not** answer calls, negotiate media, record audio, transcribe or generate summaries.

The local notes app still starts with `npm.cmd start`. The separate receiver starts with `npm.cmd run start:webhook`; its default local port is 10000. It reads only webhook settings from the local `.env` or process environment. The notes app's `.env` `PORT=3000` is ignored by the receiver; use `WEBHOOK_PORT` for a different local webhook port. Render's process `PORT` takes priority, and the receiver binds to `0.0.0.0`.

In Render:

1. Select **New → Web Service**. Connect `https://github.com/community-connect-lab/community-connect`. The **Public Git Repository** option needs no GitHub repository permissions, but requires manual deploys for later source updates; a Git-provider connection can support automatic deploys.
2. Configure the following values:

| Setting | Value |
| --- | --- |
| Name | `<your-webhook>` or another available service name |
| Runtime | Node |
| Branch | `main` |
| Root Directory | Leave empty |
| Build Command | `npm ci --omit=dev` |
| Start Command | `npm run start:webhook` |
| Health Check Path | `/health` |
| Instance | Small paid, always-on instance for real-call testing; a sleeping free service is unsuitable for reliable call signalling |

3. Add these environment variables directly in Render. Keep their values out of screenshots, GitHub and chat:

| Variable | Value |
| --- | --- |
| `WHATSAPP_VERIFY_TOKEN` | A random secret of at least 32 characters. Use exactly the same value in Meta's **Verify token** field. This is a locally chosen secret, not a Graph token. |
| `WHATSAPP_APP_SECRET` | The **Community Connect** App secret from Meta **App settings → Basic**. Do not substitute a user/system-user access token. |
| `WHATSAPP_PHONE_NUMBER_ID` | The test **Phone number ID** from API Setup; recommended filter for shared assets. Use the phone ID, not the phone number or WABA ID. |

The webhook receiver does not need `MODEL_API_KEY` or `WHATSAPP_ACCESS_TOKEN`. Leave `PORT` to Render's provided environment. No disk or database is required for this receiver.

4. Create/deploy the service. Check that `https://<your-webhook>.onrender.com/health` returns HTTP 200 with `status: "ok"` and `callHandling: "not_implemented"`. Replace `<your-webhook>` with your Render service name and use the URL shown by Render.
5. In **Community Connect → WhatsApp → Configuration**, set **Callback URL** to `https://<your-webhook>.onrender.com/webhooks/whatsapp`. Enter the same `WHATSAPP_VERIFY_TOKEN` value and click **Verify and save**. Keep the existing apps' callbacks and subscriptions unchanged.
6. Use Meta's dashboard webhook tests to verify delivery and inspect Render logs for the `whatsapp_webhook_received` count summary. A sample event for a different phone ID is acknowledged but counted as ignored when filtering is enabled. Failed signatures return 403; valid signed malformed payloads return 400. Never disable signature verification to make a test pass.

Callback verification and a successful dashboard test do not establish end-to-end Calling. App publication and real incoming-message delivery are reported in the checkpoint below; real inbound-call delivery and two-way audio remain unverified.

**User-verified account checkpoint — 27 October 2026 (not independently retested):**

- The **Community Connect** Meta app is published. Its `calls` and `messages` webhook fields are subscribed using Graph API version `v26.0`.
- The receiver at `https://<your-webhook>.onrender.com` passed verification-token setup and Meta dashboard webhook tests. Render remains on the **Free** instance plan.
- A real incoming WhatsApp reply was correlated with the Render log at `08:46:24`, showing `messages: 1` and `ignoredChanges: 0`.
- `POST /PHONE_NUMBER_ID/settings` returned `success: true`. A following GET returned `calling.status: "ENABLED"`, `call_icon_visibility: "DEFAULT"` and `callback_permission_status: "DISABLED"`. `storage_configuration.status: "DEFAULT"` was unchanged. SIP status and Calling eligibility beyond the accepted settings remain unverified.

The receiver's 18 utility/HTTP tests remain part of the passing suite. Its `callHandling: "not_implemented"` health value describes the historical receiver-only process. The Calling gateway has now replaced that process on Render, as checked below. Use an always-on service for reliable real-call testing; the last reported Free plan's sleep behaviour remains a limitation.

**Render gateway checkpoint — 27 October 2026:** the user reports adding the missing `WHATSAPP_ACCESS_TOKEN` and successfully deploying revision `9be6f64`. Independent HTTP reads returned **200** from `https://<your-webhook>.onrender.com/health` with `status: "ok"`, `service: "community-connect-calling"` and `callHandling: "agent_gateway"`; `/agent` also returned **200** and contained the Call desk and Connect desk interface text. These checks confirm startup and page delivery, not visual rendering, microphone access, Graph call actions or audio. Render was last reported as **Free**; no plan change was performed by this implementation.

**First incoming-call attempt — 27 October 2026:** the user reports that the desk rang, Answer did not stop the caller's ringing, and the caller's hang-up ended the desk call. Render logs show `CALL_API_PERMISSION`. In that deployed revision this code maps Meta error code `10` or `200`; it establishes a call-control permission rejection, without identifying the precise scope/app/asset cause. Two-way audio remains unverified. The browser also retained the old setup error after termination; the local fixes above clear that stale state and label an unconnected call accurately.

References: [Render web services](https://render.com/docs/web-services), [Render free-instance limitations](https://render.com/docs/free), [Meta webhook verification and signatures](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/create-webhook-endpoint), [Meta publishing requirements](https://developers.facebook.com/documentation/development/create-an-app/whatsapp-use-case#publish).

## Run the Calling gateway locally

The gateway is a separate process from both the notes app and the receiver-only server. Preserve the existing `.env`; add the Calling settings shown in `.env.example` without replacing existing credentials. The three webhook settings remain required, including the intended `WHATSAPP_PHONE_NUMBER_ID` filter. Add a valid backend **WhatsApp Graph API access token** as `WHATSAPP_ACCESS_TOKEN`, a new distinct random secret of at least 32 characters as `AGENT_ACCESS_TOKEN`, and these non-secret values:

```dotenv
WHATSAPP_GRAPH_VERSION=v26.0
CALLING_PORT=10000
CALLING_PUBLIC_ORIGIN=http://127.0.0.1:10000
```

The Graph token controls calls. The agent token authenticates the browser desk. They must be different from one another; the agent token must also differ from the verification token and App secret. `MODEL_API_KEY` belongs only to the local summary backend. Keep all secret values in local or hosted environment settings, never in chat, screenshots, browser source or Git.

```powershell
npm.cmd run start:calling
```

Open **http://127.0.0.1:10000/agent**. Local startup alone does not make Meta deliver webhooks to this computer; real delivery uses the deployed HTTPS gateway. The gateway ignores the notes app's local `.env` `PORT=3000`; use `CALLING_PORT` locally, while Render's process `PORT` takes priority. Stop any receiver-only process using the same port first. Keep the summary app running separately with `npm.cmd start` at `http://localhost:3000`.

## Render migration reference

The receiver-to-gateway migration succeeded for revision `9be6f64`; the steps below remain a configuration and redeployment reference. Publish reviewed source changes to GitHub before asking Render to deploy them. The always-on instance recommendation and first real call test remain outstanding.

1. Review the implementation, run `npm.cmd test`, and stage only the intended files. These commands deliberately name the implementation files and leave local policy drafts outside the commit:

```powershell
git add -- README.md .env.example package.json calling-server.mjs
git add -- lib/calling-api.mjs lib/calling-state.mjs
git add -- public/agent/index.html public/agent/app.mjs public/agent/styles.css
git add -- test/calling-api.test.mjs test/calling-state.test.mjs test/calling-server.test.mjs test/agent-controller.test.mjs
git diff --cached --check
git diff --cached
git commit -m "Add human-answered inbound Calling gateway"
git push origin main
```

2. In the existing Render webhook service, retain `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_APP_SECRET` and `WHATSAPP_PHONE_NUMBER_ID`. Add:

| Variable | Render value |
| --- | --- |
| `WHATSAPP_ACCESS_TOKEN` | A valid Graph API token for this app and intended number; not the Model API key or App secret. |
| `AGENT_ACCESS_TOKEN` | A new, distinct random secret of at least 32 characters, with no whitespace. |
| `WHATSAPP_GRAPH_VERSION` | `v26.0` |
| `CALLING_PUBLIC_ORIGIN` | `https://<your-webhook>.onrender.com` — exact origin, no `/agent` path. |

3. Set **Start Command** to `npm run start:calling`. Retain **Build Command** `npm ci --omit=dev` and **Health Check Path** `/health`. Use **one always-on instance** for the real call test: the broker lives in memory and does not support multiple instances. Render was last reported as Free; an always-on instance change has not been performed by this implementation. Let Render supply `PORT`; do not add the Model API key to this service.
4. Deploy the reviewed GitHub revision. A public-repository connection requires a manual deploy for source changes. Check `https://<your-webhook>.onrender.com/health` for HTTP 200, `status: "ok"` and `callHandling: "agent_gateway"`. This confirms which process is running; it does not verify Graph access or audio.
5. Retain the existing Meta callback **`https://<your-webhook>.onrender.com/webhooks/whatsapp`** and verification token. The gateway preserves its path and signed GET/POST handling; no replacement callback is needed. Preserve the published app's working subscriptions. Before the call test, inspect the intended number's current SIP configuration and shared-number/WABA routing. This gateway needs Graph/webhook signalling; do not overwrite unknown SIP settings or another project's routing to force a test.
6. Open `https://<your-webhook>.onrender.com/agent` and follow the desk flow below. HTTP page delivery is verified; browser microphone operation and the first real call remain manual verification steps.

## Use the agent desk for a synthetic call test

1. Use a browser with HTTPS (or localhost for local preview), a working microphone and a headset. Enter only the dedicated **agent access token** and choose **Connect desk**. It stays in this tab's memory and clears on disconnect/reload.
2. Choose **Ready to receive** and grant microphone access before placing the test call. Ready captures the microphone locally; it does not attach it to a network sender. Keep the tab open. One ready browser owns the renewable agent lease.
3. From WhatsApp on an iPhone or Android phone, call the intended test number using a fictional support scenario. An inbound offer appears in the desk. Choose **Answer call**. The browser answers Meta's SDP offer; the gateway sends `pre_accept`, waits for the browser's ICE/DTLS connection, and then sends `accept`. Only a confirmed active response permits attaching the microphone track. **Reject** declines a ringing call; **Hang up** ends or cancels the call. If autoplay is blocked, choose **Play caller audio**.
4. Verify both people can hear each other, then hang up and confirm the desk ends the call. If an action is unconfirmed, use Hang up for cleanup instead of retrying Answer. The gateway does not record, transcribe, make outbound calls or automatically generate a summary.
5. Write synthetic manual notes in the desk, then deliberately copy them into the separately running local summary app. Opening the summary link transfers no notes. Generate, review and export using the existing workflow; no call context or notes are sent there automatically. Reloading the desk discards its notes.

The broker temporarily keeps only the call IDs and SDP needed for the active call, bounds setup/lease timeouts and duplicate tracking, and clears descriptions after acceptance or termination. Logs contain aggregate counts, not call IDs, SDP, numbers or notes. Calls arriving with no ready agent or while another call is active are rejected. Restarting/redeploying loses in-memory call state; keep deployments outside an active test conversation.

The browser currently has no configurable STUN/TURN path. Meta's ICE-lite peer can work with direct browser connectivity, but restrictive networks may prevent audio; a TURN configuration would be additional implementation work. Actual Meta acceptance of the initial answer without a microphone sender and real two-way audio are still unverified. These limits must be resolved through the first live test, not inferred from passing fake-response tests or an enabled Calling setting.

Protocol references checked against primary documentation on 27 October 2026: [Meta user-initiated calls](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/user-initiated-calls), [Calling FAQ and browser SDP guidance](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/faq), [Calls API](https://developers.facebook.com/documentation/business-messaging/whatsapp/reference/whatsapp-business-phone-number/calling-api), [WebRTC sender track](https://w3c.github.io/webrtc-pc/#dom-rtcrtpsender-track), [WebRTC replaceTrack](https://w3c.github.io/webrtc-pc/#dom-rtcrtpsender-replacetrack).

### If Meta denies a call action

`CALL_API_PERMISSION` means Meta denied the gateway's call-control request. Webhook delivery authenticates with the App secret and does not prove that `WHATSAPP_ACCESS_TOKEN` can control the selected number. Calling needs `whatsapp_business_messaging` for that business number; being able to read/change settings with `whatsapp_business_management` is insufficient on its own. [Calling prerequisites](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/)

Inspect the exact token saved in Render privately in [Meta's Access Token Debugger](https://developers.facebook.com/tools/debug/accesstoken/). Verify the issuing application is Community Connect, the token is valid/unexpired, the messaging scope is granted, and relevant asset targets match the intended account. Do not share the token, a screenshot containing it, or raw provider payloads. If needed, generate a fresh temporary token through Community Connect's API Setup for the intended test number and Messaging account, grant messaging and management access where offered, replace only Render's `WHATSAPP_ACCESS_TOKEN`, and save/redeploy. The agent token, App secret and verification token serve different purposes and do not need changing for this correction attempt.

For a system-user token, also verify app assignment and access to both the WhatsApp account and linked Messaging account; employee assignments do not automatically cascade. Correct scope names alone do not establish access to a particular number. [Access-token and asset requirements](https://developers.facebook.com/documentation/business-messaging/whatsapp/access-tokens)

The local diagnostic fixes preserve only an allowlisted error code, action, HTTP status and integer Meta code/subcode in errors, snapshots and logs. They do not log Meta message text, details, trace IDs, call IDs, SDP, credentials or notes. A later `CALL_API_AUTH` suggests token authentication; a network/timeout/session rejection remains distinct. After correcting access and deploying, reconnect the desk and use one fresh synthetic inbound call. A successful test must confirm both directions of audio and hang-up; an ended webhook alone does not establish a connected conversation.

## Meta Model API: verified contract

Checked against official Meta documentation on **26 October 2026**. The supplied dashboard endpoint and model are explicitly documented, including Bearer authentication:

```http
POST https://api.meta.ai/v1/responses
Authorization: Bearer <MODEL_API_KEY from backend environment>
Content-Type: application/json
```

Example request body, using synthetic text only:

```json
{
  "model": "muse-wonder-1.0",
  "instructions": "Draft a case summary from the supplied agent notes. Include the enquiry, relevant details and suggested next steps. Do not invent facts. Mark missing or uncertain details. The draft requires human review and must not trigger actions.",
  "input": "SYNTHETIC DEMO: Caller asks how to change the collection time for a community food parcel. Agent explains that availability must be checked. No new time has been confirmed.",
  "store": false
}
```

The documented non-streaming success response is HTTP 200 JSON with fields including `id`, `object: "response"`, `status`, `model`, `output` and `usage`. Read text from assistant `message` items in `output`, collecting `content` blocks with `type: "output_text"` and their `text` values. Do not assume `output[0]` is a message: reasoning items may also appear. Check response status and handle errors, incomplete responses and missing text before presenting a draft.

The implementation uses `store: false`, `stream: false` and `max_output_tokens: 4096` for drafts. It validates the four plain-text JSON fields before replacing an existing draft, rejects partial/refused output, bounds the response body, and enforces a timeout. This storage setting controls response storage; it is not a claim about all provider retention. The configured model and account access passed the real checks described above; future key, quota or service failures are handled as errors.

Official references: [overview](https://dev.meta.ai/docs/overview), [authentication](https://dev.meta.ai/docs/authentication), [create response](https://dev.meta.ai/docs/api-reference/responses/create-response), [response schemas](https://dev.meta.ai/docs/api-reference/responses/schemas), [quickstart and output parsing](https://dev.meta.ai/docs/quickstart), [model availability](https://dev.meta.ai/docs/models), [response storage](https://dev.meta.ai/docs/protocols/responses). The endpoint, Bearer authentication, response shape and `muse-wonder-1.0` model availability were rechecked against official documentation during implementation.

## Inbound Calling account requirements and verification still needed

Scope: a test person calls from WhatsApp, a human agent answers and speaks with them, then enters **manual agent notes** in the existing summary workflow. Keep the support scenario fictional and the notes synthetic. The gateway and browser answering interface are deployed; real-call/media verification remains outstanding. Recording, transcription, automated voice responses and outbound calling are outside this milestone.

### Verified test routes and account requirements

Official documentation was checked on **26 October 2026**. The research browser received HTTP 429, but direct HTTPS requests retrieved the official pages successfully; the requirements below are no longer blocked by documentation access.

Start with a **Cloud API public test number**, after checking which other apps use its assets. Meta explicitly supports Calling on public test numbers; they bypass the production requirement for a daily messaging limit of 2,000 unique recipients. Calling is disabled initially and must be enabled. An account named “Test WABA” is not proof of this number classification. Verify the actual asset in API Setup. [Calling overview and testing rules](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/)

The special **Calling sandbox** is a separate option documented for **Tech Partners only**. Meta distinguishes Tech Providers from Tech Partners; a Tech Provider description alone does not establish this entitlement. A sandbox supplies test assets through an app; it does not replace the app. [Sandbox guide](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/sandbox), [partner classifications](https://developers.facebook.com/documentation/business-messaging/whatsapp/solution-providers/overview)

Use a dedicated hackathon app under the intended business portfolio, while checking asset sharing explicitly. Creating an app does not guarantee a separate test Messaging account or phone number: API Setup can connect an existing account. Compare WABA/Messaging account IDs and phone number IDs across apps; matching IDs mean shared assets. Separate app identities do not isolate phone-number Calling/SIP settings. Inspect existing WABA subscriptions, callbacks and number settings before changing shared assets, and preserve other projects' working integrations. [Cloud API account selection](https://developers.facebook.com/documentation/business-messaging/whatsapp/get-started)

### Meta configuration reference and remaining checks

1. In the intended app, open **Use cases → Connect with customers through WhatsApp → Customize**. Confirm the WhatsApp use case, app administrator access and correct business portfolio. In **API Setup**, select the public test number and retain its app ID, WABA/Messaging account ID and phone number ID locally. Check whether these assets are shared before changing them. Establish a test conversation with the intended mobile caller through the API Setup test-recipient flow. [WhatsApp use case](https://developers.facebook.com/documentation/development/create-an-app/whatsapp-use-case), [Cloud API Get Started](https://developers.facebook.com/documentation/business-messaging/whatsapp/get-started)
2. For the public test number selected for this app, obtain its temporary API Setup access token for the first proof. Select only the intended Messaging account in the authorization flow. It needs `whatsapp_business_messaging` and `whatsapp_business_management`; the WhatsApp use case includes `public_profile` too. Keep the token in the backend only. This is a **Graph API token**, separate from `MODEL_API_KEY`. For onboarded client assets, use the customer-scoped Embedded Signup business-token flow; do not reuse another project's client token. [Access tokens](https://developers.facebook.com/documentation/business-messaging/whatsapp/access-tokens)
3. Preserve the already verified **public HTTPS callback URL** and verification token when migrating the receiver to the Calling gateway. The certificate must be trusted. The verification GET validates `hub.verify_token` and returns `hub.challenge` with HTTP 200; webhook POSTs validate `X-Hub-Signature-256` against the raw body with the App secret. The verification token and App secret are different values. [Webhook endpoint requirements](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/create-webhook-endpoint)
4. Subscribe the same app to the **`calls`** webhook field and to the number's WABA/Messaging account (`POST /WABA_ID/subscribed_apps`). Ensure the token/app has messaging access to the number. [Calling prerequisites](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/)
5. The checkpoint above already reports `calling.status: "ENABLED"`, `call_icon_visibility: "DEFAULT"` and `callback_permission_status: "DISABLED"`. Inspect SIP status and calling hours on the intended number before testing Graph/webhook signalling. SIP routing must be compatible with that path, but unknown or shared SIP settings must not be overwritten without identifying the existing integration. Do not repeat settings writes against another project's number. [Calling settings](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/call-settings)

If the business is confirmed as a Tech Partner and the special sandbox is preferred, first check **WhatsApp → Quickstart → Testing Integrations → Claim sandbox account**. Then use **Embedded Signup Builder**: leave Features empty, choose Login with Facebook, select **Sandbox Business** and **Test Number**, exchange the token, and fetch the WABA and phone IDs. Subscribe the app, register the sandbox number with `/PHONE_ID/register` (`messaging_product: "whatsapp"` and a locally chosen six-digit PIN), then configure the same webhook and Calling settings. Sandbox eligibility and successful claiming must be verified in the actual account. [Sandbox setup](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/sandbox)

### Implemented Calling path

The implementation uses **Graph API signalling + `calls` webhooks + a browser WebRTC agent**. Meta's FAQ explicitly supports the browser generating the SDP answer. The signed gateway receives Meta's offer and makes it available only to the owning authenticated desk. Ready obtains the microphone; Answer prepares the SDP, pre-accepts, waits for ICE/DTLS, then accepts before attaching the microphone sender. Reject/Hang up use `reject`/`terminate`; incoming terminate events clear the call. Meta describes a roughly 30–60 second answer window. [User-initiated call flow](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/user-initiated-calls), [browser SDP guidance](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/faq)

Use WhatsApp on an iPhone or Android phone for the test caller. The agent needs a microphone, speaker/headset, WebRTC media connectivity using ICE and DTLS-SRTP, and Opus audio. Network conditions may require STUN/TURN. No outbound call-permission request is needed for this inbound-only flow. After hanging up, the human writes notes; no transcript is assumed. [Calling FAQ](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/faq)

Keep the summary application on localhost. Expose only a dedicated signed webhook/Calling gateway through the selected HTTPS domain or tunnel, with controlled agent access. Do not publish the current model-key-backed local summary server wholesale. SIP remains a supported alternative if appropriate PBX/softphone infrastructure already exists. [Integration examples](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/integration-examples)

**Remaining work:** use a single always-on Render instance for the real call test. Confirm SIP/shared-number routing and Calling eligibility beyond accepted settings, then verify browser microphone operation, real inbound-call delivery, Meta SDP acceptance and two-way audio. Restrictive-network TURN support is not implemented, and visual QA remains unverified. App publication, webhook verification, app-field subscriptions, the reported Calling settings and gateway startup/page delivery are completed in the checkpoints above. The local startup-diagnostic changes are not yet committed or deployed. This implementation did not change other apps' callbacks or subscriptions.

## Small implementation plan

1. **Milestone 1: notes to reviewed case — implemented.** Run the local backend and browser interface using the commands above. Synthetic notes produce an editable draft through the real API or an explicitly selected, labelled simulation. Export requires current human review. Browser visual/download checks remain the verification limit documented above.
2. **Human-answered inbound Calling — deployed; live-call verification pending.** Confirm the intended number's routing and browser microphone operation, then verify two-way audio using a fictional support scenario on an always-on instance. Keep manual agent notes as the summary source.
3. **Connect the verified flow.** The desk currently supports deliberate manual transfer of synthetic notes into the local summary app. Automatic call-context transfer remains future work. Preserve source and review status; gate subsequent actions on human approval. Recording, transcription and automated voice remain outside this plan.

Milestone 1 is complete when synthetic notes produce a source-grounded draft, the agent can edit it, saving is blocked until explicit review, and errors leave the source notes and agent edits intact. Verify key isolation, synthetic labels, output parsing and the review gate. This milestone does not require a working Calling account.

## Public-project boundaries

Keep this repository standalone. Do not copy ThymeLine private source, Git history, credentials, customer information, recordings or transcripts into it. Do not add private worktrees, submodules or remotes. Use synthetic identities and case details in fixtures, screenshots and demonstrations.

`.gitignore` excludes local environment files, common secret formats, private working-data folders, dependencies and generated output. Commit only reviewed synthetic fixtures. Ignore rules do not sanitize files already tracked, so inspect staged changes before publishing.
