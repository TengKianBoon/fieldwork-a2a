// A2A (Agent2Agent protocol v1.0, JSON-RPC binding) for 180Climate Fieldwork.
// Another company's AI agent reads the Agent Card, then drafts a field job and
// follows it as an A2A task. The job itself lives in FieldProof's existing job
// system; this layer only speaks A2A and keeps one small record per task.
//
// Clients: every client has its own key (header X-Fieldwork-Key). Only the
// key's SHA-256 is configured here, mapped to a client id. Every task is
// stored under its client and is visible to that client only: another
// client's task answers "task not found", in every method. The service calls
// FieldProof with 180Climate's own requester code, a server-side secret that
// no client ever sees, sends or needs.
//
// Who does what (a managed service): 180Climate is the requester
// on record in FieldProof. A client's agent drafts a job and follows it. A
// 180Climate person reviews each draft, publishes it, invites field
// professionals and makes the selection with the client; a person decides
// every item of evidence. No claim link or access code is ever sent to a client.
//
// Task model: one task per job drafted here (task id = job id).
//   draft -> TASK_STATE_SUBMITTED   open -> TASK_STATE_WORKING
//   accepted -> TASK_STATE_COMPLETED   cancelled -> TASK_STATE_CANCELED
// SendMessage answers at once: the work behind a job takes days and is done by
// people, so the task is followed with GetTask or ListTasks. Streaming, push
// notifications and an extended card are declared false in the Agent Card and
// answered with the matching A2A errors.
import { createHash, randomUUID } from "node:crypto";
import type { FieldProof, JobView } from "./fieldproof.mts";
import type { KV } from "./store.mts";

type Json = Record<string, unknown>;
type RpcId = string | number;

export const A2A_VERSION = "1.0";
export const TASK_PREFIX = "task/";
export const QUOTA_PREFIX = "quota/";
export const MESSAGE_PREFIX = "msg/";
export const CLIENT_ID_RE = /^[a-z0-9][a-z0-9-]{1,31}$/;
export const ACCESS_URL = "https://www.180climate.net/contact/fieldwork/";
const ERROR_INFO = "type.googleapis.com/google.rpc.ErrorInfo";
const BAD_REQUEST = "type.googleapis.com/google.rpc.BadRequest";
const MAX_ID = 120;
export const MAX_MESSAGE_ID = 80;
const LOAD_CONCURRENCY = 25;
const REFRESH_CONCURRENCY = 8;
const CONFIRM_EVERY_MS = 3_600_000;
const TERMINAL = new Set(["accepted", "cancelled"]);
const NO_STORE = { "cache-control": "no-store" };

export interface TaskRecord {
  clientId: string;
  jobId: string;
  contextId: string;
  messageId: string;
  createdAt: string;
  // When the job's state last moved (status or counts), as this service saw it.
  changedAt: string;
  // When FieldProof last confirmed the state (written at most hourly when unchanged).
  confirmedAt?: string;
  // FieldProof's read-only agent link (job status only). Never returned to anyone.
  agentToken: string;
  // The exact job-create body, kept to renew the agent link after 14 days.
  // It holds the item codes and is never returned to anyone.
  request?: Json;
  // True when the live status could not be read and the link could not be renewed.
  stale?: boolean;
  view: JobView;
}

interface RpcFailure {
  code: number;
  message: string;
  reason: string;
  domain?: string;
  violations?: Array<{ field: string; description: string }>;
  http?: number;
  headers?: Record<string, string>;
}

class Fail extends Error {
  rpc: RpcFailure;
  constructor(rpc: RpcFailure) {
    super(rpc.message);
    this.rpc = rpc;
  }
}

const invalidParams = (field: string, description: string): Fail =>
  new Fail({ code: -32602, message: `Invalid parameters: ${field} ${description}`, reason: "INVALID_PARAMS", violations: [{ field, description }] });
const taskNotFound = (): Fail => new Fail({ code: -32001, message: "Task not found", reason: "TASK_NOT_FOUND" });
const unsupported = (message: string): Fail => new Fail({ code: -32004, message, reason: "UNSUPPORTED_OPERATION" });
const UNREACHABLE: RpcFailure = { code: -32603, message: "Fieldwork could not be reached; try again shortly", reason: "INTERNAL_ERROR", http: 503 };
const unreachable = (): Fail => new Fail(UNREACHABLE);

function respond(id: RpcId | null, body: Json, http = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, ...body }), {
    status: http,
    headers: { "content-type": "application/json", ...NO_STORE, ...headers },
  });
}

function rpcError(id: RpcId | null, f: RpcFailure): Response {
  const data: Json[] = [{ "@type": ERROR_INFO, reason: f.reason, domain: f.domain ?? "a2a-protocol.org", metadata: {} }];
  if (f.violations !== undefined) data.push({ "@type": BAD_REQUEST, fieldViolations: f.violations });
  return respond(id, { error: { code: f.code, message: f.message, data } }, f.http ?? 200, f.headers ?? {});
}

// For the entry point: storage itself could not be opened.
export function serviceUnavailable(): Response {
  return rpcError(null, UNREACHABLE);
}

const sha = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

