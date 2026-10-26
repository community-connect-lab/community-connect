# Community Connect

A standalone Meta hackathon prototype exploring **WhatsApp Business Calling in a contact-centre workflow, with Meta AI-assisted case summaries and human review**.

## Demo goal

1. A person makes an inbound WhatsApp support call.
2. A human agent handles the conversation.
3. The backend uses the Meta Model API to draft a case summary: the enquiry, relevant details and suggested next steps.
4. The agent reviews and edits the draft before saving it or taking further action.

Summaries must be grounded in agent notes or a transcript obtained through a verified, supported integration. Suggested next steps are proposals for the agent to assess. Generating a draft must never send messages, make calls, update external cases or trigger follow-up actions automatically.

## Current status

Workspace and documentation setup only; there is no runnable application or installed dependency set yet. All demo data must be synthetic. Live Calling, call media and transcription are not implemented.

The first milestone will use **synthetic agent notes and a simulated call scenario**, visibly labelled in the UI. The summary source must remain visible to the reviewer. A future live integration must identify its actual source and must not be represented as working until verified end to end.

## Workspace and Git

- Project root: `C:\Projects\community-connect-lab\Community Connect`.
- Parent directory: `C:\Projects\community-connect-lab`.
- Git branch: `main`.
- GitHub remote: `https://github.com/community-connect-lab/community-connect.git`.

This initial setup contains project documentation, ignore rules and a placeholder environment template.

## Environment setup

Copy the template locally from the project root:

```powershell
Copy-Item .env.example .env
```

Set `MODEL_API_KEY` in that local file, or provide it through the backend process environment. Never paste it into the browser, frontend code, a URL, logs or source control. The backend must load it at runtime; the template alone does not implement environment loading.

| Variable | Purpose |
| --- | --- |
| `PORT` | Planned local backend port; defaults to `3000`. |
| `DEMO_MODE` | Planned synthetic-data mode; leave `true` for the first milestone. |
| `MODEL_API_KEY` | Secret Meta Model API key; backend environment only. |
| `MODEL_API_URL` | Verified endpoint: `https://api.meta.ai/v1/responses`. |
| `MODEL_API_MODEL` | Verified model: `muse-wonder-1.0`. |

No WhatsApp credentials are needed for the first milestone. Add a live Calling configuration only after the integration and required permissions have been verified.

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

Use `store: false` for this single-request flow because response storage defaults to enabled. This setting controls response storage; it is not a claim about all provider retention. The model is documented as preview. Account access, key validity and quota remain untested; no authenticated or billable model request was made during setup.

Official references: [overview](https://dev.meta.ai/docs/overview), [authentication](https://dev.meta.ai/docs/authentication), [create response](https://dev.meta.ai/docs/api-reference/responses/create-response), [response schemas](https://dev.meta.ai/docs/api-reference/responses/schemas), [quickstart and output parsing](https://dev.meta.ai/docs/quickstart), [response storage](https://dev.meta.ai/docs/protocols/responses).

## WhatsApp Calling: verification gate

Official sources were checked on **26 October 2026**. The [official WhatsApp Calling announcement](https://whatsappbusiness.com/blog/whatsapp-business-calling-api/) documents inbound call controls and permission requests for outbound calls. The [official Meta Cloud API collection](https://www.postman.com/meta/whatsapp-business-platform/documentation/wlk6lh4/whatsapp-cloud-api) documents a general baseline: a business portfolio, a WhatsApp Business Account (WABA), a business phone number, `whatsapp_business_management` and `whatsapp_business_messaging` permissions, app subscription and number registration with two-step verification. **This baseline does not establish Calling eligibility or sufficient Calling permissions.**

Detailed [Calling documentation](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/), [SIP documentation](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/sip/) and the [phone-number Calling reference](https://developers.facebook.com/documentation/business-messaging/whatsapp/reference/whatsapp-business-phone-number/calling-api/) returned HTTP `429 Too Many Requests` to the research tool. Legacy Calling documentation was also inaccessible. This is a documentation-access blocker, not evidence that the account is ineligible.

Before implementing live Calling, verify these items against accessible official documentation and the intended Meta business/app configuration:

| Area | Remaining verification |
| --- | --- |
| Eligibility | Account requirements, any current thresholds and geographic availability. |
| Permissions | Exact Calling scopes, app access/review requirements and token setup. General Cloud API permissions must not be assumed sufficient. |
| Number | Eligible number type/country, registration and Calling enablement/settings requirements. |
| Signalling and media | Supported integration path, webhook verification and supported access to call media. No recording or transcript access is assumed. |
| Summary source | Use agent notes, or add a supported transcription integration only after its media access and operating requirements are verified. |

No supported automatic transcript endpoint was verified. Do not assume call webhooks contain audio or transcripts. The first milestone can proceed with synthetic notes while these checks remain open.

## Small implementation plan

1. **First achievable milestone: notes to reviewed case.** Build a small browser agent screen and one Node.js backend with minimal dependencies. Load synthetic notes, request a draft through the backend, and show editable fields for the enquiry, relevant details and proposed next steps. Require an explicit review step before saving a reviewed case locally. Label the call scenario simulated. Include a clearly labelled simulated-summary fallback if the API is unavailable; never silently substitute it for a live model result.
2. **Verify live Calling prerequisites.** Resolve the documentation and account checks above, choose a supported agent call-handling path and verify an inbound call. Keep manual agent notes as the initial summary source. Add a transcript only through a separately verified integration.
3. **Connect the verified flow.** Link call context and source notes to the editable draft. Preserve source and review status; gate every subsequent action on human approval.

Milestone 1 is complete when synthetic notes produce a source-grounded draft, the agent can edit it, saving is blocked until explicit review, and errors leave the source notes and agent edits intact. Verify key isolation, synthetic labels, output parsing and the review gate. This milestone does not require a working Calling account.

## Public-project boundaries

Keep this repository standalone. Do not copy ThymeLine private source, Git history, credentials, customer information, recordings or transcripts into it. Do not add private worktrees, submodules or remotes. Use synthetic identities and case details in fixtures, screenshots and demonstrations.

`.gitignore` excludes local environment files, common secret formats, private working-data folders, dependencies and generated output. Commit only reviewed synthetic fixtures. Ignore rules do not sanitize files already tracked, so inspect staged changes before publishing.
