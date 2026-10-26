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

All demo data must be synthetic. The source notes remain visible beside the four editable draft sections: enquiry, relevant details, missing or uncertain information, and suggested next steps. Live WhatsApp Calling, call media and transcription are not implemented; their outstanding prerequisites remain documented below.

## Workspace and Git

- Project root: `C:\Projects\community-connect-lab\Community Connect`.
- Parent directory: `C:\Projects\community-connect-lab`.
- Git branch: `main`.
- GitHub remote: `https://github.com/community-connect-lab/community-connect.git`.

The application runs locally. The public repository contains no runtime credentials; `.env.example` contains a placeholder key and non-secret defaults.

## Windows setup and start

Requires **Node.js 22.19 or newer**. There are no runtime or development package dependencies and no build step. In PowerShell:

```powershell
Set-Location -LiteralPath 'C:\Projects\community-connect-lab\Community Connect'

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

- All **43 automated tests passed**, using synthetic fixtures and fake provider responses. Coverage includes output parsing across reasoning/message blocks, malformed/refused/incomplete output, HTTP/network/timeout failures, bounded streaming responses, backend secret/static-file isolation, input/origin validation, explicit simulation, preservation of edits, stale-response rejection and review/export invalidation. Five controller checks exercise the actual browser controller against a test DOM, including input events, the review checkbox, failed regeneration, and the JSON Blob and filename created by export.
- A small **real Meta API request passed**, returning the expected `OK` through the backend client with `store:false`.
- A full **real synthetic draft passed** through the local HTTP backend, Meta API, four-field parser and client workflow state. JSON serialization was blocked before review, permitted after review, and blocked again after draft/source edits.
- A subsequent checkpoint inspected the real draft: Thursday availability remained unconfirmed, no collection change was claimed, and next steps remained conditional proposals. A reviewed JSON file was saved and reloaded; all four draft fields matched the human-edited content exactly, with matching source notes and provenance. Regeneration and source/draft edits revoked review. Checkpoint artifacts stay ignored in `tmp/`; they are not application storage.
- HTTP checks verified the page, browser assets and bootstrap endpoint. `.env` and alternate `*.env` filenames are ignored and cannot be served by the static asset allowlist.

Browser control was unavailable for the checkpoint, so visual layout and an actual browser download-manager interaction have not been verified. The controller's export click handler, generated Blob contents, filename and gate logic were tested programmatically. To check the final browser interaction manually, generate a draft, confirm export is disabled, review and download, then edit notes or a draft field and confirm export is disabled again.

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

## Next milestone: a human answers a real inbound WhatsApp call

Scope: a test person calls from WhatsApp, a human agent answers and speaks with them, then enters **manual agent notes** in the existing summary workflow. Keep the support scenario fictional and the notes synthetic. Recording, transcription, automated voice responses and outbound calling are outside this milestone. Calling is not implemented yet.

### Verified test routes and account requirements

Official documentation was checked on **26 October 2026**. The research browser received HTTP 429, but direct HTTPS requests retrieved the official pages successfully; the requirements below are no longer blocked by documentation access.

Start with a **Cloud API public test number**, after checking which other apps use its assets. Meta explicitly supports Calling on public test numbers; they bypass the production requirement for a daily messaging limit of 2,000 unique recipients. Calling is disabled initially and must be enabled. An account named “Test WABA” is not proof of this number classification. Verify the actual asset in API Setup. [Calling overview and testing rules](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/)

The special **Calling sandbox** is a separate option documented for **Tech Partners only**. Meta distinguishes Tech Providers from Tech Partners; a Tech Provider description alone does not establish this entitlement. A sandbox supplies test assets through an app; it does not replace the app. [Sandbox guide](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/sandbox), [partner classifications](https://developers.facebook.com/documentation/business-messaging/whatsapp/solution-providers/overview)

Use a dedicated hackathon app under the intended business portfolio, while checking asset sharing explicitly. Creating an app does not guarantee a separate test Messaging account or phone number: API Setup can connect an existing account. Compare WABA/Messaging account IDs and phone number IDs across apps; matching IDs mean shared assets. Separate app identities do not isolate phone-number Calling/SIP settings. Inspect existing WABA subscriptions, callbacks and number settings before changing shared assets, and preserve other projects' working integrations. [Cloud API account selection](https://developers.facebook.com/documentation/business-messaging/whatsapp/get-started)

### Configuration to complete in Meta

1. In the intended app, open **Use cases → Connect with customers through WhatsApp → Customize**. Confirm the WhatsApp use case, app administrator access and correct business portfolio. In **API Setup**, select the public test number and retain its app ID, WABA/Messaging account ID and phone number ID locally. Check whether these assets are shared before changing them. Establish a test conversation with the intended mobile caller through the API Setup test-recipient flow. [WhatsApp use case](https://developers.facebook.com/documentation/development/create-an-app/whatsapp-use-case), [Cloud API Get Started](https://developers.facebook.com/documentation/business-messaging/whatsapp/get-started)
2. For the public test number selected for this app, obtain its temporary API Setup access token for the first proof. Select only the intended Messaging account in the authorization flow. It needs `whatsapp_business_messaging` and `whatsapp_business_management`; the WhatsApp use case includes `public_profile` too. Keep the token in the backend only. This is a **Graph API token**, separate from `MODEL_API_KEY`. For onboarded client assets, use the customer-scoped Embedded Signup business-token flow; do not reuse another project's client token. [Access tokens](https://developers.facebook.com/documentation/business-messaging/whatsapp/access-tokens)
3. After the Calling gateway exists, configure its **public HTTPS callback URL** and a locally chosen verification token. The certificate must be trusted. The verification GET must validate `hub.verify_token` and return `hub.challenge` with HTTP 200. Validate webhook POST `X-Hub-Signature-256` against the raw body with the app secret; the verification token and app secret are different values. [Webhook endpoint requirements](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/create-webhook-endpoint)
4. Subscribe the same app to the **`calls`** webhook field and to the number's WABA/Messaging account (`POST /WABA_ID/subscribed_apps`). Ensure the token/app has messaging access to the number. [Calling prerequisites](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/)
5. Through `POST /PHONE_NUMBER_ID/settings`, configure `calling.status: "ENABLED"`, `call_icon_visibility: "DEFAULT"` and `sip.status: "DISABLED"` for Graph/webhook signalling. Keep `callback_permission_status: "DISABLED"` for inbound-only testing. Read settings back and check that calling hours do not block the test. Do not send these requests against another project's number. [Calling settings](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/call-settings)

If the business is confirmed as a Tech Partner and the special sandbox is preferred, first check **WhatsApp → Quickstart → Testing Integrations → Claim sandbox account**. Then use **Embedded Signup Builder**: leave Features empty, choose Login with Facebook, select **Sandbox Business** and **Test Number**, exchange the token, and fetch the WABA and phone IDs. Subscribe the app, register the sandbox number with `/PHONE_ID/register` (`messaging_product: "whatsapp"` and a locally chosen six-digit PIN), then configure the same webhook and Calling settings. Sandbox eligibility and successful claiming must be verified in the actual account. [Sandbox setup](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/sandbox)

### Smallest supported implementation to build

Engineering recommendation: **Graph API signalling + `calls` webhooks + a browser WebRTC agent**, avoiding a separate SIP/PBX deployment. Meta's FAQ explicitly supports the agent browser generating the SDP answer. The Calling gateway receives Meta's SDP offer in a connect webhook and passes it to the agent browser. After the human clicks **Answer** and grants microphone access, the browser creates its answer; the gateway sends `pre_accept` and `accept` to `/PHONE_NUMBER_ID/calls`. Implement Reject/Hang up with `reject`/`terminate` and handle terminate events. Meta recommends pre-accepting and describes a roughly 30–60 second answer window. [User-initiated call flow](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/user-initiated-calls), [browser SDP guidance](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/faq)

Use WhatsApp on an iPhone or Android phone for the test caller. The agent needs a microphone, speaker/headset, WebRTC media connectivity using ICE and DTLS-SRTP, and Opus audio. Network conditions may require STUN/TURN. No outbound call-permission request is needed for this inbound-only flow. After hanging up, the human writes notes; no transcript is assumed. [Calling FAQ](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/faq)

Keep the summary application on localhost. Expose only a dedicated signed webhook/Calling gateway through the selected HTTPS domain or tunnel, with controlled agent access. Do not publish the current model-key-backed local summary server wholesale. SIP remains a supported alternative if appropriate PBX/softphone infrastructure already exists. [Integration examples](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/integration-examples)

**Remaining blockers:** shared-asset subscriptions and actual Calling access still need read-only verification in Meta; a signed public webhook gateway, SDP broker and human-answer WebRTC interface have not been built or tested. Account permission toggles alone do not provide two-way audio. No Meta account settings were changed during this investigation.

## Small implementation plan

1. **Milestone 1: notes to reviewed case — implemented.** Run the local backend and browser interface using the commands above. Synthetic notes produce an editable draft through the real API or an explicitly selected, labelled simulation. Export requires current human review. Browser visual/download checks remain the verification limit documented above.
2. **Human-answered inbound Calling — planned.** Complete the dedicated test-asset configuration above, build the separate gateway and WebRTC answering path, and verify two-way audio using a fictional support scenario. Keep manual agent notes as the summary source.
3. **Connect the verified flow.** Link call context and manual source notes to the editable draft. Preserve source and review status; gate subsequent actions on human approval. Recording, transcription and automated voice remain outside this plan.

Milestone 1 is complete when synthetic notes produce a source-grounded draft, the agent can edit it, saving is blocked until explicit review, and errors leave the source notes and agent edits intact. Verify key isolation, synthetic labels, output parsing and the review gate. This milestone does not require a working Calling account.

## Public-project boundaries

Keep this repository standalone. Do not copy ThymeLine private source, Git history, credentials, customer information, recordings or transcripts into it. Do not add private worktrees, submodules or remotes. Use synthetic identities and case details in fixtures, screenshots and demonstrations.

`.gitignore` excludes local environment files, common secret formats, private working-data folders, dependencies and generated output. Commit only reviewed synthetic fixtures. Ignore rules do not sanitize files already tracked, so inspect staged changes before publishing.