function isObj(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function text(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

// Runs fn over items, at most `limit` at a time, keeping the order.
async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// p, or the fallback once ms have passed (p keeps running and may still save).
function withDeadline<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<T>((res) => {
    t = setTimeout(() => res(fallback), Math.max(0, ms));
  });
  return Promise.race([p.catch(() => fallback), late]).finally(() => clearTimeout(t));
}

// ---- the job format agents send ----
const REQUIRED = ["title", "outcome", "region", "windowStart", "windowEnd", "budgetMin", "budgetMax", "currency", "bidDeadline", "site", "items", "checkDeadline"];

// camelCase is the documented format (as everywhere in A2A JSON); the
// snake_case names of FieldProof's MCP tool are accepted too.
const ALIASES: Record<string, string> = {
  window_start: "windowStart", window_end: "windowEnd", budget_min: "budgetMin", budget_max: "budgetMax",
  bid_deadline: "bidDeadline", check_deadline: "checkDeadline", safety_notes: "safetyNotes", photo_tips: "photoTips",
};
function normalize(a: Json): Json {
  const out: Json = { ...a };
  for (const [snake, camel] of Object.entries(ALIASES)) {
    if (out[camel] === undefined && out[snake] !== undefined) out[camel] = out[snake];
    delete out[snake];
  }
  return out;
}

export const EXAMPLE_JOB = {
  title: "Sample-bag tag check",
  outcome: "Photograph the tag on each soil sample bag in the store.",
  region: "Riau, Sumatra",
  windowStart: "2026-12-07",
  windowEnd: "2026-12-09",
  budgetMin: 150,
  budgetMax: 300,
  currency: "USD",
  bidDeadline: "2026-12-03T18:00:00+07:00",
  site: "Sample store A",
  items: ["B12", "B17"],
  checkDeadline: "2026-12-12T18:00:00+07:00",
};

const HELP = [
  "Send the field job as one JSON object (a data part, or a text part holding only the JSON) with:",
  "title, outcome, region (broad region only, no address), windowStart and windowEnd (YYYY-MM-DD),",
  "budgetMin, budgetMax, currency (ISO code such as USD, SGD or IDR), bidDeadline and checkDeadline",
  "(ISO times with an offset, e.g. 2026-12-03T18:00:00+07:00), site (a label for the site) and items",
  "(1-10 expected tag codes, letters or digits). Optional: deliverables, skills (up to 8), safetyNotes,",
  "photoTips (one per item). Keep the item codes and any contact details out of the texts.",
].join(" ");

// FieldProof's validation answers, and only these, are explained to the
// client as "the job was not accepted". Anything else is a service problem.
export const WHY: Record<string, string> = {
  bad_deadline: "A deadline could not be read. Use an ISO time with an offset, e.g. 2026-12-03T18:00:00+07:00.",
  bad_label: "Each item code must be 1-20 letters or digits.",
  bad_item_count: "A job needs 1 to 10 items.",
  job_leaks_code: "A job text mentions an expected item code. Remove it: invited professionals must never see the codes.",
  contact_details_not_allowed: "Remove phone numbers, e-mail addresses and links: contact details are shared only after a professional accepts.",
  bad_window: "The work window must start on or before its last day (YYYY-MM-DD).",
  bad_money: "Budgets must be numbers, with the minimum not above the maximum.",
  bad_currency: "Use a three-letter currency code such as USD, SGD or IDR.",
  bad_date: "Dates must be YYYY-MM-DD.",
  missing_field: "A required field is empty.",
  text_too_long: "One of the texts is too long.",
  bad_text: "One of the texts has characters that are not allowed.",
  bad_skills: "Skills must be a list of up to 8 short texts.",
  bad_input: "The job could not be read.",
};
// FieldProof's field names, as this agent's job format names them.
export const FIELD_NAMES: Record<string, string> = {
  title: "title", outcome: "outcome", deliverables: "deliverables", region: "region", safetyNotes: "safetyNotes",
  siteLabel: "site", skills: "skills", photoHint: "photoTips",
};

function findJob(parts: unknown[]): { job: Json | null; fileOnly: boolean } {
  let usable = false;
  for (const p of parts) {
    if (!isObj(p)) continue;
    if (isObj(p.data)) return { job: p.data, fileOnly: false };
    if (p.data !== undefined) usable = true;
    if (typeof p.text === "string") {
      usable = true;
      const t = p.text.trim();
      if (t.startsWith("{")) {
        try {
          const o = JSON.parse(t) as unknown;
          if (isObj(o)) return { job: o, fileOnly: false };
        } catch {
          // plain words: answered with the format
        }
      }
    }
  }
  return { job: null, fileOnly: !usable };
}

// Builds FieldProof's job-create body from named fields only: nothing else a
// client sends reaches FieldProof, and createdBy and the retry key are fixed here.
export function toFieldProof(a: Json, idempotencyKey: string): Json {
  const items = Array.isArray(a.items) ? a.items : [];
  const tips = Array.isArray(a.photoTips) ? a.photoTips : [];
  return {
    title: a.title, outcome: a.outcome, deliverables: a.deliverables, region: a.region,
    windowStart: a.windowStart, windowEnd: a.windowEnd,
    budget: { min: a.budgetMin, max: a.budgetMax, currency: typeof a.currency === "string" ? a.currency.trim().toUpperCase() : a.currency },
    skills: a.skills, safetyNotes: a.safetyNotes, bidDeadline: a.bidDeadline, siteLabel: a.site,
    items: items.map((c, i) => {
      const tip = text(tips[i]);
      return { expectedLabel: typeof c === "string" ? c.trim().toUpperCase() : c, ...(tip === null ? {} : { photoHint: tip }) };
    }),
    checkDeadline: a.checkDeadline,
    createdBy: "agent",
    idempotencyKey,
  };
}

// The FieldProof retry key: the client id is part of it, so two clients never
// share a namespace. At most 4 + 32 + 1 + 80 = 117 characters (FieldProof: 128).
export const retryKey = (clientId: string, messageId: string): string => `a2a:${clientId}:${messageId}`;

function boundedId(v: unknown, field: string, required: boolean): string | null {
  if (v === undefined || v === null || v === "") {
    if (required) throw invalidParams(field, "is required");
    return null;
  }
  if (typeof v !== "string" || v.length > MAX_ID) throw invalidParams(field, `must be a string of at most ${MAX_ID} characters`);
  return v;
}

function agentMessage(contextId: string, words: string, data?: Json): Json {
  return {
    message: {
      messageId: `m-${randomUUID()}`,
      contextId,
      role: "ROLE_AGENT",
      parts: data === undefined ? [{ text: words }] : [{ text: words }, { data, mediaType: "application/json" }],
    },
  };
}

// ---- task view ----
const STATE: Record<string, string> = {
  draft: "TASK_STATE_SUBMITTED",
  open: "TASK_STATE_WORKING",
  accepted: "TASK_STATE_COMPLETED",
  cancelled: "TASK_STATE_CANCELED",
};
const STATE_NAMES = [
  "TASK_STATE_UNSPECIFIED", "TASK_STATE_SUBMITTED", "TASK_STATE_WORKING", "TASK_STATE_COMPLETED", "TASK_STATE_FAILED",
  "TASK_STATE_CANCELED", "TASK_STATE_INPUT_REQUIRED", "TASK_STATE_REJECTED", "TASK_STATE_AUTH_REQUIRED",
];

// What counts as the job's state moving: status and counts, not wording.
const signature = (v: JobView): string => JSON.stringify([v.status, v.invited, v.submitted, v.selectionPending, v.engaged, v.missionId]);

export interface Limits {
  // New jobs a client may draft per UTC day, and in total, during the pilot.
  perDay: number;
  total: number;
}
export const DEFAULT_LIMITS: Limits = { perDay: 50, total: 500 };

export interface Deps {
  kv: KV;
  fieldproof: FieldProof;
  // sha256(client key) -> client id. Keys themselves are never stored here.
  clients: Map<string, string>;
  // 180Climate's FieldProof requester code: server-side only.
  fieldproofCode: string;
  now?: () => Date;
  limits?: Limits;
  // Time allowed for reading live job states within one call.
  refreshBudgetMs?: number;
}

// FIELDWORK_A2A_CLIENTS is a JSON object {"<sha256 of key>": "<client id>"}.
// Entries with a malformed hash or client id are ignored (and counted).
export function parseClients(raw: string | undefined, onIgnored?: (count: number) => void): Map<string, string> {
  const m = new Map<string, string>();
  if (raw === undefined || raw.trim() === "") return m;
  const o = JSON.parse(raw) as unknown;
  if (!isObj(o)) throw new Error("FIELDWORK_A2A_CLIENTS must be a JSON object");
  let ignored = 0;
  for (const [hash, id] of Object.entries(o)) {
    const h = hash.trim().toLowerCase();
    if (/^[0-9a-f]{64}$/.test(h) && typeof id === "string" && CLIENT_ID_RE.test(id)) m.set(h, id);
    else ignored += 1;
  }
  if (ignored > 0 && onIgnored !== undefined) onIgnored(ignored);
  return m;
}

// The task store and live-state reading, shared by the A2A endpoint and the
// 180Climate operator queue.
function core(deps: Deps) {
  const { kv, fieldproof } = deps;
  const now = deps.now ?? (() => new Date());
  const budget = deps.refreshBudgetMs ?? 6_000;

  function statusText(r: TaskRecord): string {
    const v = r.view;
    let s: string;
    if (v.status === "draft") {
      s = `Draft field job saved; nobody outside 180Climate can see it yet. A 180Climate person reviews it, publishes it and invites field professionals. To discuss it, quote job reference ${v.jobId} at ${ACCESS_URL}`;
    } else if (v.status === "open") {
      const pending = v.selectionPending ? "; a professional has been chosen and has not accepted yet" : "";
      const deadline = Date.parse(v.bidDeadline);
      const closed = !v.selectionPending && Number.isFinite(deadline) && deadline < now().getTime() ? `; bidding closed at ${v.bidDeadline} and a choice is being made` : "";
      s = `Open for bids: ${v.invited} professional(s) invited, ${v.submitted} bid(s) received${pending}${closed}.`;
    } else if (v.status === "accepted") {
      s = `A field professional accepted. Field check ${String(v.missionId)} has started; a person reviews and decides every item of evidence.`;
    } else if (v.status === "cancelled") {
      s = "This job was cancelled.";
    } else {
      s = `The job's status is ${/^[a-z_]{1,30}$/.test(v.status) ? v.status : "not known"}.`;
    }
    if (r.stale === true) s += ` The live status could not be read: this is the status last confirmed at ${r.confirmedAt ?? r.changedAt}.`;
    return s;
  }

  function toTask(r: TaskRecord, withArtifacts: boolean): Json {
    const task: Json = {
      id: r.jobId,
      contextId: r.contextId,
      status: {
        state: STATE[r.view.status] ?? "TASK_STATE_UNSPECIFIED",
        message: {
          messageId: `${r.jobId}:${sha(JSON.stringify([r.view, r.stale === true])).slice(0, 12)}`,
          contextId: r.contextId,
          taskId: r.jobId,
          role: "ROLE_AGENT",
          parts: [{ text: statusText(r) }],
        },
        timestamp: r.changedAt,
      },
    };
    if (withArtifacts) {
      const data: Json = { ...r.view };
      if (r.stale === true) {
        data.stale = true;
        data.lastConfirmedAt = r.confirmedAt ?? r.changedAt;
      }
      task.artifacts = [{
        artifactId: "field-job",
        name: "Field job",
        description: "Job status, title, bid deadline, identifiers and counts, plus selection and freshness information. The artifact omits separate fields for names, prices, contact details, item codes and private links.",
        parts: [{ data, mediaType: "application/json" }],
      }];
    }
    return task;
  }

  const clientPrefix = (clientId: string): string => `${TASK_PREFIX}${clientId}/`;
  const taskKey = (clientId: string, jobId: string): string => `${clientPrefix(clientId)}${jobId}`;
  const save = (r: TaskRecord): Promise<void> => kv.set(taskKey(r.clientId, r.jobId), JSON.stringify(r));

  // A task is found only under the calling client's own prefix.
  async function load(clientId: string, id: string): Promise<TaskRecord | null> {
    if (id.includes("/") || id.includes("\\")) return null;
    const raw = await kv.get(taskKey(clientId, id));
    return raw === null ? null : (JSON.parse(raw) as TaskRecord);
  }

  // Reads the job's current state from FieldProof and saves it when it moved.
  // An expired agent link (FieldProof issues 14-day links) is renewed by
  // re-sending the same job-create call, which returns the same job with a
  // fresh link. When FieldProof is briefly unreachable the last known state
  // stands; when the state cannot be read at all, the task is marked stale.
  async function refresh(r: TaskRecord): Promise<TaskRecord> {
    if (TERMINAL.has(r.view.status)) return r;
    let token = r.agentToken;
    let s = await fieldproof.jobStatus(r.jobId, token);
    let renewed = false;
    if (!s.ok && s.status === 403 && r.request !== undefined) {
      const again = await fieldproof.createJob(deps.fieldproofCode, r.request);
      if (again.ok && again.jobId === r.jobId) {
        token = again.agentToken;
        renewed = true;
        s = await fieldproof.jobStatus(r.jobId, token);
      }
    }
    if (!s.ok) {
      const transient = s.status === 0 || s.status >= 500 || s.error === "store_conflict";
      if (transient || r.stale === true) return r;
      const next: TaskRecord = { ...r, stale: true };
      await save(next);
      return next;
    }
    const at = now().toISOString();
    const moved = signature(s.view) !== signature(r.view);
    const reworded = JSON.stringify(s.view) !== JSON.stringify(r.view);
    const confirmDue = r.confirmedAt === undefined || Date.parse(at) - Date.parse(r.confirmedAt) >= CONFIRM_EVERY_MS;
    if (!moved && !reworded && !renewed && r.stale !== true && !confirmDue) return r;
    let changedAt = moved ? at : r.changedAt;
    // Another call may have saved the same move first: keep its time.
    const cur = await load(r.clientId, r.jobId);
    if (cur !== null && moved && signature(cur.view) === signature(s.view)) changedAt = cur.changedAt;
    const next: TaskRecord = { ...r, view: s.view, agentToken: token, stale: false, confirmedAt: at, changedAt };
    await save(next);
    return next;
  }

  const refreshSoon = (r: TaskRecord, ms = budget): Promise<TaskRecord> => withDeadline(refresh(r), ms, r);

  // Reads live states for a page of tasks within the time budget, a few at a
  // time. Finished jobs are not read again; any task not read in time keeps
  // its stored state.
  async function refreshPage(records: TaskRecord[]): Promise<TaskRecord[]> {
    const out = records.slice();
    const end = performance.now() + budget;
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < records.length) {
        const i = next++;
        const left = end - performance.now();
        if (left <= 0) return;
        out[i] = await withDeadline(refresh(records[i]), left, records[i]);
      }
    };
    await Promise.all(Array.from({ length: Math.min(REFRESH_CONCURRENCY, records.length) }, worker));
    return out;
  }
  return { now, budget, statusText, toTask, clientPrefix, taskKey, save, load, refresh, refreshSoon, refreshPage };
}

