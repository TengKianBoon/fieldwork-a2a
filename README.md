# Fieldwork A2A

The Agent2Agent (A2A) endpoint of 180Climate Fieldwork. An invited company's AI agent finds Fieldwork through its Agent Card, drafts a field job for a person on the ground, and follows it as an A2A task.

Live Agent Card, for discovery: https://fieldwork-a2a-180climate.netlify.app/.well-known/agent-card.json

## What it does

- **Protocol:** A2A 1.0, JSON-RPC binding. Methods: `SendMessage`, `GetTask`, `ListTasks`, `CancelTask`. Streaming, push notifications and an extended card are declared off and answered with the matching A2A errors.
- **Agent Card:** `public/.well-known/agent-card.json`, generated with the official A2A SDK types.
- **Access:** a compatible A2A client needs a key issued by 180Climate and a valid job payload (the fields described in the Agent Card's skill). The key goes in the `X-Fieldwork-Key` header, declared in the card as an API-key scheme. Only the key's SHA-256 is configured on the server. Every task is bound to its client: another client's task answers "task not found" in every method, and retries are namespaced by client. FieldProof is called with 180Climate's own requester code, a server-side secret that no client sends or sees.
- **Where the job lives:** in FieldProof's existing job system, through the same live calls FieldProof's MCP tools use (`job-create`, `job-status`). FieldProof's code is not changed. This service keeps one small record per task in Netlify Blobs.
- **What a client receives:** status, job metadata and counts. A task carries `id`, `contextId` and `status`: the state, the time it last changed, and a status message from the agent role with its message, context and task IDs and one text part. On `GetTask`, the `field-job` artifact adds the job ID, status, the requester-supplied title, the bid deadline, the counts of invited professionals and submitted bids, whether a selection is pending, whether a professional is engaged, the FieldProof check ID once one exists (`missionId`), and `stale` with `lastConfirmedAt` when a refresh failed. There are no fields for names, contact details, prices, item codes or claim links.
- **Freshness:** `SendMessage` answers at once; the work takes days and is followed with `GetTask` or `ListTasks`. FieldProof's 14-day agent link is renewed automatically; if the live state still cannot be read, the task says so (`stale: true`, `lastConfirmedAt`). `ListTasks` pages over stored states (newest change first) and reads live states for the returned page only, within a time budget; finished jobs are not read again. A task that changes between page requests can move to the top.

| Job status in FieldProof | A2A task state |
|---|---|
| draft | `TASK_STATE_SUBMITTED` |
| open | `TASK_STATE_WORKING` |
| accepted | `TASK_STATE_COMPLETED` |
| cancelled | `TASK_STATE_CANCELED` |

## How a draft becomes a job

Fieldwork A2A is a managed service. 180Climate is the requester on record in FieldProof, and people at 180Climate do everything after the draft.

1. **Draft.** The client's agent sends the job. The task starts as `TASK_STATE_SUBMITTED`; nobody outside 180Climate can see the draft. The task ID is the job reference.
2. **Review and publish.** A 180Climate operator and the client review the draft together: scope, site, window, budget, deadlines and items. 180Climate publishes approved jobs and invites field professionals by private link. The task moves to `TASK_STATE_WORKING` and shows the counts of professionals invited and bids received.
3. **Selection.** 180Climate confirms the choice of professional, the scope and the budget with the client, then selects the bid. When the professional accepts, the task moves to `TASK_STATE_COMPLETED` and a FieldProof field check is created. A person decides every item of evidence.
4. **Cancellation.** `CancelTask` does not cancel a job. It answers with A2A's TaskNotCancelableError (`-32002`) and directs the client to 180Climate, quoting the job reference. A 180Climate operator handles cancellation in FieldProof, and the task then moves to `TASK_STATE_CANCELED`.

Operators find drafts awaiting review through a private queue, `GET /ops/queue`, which needs a separate operator key (`X-Fieldwork-Operator-Key`). It is not available to clients. 180Climate's operating procedure is kept privately.

## Pilot limits

- **50 new jobs per client per UTC day.** This limit is atomic: each new job takes one daily slot before FieldProof is called, so parallel requests cannot exceed it. Past the limit the reply is HTTP 429 with `RESOURCE_EXHAUSTED` and a `Retry-After` header.
- **500 jobs per client in total.** This is a threshold checked before drafting. Concurrent requests can pass it, by at most one day's allowance.
- **Retries.** A retried message (the same `messageId` and the same job, from the same client) returns the original task and does not take a new slot; the tests verify this. A `messageId` reused for a different job is refused. A retry sent while the first request is still in progress can itself get the limit response at the daily limit; send it again later.

## Layout

| Path | What it is |
|---|---|
| `src/protocol.mts` | The A2A handler (JSON-RPC, access check, version check, task mapping, `ListTasks` paging, pilot limits) and the operator queue |
| `src/fieldproof.mts` | Client for FieldProof's live job calls |
| `src/store.mts` | Task records: Netlify Blobs in production, memory in tests |
| `netlify/functions/a2a.mts` | Netlify entry point, served at `/a2a` |
| `netlify/functions/ops.mts` | Netlify entry point for the operator queue, served at `/ops/queue` |
| `public/` | The Agent Card and a short human-readable page |
| `tests/` | `node --test` suite with an in-memory stand-in for FieldProof |
| `scripts/contract-test.mts` | This service's job format against FieldProof's real validation code (needs a FieldProof source checkout) |
| `scripts/a2a_proof.py`, `scripts/isolation_check.py` | End-to-end checks with the official A2A Python SDK, run against a test deployment |
| `scripts/new-client-key.mjs` | Makes a client or operator key and its hash entry |

## Run the checks

Tested with Node.js 22 (22.18 or newer, which runs the TypeScript tests directly).

```
npm ci
npm run typecheck
npm test
```

The tests run against an in-memory stand-in for FieldProof, so they need no network, keys or deployment.

The contract check runs this service's job format through FieldProof's real validation code. It needs a separate checkout of the FieldProof source, which is not part of this repository:

```
FIELDPROOF_SRC=/path/to/fieldproof/app node scripts/contract-test.mts
```

## Deploy (Netlify)

```
npm ci
netlify deploy --prod
```

Settings (Netlify environment variables, set by whoever operates the deployment):

| Name | Value |
|---|---|
| `FIELDWORK_A2A_CLIENTS` | JSON object `{"<sha256 of client key>": "<client id>", ...}` |
| `FIELDPROOF_REQUESTER_CODE` | the FieldProof requester code (secret) |
| `FIELDWORK_OPERATOR_KEYS` | JSON object `{"<sha256 of operator key>": "<operator name>"}` for the operator queue |
| `FIELDPROOF_URL` | optional, default `https://fieldproof-180climate.netlify.app` (https only) |

Until the first two are set, every call answers 503 "not configured yet".

To issue a key:

```
node scripts/new-client-key.mjs <client-id>
```

It prints the key (give it to that client once, privately) and the hash entry to add to `FIELDWORK_A2A_CLIENTS`.

## End-to-end checks against a test deployment

These commands create test drafts. Run them only against a test deployment you are authorised to use, with synthetic client keys issued for it.

```
pip install a2a-sdk httpx
python scripts/a2a_proof.py <test-deployment-url>
python scripts/isolation_check.py <test-deployment-url>
```

The proof asks for one client key without showing it, drafts one clearly marked test job (an invisible draft unless a person publishes it), reads it back and lists it, and writes a JSON log next to the script. Keys are never printed or logged.

The isolation check takes two synthetic client keys and confirms that each client reads and lists its own task, and that every attempt on the other client's task is refused with exactly A2A's TaskNotFoundError (`-32001`, `TASK_NOT_FOUND`); an unknown key gets HTTP 401.

## Known issue

The `field-job` artifact description and the service's landing page still say the reply carries "counts and states only". The artifact also carries the requester-supplied title, the bid deadline and identifiers, as listed above. The wording will be corrected in the next release.

## Status

An invite-only pilot run by 180Climate. Client keys are issued on request at https://www.180climate.net/contact/fieldwork/. FieldProof, the evidence product this service drafts jobs into, is a separate system and is not part of this repository.

## Credits

Built by Teng Kian Boon for 180Climate, with AI assistance.

## Licence

Apache License 2.0; see `LICENSE`. Copyright 2026 Teng Kian Boon.