export function createA2AHandler(deps: Deps): (req: Request) => Promise<Response> {
  const { kv, fieldproof } = deps;
  const limits = deps.limits ?? DEFAULT_LIMITS;
  const { now, toTask, clientPrefix, taskKey, save, load, refreshSoon, refreshPage } = core(deps);

  // Pilot limits: new jobs per client per UTC day (hard: one slot per job,
  // taken atomically before FieldProof is called, so parallel requests cannot
  // pass it) and in total (soft: checked before the slot, so a burst can pass
  // it by at most one day's allowance). A retried message never needs a slot.
  const quotaDay = (): string => `${QUOTA_PREFIX}${now().toISOString().slice(0, 10)}`;
  async function reserveSlot(clientId: string): Promise<string> {
    const total = (await kv.list(clientPrefix(clientId))).length;
    if (total >= limits.total) {
      throw new Fail({
        code: -32000, message: `This client has reached the pilot limit of ${limits.total} jobs. Ask 180Climate to raise it at ${ACCESS_URL}`,
        reason: "RESOURCE_EXHAUSTED", domain: "180climate.net", http: 429,
      });
    }
    // Every slot is tried from the first, so a slot given back after a
    // failure is used again (a counted start could skip it for the day).
    const dayPrefix = `${quotaDay()}/${clientId}/`;
    for (let n = 0; n < limits.perDay; n++) {
      const slot = `${dayPrefix}${String(n).padStart(4, "0")}`;
      if (await kv.setIfAbsent(slot, now().toISOString())) return slot;
    }
    const t = now();
    const midnight = Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate() + 1);
    throw new Fail({
      code: -32000, message: `This client has drafted its ${limits.perDay} jobs for today (UTC). Try again after midnight UTC.`,
      reason: "RESOURCE_EXHAUSTED", domain: "180climate.net", http: 429,
      headers: { "retry-after": String(Math.max(1, Math.ceil((midnight - t.getTime()) / 1000))) },
    });
  }

  // Each message id a client used, with the job it drafted: a retry is
  // answered from here, before any limit, and never drafts twice.
  const messageKey = (clientId: string, messageId: string): string => `${MESSAGE_PREFIX}${clientId}/${sha(messageId).slice(0, 40)}`;

  async function sendMessage(p: Json, clientId: string): Promise<Json> {
    const msg = p.message;
    if (!isObj(msg)) throw invalidParams("message", "is required");
    const messageId = boundedId(msg.messageId, "message.messageId", true) as string;
    if (messageId.length > MAX_MESSAGE_ID) throw invalidParams("message.messageId", `must be at most ${MAX_MESSAGE_ID} characters`);
    if (msg.role !== "ROLE_USER" && msg.role !== 1) throw invalidParams("message.role", "must be ROLE_USER");
    if (!Array.isArray(msg.parts) || msg.parts.length === 0) throw invalidParams("message.parts", "needs at least one part");
    const askedContext = boundedId(msg.contextId, "message.contextId", false);
    const taskId = boundedId(msg.taskId, "message.taskId", false);
    if (isObj(p.configuration) && p.configuration.taskPushNotificationConfig !== undefined && p.configuration.taskPushNotificationConfig !== null) {
      throw new Fail({ code: -32003, message: "Push notifications are not supported; follow the task with GetTask", reason: "PUSH_NOTIFICATION_NOT_SUPPORTED" });
    }
    if (taskId !== null) {
      const t = await load(clientId, taskId);
      if (t === null) throw taskNotFound();
      const cur = await refreshSoon(t);
      if (TERMINAL.has(cur.view.status)) throw unsupported("This task has finished and cannot take more messages");
      throw unsupported(`A drafted job is changed only by a 180Climate person: quote job reference ${taskId} at ${ACCESS_URL}. Follow it with GetTask, or send a new message without taskId to draft another job.`);
    }
    const contextId = askedContext ?? `ctx-${randomUUID()}`;
    const found = findJob(msg.parts);
    const job = found.job === null ? null : normalize(found.job);
    if (job === null) {
      if (found.fileOnly) throw new Fail({ code: -32005, message: "Only JSON data and text parts are supported: send the job as JSON", reason: "CONTENT_TYPE_NOT_SUPPORTED" });
      return agentMessage(contextId, `I can draft a field job for a person on the ground. ${HELP}`, { example: EXAMPLE_JOB });
    }
    const missing = REQUIRED.filter((k) => job[k] === undefined || job[k] === null || job[k] === "");
    if (missing.length > 0) {
      return agentMessage(contextId, `The job is missing: ${missing.join(", ")}. ${HELP}`, { error: "missing_field", missing, example: EXAMPLE_JOB });
    }
    const request = toFieldProof(job, retryKey(clientId, messageId));
    const print = sha(JSON.stringify(request));
    const seenRaw = await kv.get(messageKey(clientId, messageId));
    if (seenRaw !== null) {
      const seen = JSON.parse(seenRaw) as { jobId: string; print: string };
      if (seen.print !== print) throw invalidParams("message.messageId", "was already used for a different job; use a new messageId");
      const prior = await load(clientId, seen.jobId);
      if (prior !== null) return { task: toTask(await refreshSoon(prior), true) };
    }
    const slot = await reserveSlot(clientId);
    let kept = false;
    try {
      const result = await draftNew(contextId, clientId, messageId, job, request, print);
      kept = result.kept;
      return result.reply;
    } finally {
      if (!kept) await kv.delete(slot);
    }
  }

  // Drafts the job in FieldProof and stores its task. kept: whether a new
  // task was stored (otherwise the reserved slot is given back).
  async function draftNew(contextId: string, clientId: string, messageId: string, job: Json, request: Json, print: string): Promise<{ reply: Json; kept: boolean }> {
    const created = await fieldproof.createJob(deps.fieldproofCode, request);
    if (!created.ok) {
      if (created.error === "idempotency_conflict") throw invalidParams("message.messageId", "was already used for a different job; use a new messageId");
      if (created.error === "jobs_disabled") throw unsupported("Fieldwork jobs are switched off right now");
      if (created.status === 403) {
        console.error("fieldwork-a2a: FieldProof refused 180Climate's requester code (check FIELDPROOF_REQUESTER_CODE)");
        throw new Fail({ code: -32603, message: "Fieldwork is not configured correctly; 180Climate has been asked to check it", reason: "INTERNAL_ERROR", http: 503 });
      }
      if (created.status === 400 && WHY[created.error] !== undefined) {
        const field = created.field === undefined ? undefined : FIELD_NAMES[created.field];
        const why = created.error === "job_leaks_code" && field !== undefined ? WHY.job_leaks_code.replace("A job text", `The ${field} text`) : WHY[created.error];
        return { reply: agentMessage(contextId, `${why} Nothing was saved.`, { error: created.error, ...(field === undefined ? {} : { field }) }), kept: false };
      }
      console.error(`fieldwork-a2a: job-create answered ${created.status} ${/^[a-z_]{1,40}$/.test(created.error) ? created.error : "(other)"}`);
      throw unreachable();
    }
    const at = now().toISOString();
    const first: TaskRecord = {
      clientId, jobId: created.jobId, contextId, messageId, createdAt: at, changedAt: at, confirmedAt: at,
      agentToken: created.agentToken, request, stale: false,
      view: {
        jobId: created.jobId, status: "draft", title: String(job.title), bidDeadline: String(job.bidDeadline),
        invited: 0, submitted: 0, selectionPending: false, engaged: false, missionId: null,
      },
    };
    let rec = first;
    const isNew = await kv.setIfAbsent(taskKey(clientId, created.jobId), JSON.stringify(first));
    await kv.set(messageKey(clientId, messageId), JSON.stringify({ jobId: created.jobId, print }));
    if (!isNew) {
      // A retried message (same messageId, same job) converges on one task,
      // and keeps the fresh agent link FieldProof just issued.
      const existing = await load(clientId, created.jobId);
      if (existing !== null) {
        rec = { ...existing, agentToken: created.agentToken, request, stale: false };
        await save(rec);
      }
    }
    return { reply: { task: toTask(await refreshSoon(rec), true) }, kept: isNew };
  }

  async function getTask(p: Json, clientId: string): Promise<Json> {
    const id = boundedId(p.id, "id", true) as string;
    if (p.historyLength !== undefined && (typeof p.historyLength !== "number" || p.historyLength < 0)) {
      throw invalidParams("historyLength", "must be zero or more");
    }
    const t = await load(clientId, id);
    if (t === null) throw taskNotFound();
    return toTask(await refreshSoon(t), true);
  }

  async function cancelTask(p: Json, clientId: string): Promise<Json> {
    const id = boundedId(p.id, "id", true) as string;
    const t = await load(clientId, id);
    if (t === null) throw taskNotFound();
    const cur = await refreshSoon(t);
    if (TERMINAL.has(cur.view.status)) {
      throw new Fail({ code: -32002, message: `This task has finished (${STATE[cur.view.status]}) and cannot be canceled`, reason: "TASK_NOT_CANCELABLE" });
    }
    throw new Fail({ code: -32002, message: `Only 180Climate can cancel a job: ask at ${ACCESS_URL}, quoting job reference ${id}`, reason: "TASK_NOT_CANCELABLE" });
  }

  function stateFilter(v: unknown): string | null {
    if (v === undefined || v === null || v === "" || v === 0 || v === "TASK_STATE_UNSPECIFIED") return null;
    if (typeof v === "number" && Number.isInteger(v) && v > 0 && v < STATE_NAMES.length) return STATE_NAMES[v];
    if (typeof v === "string" && STATE_NAMES.includes(v)) return v;
    throw invalidParams("status", "is not a task state");
  }

  // Newest state change first; ties by job id, also newest-first order.
  const newestFirst = (a: TaskRecord, b: TaskRecord): number =>
    a.changedAt === b.changedAt ? (a.jobId < b.jobId ? 1 : a.jobId > b.jobId ? -1 : 0) : a.changedAt < b.changedAt ? 1 : -1;

  // Pages over the client's stored tasks (all of them, newest state change
  // first), then reads live states for that page only. A task whose state
  // changes between two page requests can move to the top of the list.
  async function listTasks(p: Json, clientId: string): Promise<Json> {
    let pageSize = 50;
    if (p.pageSize !== undefined) {
      if (typeof p.pageSize !== "number" || !Number.isInteger(p.pageSize) || p.pageSize < 1 || p.pageSize > 100) {
        throw invalidParams("pageSize", "must be a whole number from 1 to 100");
      }
      pageSize = p.pageSize;
    }
    if (p.historyLength !== undefined && (typeof p.historyLength !== "number" || p.historyLength < 0)) {
      throw invalidParams("historyLength", "must be zero or more");
    }
    const state = stateFilter(p.status);
    const contextId = boundedId(p.contextId, "contextId", false);
    let after: number | null = null;
    if (p.statusTimestampAfter !== undefined && p.statusTimestampAfter !== "") {
      after = typeof p.statusTimestampAfter === "string" ? Date.parse(p.statusTimestampAfter) : Number.NaN;
      if (!Number.isFinite(after)) throw invalidParams("statusTimestampAfter", "must be an ISO 8601 time");
    }
    let cursor: { t: string; id: string } | null = null;
    if (p.pageToken !== undefined && p.pageToken !== "") {
      try {
        const c = JSON.parse(Buffer.from(String(p.pageToken), "base64url").toString("utf8")) as { t: unknown; id: unknown };
        if (typeof c.t !== "string" || typeof c.id !== "string" || !Number.isFinite(Date.parse(c.t))) throw new Error("bad");
        cursor = { t: c.t, id: c.id };
      } catch {
        throw invalidParams("pageToken", "is not a token from this agent");
      }
    }
    const prefix = clientPrefix(clientId);
    const keys = await kv.list(prefix);
    const stored = (await mapLimit(keys, LOAD_CONCURRENCY, (k) => load(clientId, k.slice(prefix.length)))).filter((r): r is TaskRecord => r !== null);
    const matches = (r: TaskRecord): boolean =>
      (state === null || STATE[r.view.status] === state) &&
      (contextId === null || r.contextId === contextId) &&
      (after === null || Date.parse(r.changedAt) >= (after as number));
    const matching = stored.filter(matches).sort(newestFirst);
    const c = cursor;
    const start = c === null ? 0 : matching.findIndex((r) => r.changedAt < c.t || (r.changedAt === c.t && r.jobId < c.id));
    const from = start === -1 ? matching.length : start;
    const slice = matching.slice(from, from + pageSize);
    const live = await refreshPage(slice);
    // A task whose live state no longer fits the filter is left out of this page.
    const page = live.filter(matches).sort(newestFirst);
    const last = slice[slice.length - 1];
    const more = from + pageSize < matching.length;
    return {
      tasks: page.map((r) => toTask(r, p.includeArtifacts === true)),
      nextPageToken: more && last !== undefined ? Buffer.from(JSON.stringify({ t: last.changedAt, id: last.jobId }), "utf8").toString("base64url") : "",
      pageSize,
      totalSize: matching.length - (slice.length - page.length),
    };
  }

  const challenge: RpcFailure = {
    code: -32000,
    message: `Unauthenticated: send your Fieldwork A2A client key in the X-Fieldwork-Key header. Request one at ${ACCESS_URL}`,
    reason: "UNAUTHENTICATED",
    domain: "180climate.net",
    http: 401,
    headers: { "www-authenticate": "ApiKey header=\"X-Fieldwork-Key\"" },
  };

  // The client a key belongs to, or null. Only hashes are compared.
  function clientFor(key: string | null): string | null {
    const k = key?.trim() ?? "";
    if (k === "") return null;
    return deps.clients.get(sha(k)) ?? null;
  }

  // The request id, if the body has one: used only to address an error.
  function idOf(raw: string): RpcId | null {
    try {
      const b = JSON.parse(raw) as unknown;
      return isObj(b) && (typeof b.id === "string" || typeof b.id === "number") ? b.id : null;
    } catch {
      return null;
    }
  }

  return async function handle(req: Request): Promise<Response> {
    if (req.method !== "POST") {
      return new Response(JSON.stringify({ error: "method", hint: "A2A JSON-RPC 2.0 over POST. The Agent Card is at /.well-known/agent-card.json." }), {
        status: 405, headers: { "content-type": "application/json", allow: "POST", ...NO_STORE },
      });
    }
    const raw = await req.text();
    // Who is calling comes first: nothing about any task, or the request, is
    // answered to an unknown caller.
    if (deps.clients.size === 0 || deps.fieldproofCode === "") {
      return rpcError(idOf(raw), { code: -32603, message: "Fieldwork A2A is not configured yet", reason: "INTERNAL_ERROR", http: 503 });
    }
    const clientId = clientFor(req.headers.get("x-fieldwork-key"));
    if (clientId === null) return rpcError(idOf(raw), challenge);
    let body: unknown;
    try {
      body = JSON.parse(raw) as unknown;
    } catch {
      return rpcError(null, { code: -32700, message: "Invalid JSON payload", reason: "PARSE_ERROR" });
    }
    if (!isObj(body)) return rpcError(null, { code: -32600, message: "Request payload validation error", reason: "INVALID_REQUEST" });
    const id = typeof body.id === "string" || typeof body.id === "number" ? body.id : null;
    if (body.jsonrpc !== "2.0" || typeof body.method !== "string" || id === null) {
      return rpcError(id, { code: -32600, message: "Request payload validation error: jsonrpc must be \"2.0\", with a method and an id", reason: "INVALID_REQUEST" });
    }
    const version = (req.headers.get("a2a-version") ?? new URL(req.url).searchParams.get("A2A-Version") ?? "").trim() || "0.3";
    const mm = /^(\d+)\.(\d+)(\.\d+)?$/.exec(version);
    if (mm === null || `${mm[1]}.${mm[2]}` !== A2A_VERSION) {
      return rpcError(id, {
        code: -32009,
        message: `A2A version ${version.slice(0, 20)} is not supported. This agent speaks A2A ${A2A_VERSION}: send the header A2A-Version: ${A2A_VERSION}`,
        reason: "VERSION_NOT_SUPPORTED",
      });
    }
    const params = body.params === undefined ? {} : body.params;
    if (!isObj(params)) return rpcError(id, { code: -32602, message: "Invalid parameters: params must be an object", reason: "INVALID_PARAMS" });
    try {
      switch (body.method) {
        case "SendMessage":
          return respond(id, { result: await sendMessage(params, clientId) });
        case "GetTask":
          return respond(id, { result: await getTask(params, clientId) });
        case "ListTasks":
          return respond(id, { result: await listTasks(params, clientId) });
        case "CancelTask":
          return respond(id, { result: await cancelTask(params, clientId) });
        case "SendStreamingMessage":
        case "SubscribeToTask":
          throw unsupported("Streaming is not supported (capabilities.streaming is false): use SendMessage and GetTask");
        case "CreateTaskPushNotificationConfig":
        case "GetTaskPushNotificationConfig":
        case "ListTaskPushNotificationConfigs":
        case "DeleteTaskPushNotificationConfig":
          throw new Fail({ code: -32003, message: "Push notifications are not supported (capabilities.pushNotifications is false)", reason: "PUSH_NOTIFICATION_NOT_SUPPORTED" });
        case "GetExtendedAgentCard":
          throw unsupported("This agent has no extended Agent Card (capabilities.extendedAgentCard is false)");
        default:
          return rpcError(id, { code: -32601, message: "Method not found", reason: "METHOD_NOT_FOUND" });
      }
    } catch (e) {
      if (e instanceof Fail) return rpcError(id, e.rpc);
      console.error(`fieldwork-a2a: internal error in ${body.method}: ${e instanceof Error ? `${e.name}: ${e.message}` : typeof e}`);
      return rpcError(id, { code: -32603, message: "Internal error", reason: "INTERNAL_ERROR", http: 500 });
    }
  };
}

// ---- the 180Climate operator queue ----
// GET /ops/queue with the header X-Fieldwork-Operator-Key lists the jobs that
// clients' agents drafted, across all clients, oldest first, with the claim
// link the operator opens in FieldProof (then enters 180Climate's access code,
// reviews, publishes, invites and selects with the client). ?state=draft (the
// default), open, accepted, cancelled or all. Operator keys are configured as
// FIELDWORK_OPERATOR_KEYS {"<sha256 of key>": "<operator name>"}; this route
// is never reachable with a client key, and clients never see what it returns.
export interface OperatorDeps extends Deps {
  operators: Map<string, string>;
}

export function createOperatorHandler(deps: OperatorDeps): (req: Request) => Promise<Response> {
  const { kv, fieldproof } = deps;
  const { now, statusText, load, refreshPage } = core(deps);
  const reply = (status: number, body: Json, headers: Record<string, string> = {}): Response =>
    new Response(JSON.stringify(body, null, 2), { status, headers: { "content-type": "application/json", ...NO_STORE, ...headers } });
  return async function handle(req: Request): Promise<Response> {
    if (req.method !== "GET") return reply(405, { error: "method", hint: "GET /ops/queue with X-Fieldwork-Operator-Key" }, { allow: "GET" });
    if (deps.operators.size === 0) return reply(503, { error: "not_configured", hint: "Set FIELDWORK_OPERATOR_KEYS" });
    const key = req.headers.get("x-fieldwork-operator-key")?.trim() ?? "";
    const operator = key === "" ? undefined : deps.operators.get(sha(key));
    if (operator === undefined) return reply(401, { error: "unauthenticated", hint: "Send a 180Climate operator key in X-Fieldwork-Operator-Key" }, { "www-authenticate": "ApiKey header=\"X-Fieldwork-Operator-Key\"" });
    const want = new URL(req.url).searchParams.get("state") ?? "draft";
    if (!["draft", "open", "accepted", "cancelled", "all"].includes(want)) return reply(400, { error: "bad_state", hint: "state is draft, open, accepted, cancelled or all" });
    const keys = await kv.list(TASK_PREFIX);
    const stored = (await mapLimit(keys, LOAD_CONCURRENCY, async (k) => {
      const [clientId, jobId] = k.slice(TASK_PREFIX.length).split("/");
      return clientId === undefined || jobId === undefined ? null : load(clientId, jobId);
    })).filter((r): r is TaskRecord => r !== null).sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
    // Read live states for the unfinished ones (oldest first, within the time budget).
    const open = stored.filter((r) => !TERMINAL.has(r.view.status)).slice(0, 100);
    const live = new Map((await refreshPage(open)).map((r) => [`${r.clientId}/${r.jobId}`, r]));
    const rows = stored
      .map((r) => live.get(`${r.clientId}/${r.jobId}`) ?? r)
      .filter((r) => want === "all" || r.view.status === want)
      .map((r) => ({
        clientId: r.clientId, jobReference: r.jobId, title: r.view.title, status: r.view.status, state: STATE[r.view.status] ?? "TASK_STATE_UNSPECIFIED",
        createdAt: r.createdAt, changedAt: r.changedAt, ...(r.stale === true ? { stale: true, lastConfirmedAt: r.confirmedAt ?? r.changedAt } : {}),
        invited: r.view.invited, bids: r.view.submitted, claimLink: `${fieldproof.base}/#/jobs/claim/${r.jobId}`, clientSees: statusText(r),
      }));
    console.log(`fieldwork-a2a: operator queue read by ${operator} (${rows.length} ${want})`);
    return reply(200, { operator, generatedAt: now().toISOString(), state: want, count: rows.length, tasks: rows });
  };
}
