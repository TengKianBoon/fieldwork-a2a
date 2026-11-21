// The Fieldwork A2A endpoint: another company's agent drafts a field job and
// follows it as an A2A task. It can never publish, choose, accept or cancel:
// 180Climate's people do, and nothing a client sees lets it do so.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createA2AHandler, createOperatorHandler, parseClients, retryKey, MAX_MESSAGE_ID, type Limits } from "../src/protocol.mts";
import { fieldProofClient, fieldProofBaseOk, type JobView } from "../src/fieldproof.mts";
import { MemoryKV } from "../src/store.mts";
import { FakeFieldProof } from "./fake-fieldproof.ts";

type J = Record<string, any>;
const CODE = "good-code";
const KEY_A = "fwk_client-a-test-key";
const KEY_B = "fwk_client-b-test-key";
const sha = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

function setup(opts: { code?: string; clients?: Map<string, string>; limits?: Limits; fp?: FakeFieldProof; refreshBudgetMs?: number } = {}) {
  const fp = opts.fp ?? new FakeFieldProof(CODE);
  const kv = new MemoryKV();
  const clock = { t: Date.parse("2026-11-21T00:00:00Z") };
  const clients = opts.clients ?? new Map([[sha(KEY_A), "client-a"], [sha(KEY_B), "client-b"]]);
  const handle = createA2AHandler({
    kv, fieldproof: fp, clients, fieldproofCode: opts.code ?? CODE, now: () => new Date((clock.t += 1000)),
    limits: opts.limits ?? { perDay: 10_000, total: 10_000 }, refreshBudgetMs: opts.refreshBudgetMs,
  });
  let n = 0;
  async function rpc(method: string, params: unknown, headers: Record<string, string> = {}): Promise<{ http: number; body: J; res: Response }> {
    n += 1;
    const res = await handle(new Request("https://a2a.example/a2a", {
      method: "POST",
      headers: { "content-type": "application/json", "a2a-version": "1.0", "x-fieldwork-key": KEY_A, ...headers },
      body: JSON.stringify({ jsonrpc: "2.0", id: n, method, params }),
    }));
    return { http: res.status, body: (await res.clone().json()) as J, res };
  }
  return { fp, kv, rpc, handle, clock };
}

const job = {
  title: "Sample-bag tag check", outcome: "Photograph each sample bag tag.", region: "Riau, Sumatra",
  window_start: "2030-11-10", window_end: "2030-11-12", budget_min: 50, budget_max: 100, currency: "usd",
  bid_deadline: "2030-11-05T18:00:00+08:00", site: "Sample store A", items: ["b12", "B17"],
  check_deadline: "2030-11-20T18:00:00+08:00",
};
const msg = (parts: unknown[], extra: J = {}): J => ({ message: { messageId: `msg-${Math.random()}`, role: "ROLE_USER", parts, ...extra } });
const draft = async (rpc: ReturnType<typeof setup>["rpc"], extra: J = {}, data: J = job, headers: Record<string, string> = {}): Promise<string> =>
  (await rpc("SendMessage", msg([{ data }], extra), headers)).body.result.task.id as string;

// Nothing a client receives may let it claim, publish or act as 180Climate.
const FORBIDDEN = ["claim", "access code", "fieldproof.example", "agent-", "oken", "requester"];
function assertClean(where: string, body: unknown): void {
  const s = JSON.stringify(body).toLowerCase();
  for (const f of FORBIDDEN) assert.ok(!s.includes(f), `${where} must not contain "${f}"`);
}

describe("access", () => {
  it("answers 401 with a challenge for a missing or unknown client key, and says nothing about tasks", async () => {
    const { rpc } = setup();
    const none = await rpc("ListTasks", {}, { "x-fieldwork-key": "" });
    assert.equal(none.http, 401);
    assert.equal(none.body.error.code, -32000);
    assert.match(none.body.error.message, /X-Fieldwork-Key/);
    assert.equal(none.res.headers.get("www-authenticate"), "ApiKey header=\"X-Fieldwork-Key\"");
    const wrong = await rpc("GetTask", { id: "j_x" }, { "x-fieldwork-key": "fwk_not-a-client" });
    assert.equal(wrong.http, 401);
    assert.equal(wrong.body.error.data[0].reason, "UNAUTHENTICATED");
    // FieldProof's own requester code is not a client key here.
    assert.equal((await rpc("ListTasks", {}, { "x-fieldwork-key": CODE })).http, 401);
    assert.equal((await rpc("ListTasks", {}, { "x-fieldwork-key": "", "x-requester-code": CODE })).http, 401);
  });

  it("answers an unknown caller 401 before reading the request, even when it is malformed", async () => {
    const { handle } = setup();
    for (const body of ["{nope", JSON.stringify({ method: "GetTask" }), "[]"]) {
      const res = await handle(new Request("https://a2a.example/a2a", { method: "POST", body }));
      assert.equal(res.status, 401, body);
    }
  });

  it("answers 503 until it is configured, and when FieldProof refuses 180Climate's code", async () => {
    assert.equal((await setup({ clients: new Map() }).rpc("ListTasks", {})).http, 503);
    assert.equal((await setup({ code: "" }).rpc("ListTasks", {})).http, 503);
    const r = await setup({ code: "stale-code" }).rpc("SendMessage", msg([{ data: job }]));
    assert.equal(r.http, 503);
    assert.equal(r.body.error.code, -32603);
  });

  it("says so when FieldProof cannot be reached", async () => {
    const { fp, rpc } = setup();
    fp.down = true;
    const r = await rpc("SendMessage", msg([{ data: job }]));
    assert.equal(r.http, 503);
    assert.equal(r.body.error.code, -32603);
  });

  it("marks every answer not to be cached", async () => {
    const { rpc, handle } = setup();
    assert.equal((await rpc("ListTasks", {})).res.headers.get("cache-control"), "no-store");
    assert.equal((await rpc("ListTasks", {}, { "x-fieldwork-key": "" })).res.headers.get("cache-control"), "no-store");
    assert.equal((await handle(new Request("https://a2a.example/a2a"))).headers.get("cache-control"), "no-store");
  });

  it("reads client hashes in either case and counts malformed entries", () => {
    let ignored = 0;
    const m = parseClients(JSON.stringify({ [sha(KEY_A).toUpperCase()]: "client-a", "not-a-hash": "client-b", [sha(KEY_B)]: "Bad Id" }), (n) => (ignored = n));
    assert.equal(m.get(sha(KEY_A)), "client-a");
    assert.equal(m.size, 1);
    assert.equal(ignored, 2);
    assert.throws(() => parseClients("[1]"));
  });
});

describe("client isolation (release check)", () => {
  it("lets each client see only its own tasks, in every method", async () => {
    const { fp, rpc } = setup();
    const B = { "x-fieldwork-key": KEY_B };
    const a = (await rpc("SendMessage", msg([{ data: { ...job, title: "Client A job" } }], { contextId: "ctx-a" }))).body.result.task;
    const b = (await rpc("SendMessage", msg([{ data: { ...job, title: "Client B job" } }], { contextId: "ctx-b" }), B)).body.result.task;
    assert.equal((await rpc("GetTask", { id: a.id })).body.result.id, a.id);
    assert.equal((await rpc("GetTask", { id: b.id }, B)).body.result.id, b.id);
    for (const [who, other, headers] of [["A", b, {}], ["B", a, B]] as Array<[string, J, Record<string, string>]>) {
      const got = await rpc("GetTask", { id: other.id }, headers);
      assert.equal(got.body.error.code, -32001, `${who} GetTask`);
      assert.equal(got.body.error.data[0].reason, "TASK_NOT_FOUND");
      assert.equal((await rpc("CancelTask", { id: other.id }, headers)).body.error.code, -32001, `${who} CancelTask`);
      assert.equal((await rpc("SendMessage", msg([{ data: job }], { taskId: other.id }), headers)).body.error.code, -32001, `${who} task-bound SendMessage`);
      const list = (await rpc("ListTasks", { includeArtifacts: true }, headers)).body.result;
      assert.equal(list.totalSize, 1, `${who} ListTasks`);
      assert.ok(!JSON.stringify(list).includes(other.id), `${who} sees no id of the other`);
      assert.ok(!JSON.stringify(list).includes(who === "A" ? "Client B job" : "Client A job"), `${who} sees no title of the other`);
    }
    const same = { messageId: "shared-message-id", role: "ROLE_USER" };
    const ra = await rpc("SendMessage", { message: { ...same, parts: [{ data: { ...job, title: "A again" } }] } });
    const rb = await rpc("SendMessage", { message: { ...same, parts: [{ data: { ...job, title: "B again" } }] } }, B);
    assert.ok(ra.body.result.task.id !== rb.body.result.task.id);
    assert.equal(fp.jobs.size, 4);
  });

  it("keeps look-alike client ids apart (client-a, client-ab, client-a-)", async () => {
    const keys = { "client-a": "k-a", "client-ab": "k-ab", "client-a-": "k-a-dash" } as Record<string, string>;
    const clients = new Map(Object.entries(keys).map(([id, k]) => [sha(k), id]));
    const { rpc } = setup({ clients });
    const ids: Record<string, string> = {};
    for (const [id, k] of Object.entries(keys)) ids[id] = await draft(rpc, {}, { ...job, title: `Job of ${id}` }, { "x-fieldwork-key": k });
    for (const [id, k] of Object.entries(keys)) {
      const h = { "x-fieldwork-key": k };
      const list = (await rpc("ListTasks", { includeArtifacts: true }, h)).body.result;
      assert.deepEqual(list.tasks.map((t: J) => t.id), [ids[id]], `${id} lists only its own task`);
      for (const [other, otherId] of Object.entries(ids)) {
        if (other !== id) assert.equal((await rpc("GetTask", { id: otherId }, h)).body.error.code, -32001, `${id} cannot read ${other}`);
      }
    }
  });

  it("refuses a task id that tries to step outside the client's space", async () => {
    const { rpc } = setup();
    for (const id of ["../client-b/j_x", "..", "%2e%2e", "a\\b", "client-b/j_x"]) {
      assert.equal((await rpc("GetTask", { id })).body.error.code, -32001, id);
    }
  });
});

describe("SendMessage", () => {
  it("drafts the job in FieldProof and returns a SUBMITTED task that names 180Climate, with no claim link or codes", async () => {
    const { fp, rpc } = setup();
    const params = msg([{ data: job, mediaType: "application/json" }], { contextId: "ctx-1" });
    const r = await rpc("SendMessage", params);
    const task = r.body.result.task;
    assert.equal(r.http, 200);
    assert.equal(task.status.state, "TASK_STATE_SUBMITTED");
    assert.equal(task.contextId, "ctx-1");
    assert.equal(task.status.message.role, "ROLE_AGENT");
    const words = task.status.message.parts[0].text as string;
    assert.match(words, /180Climate person reviews it, publishes it/);
    assert.match(words, new RegExp(`job reference ${task.id}`));
    assert.match(words, /180climate\.net\/contact\/fieldwork/);
    assert.equal(task.artifacts[0].parts[0].data.status, "draft");
    assert.equal(fp.jobs.size, 1);
    assertClean("SendMessage", r.body);
    for (const code of ["B12", "B17"]) assert.ok(!JSON.stringify(r.body).includes(code), code);
    // A retry of the same message converges on the same task; reusing the id for another job is refused.
    assert.equal((await rpc("SendMessage", params)).body.result.task.id, task.id);
    assert.equal(fp.jobs.size, 1);
    const reused = await rpc("SendMessage", { message: { ...params.message, parts: [{ data: { ...job, title: "Other" } }] } });
    assert.equal(reused.body.error.code, -32602);
  });

  it("sends FieldProof only the named job fields, with createdBy and the retry key fixed by this service", async () => {
    const { fp, rpc } = setup();
    const hostile = JSON.parse(JSON.stringify({ ...job, createdBy: "owner", idempotencyKey: "steal-me", ownerToken: "x", requesterCode: "y", evil: 1 }).replace("{", "{\"__proto__\":{\"createdBy\":\"owner\"},")) as J;
    const r = await rpc("SendMessage", { message: { messageId: "m-hostile", role: "ROLE_USER", parts: [{ data: hostile }] } });
    assert.equal(r.body.result.task.status.state, "TASK_STATE_SUBMITTED");
    const sent = fp.bodies[fp.bodies.length - 1];
    assert.deepEqual(Object.keys(sent).sort(), ["bidDeadline", "budget", "checkDeadline", "createdBy", "idempotencyKey", "items", "outcome", "region", "siteLabel", "title", "windowEnd", "windowStart"]);
    assert.equal(sent.createdBy, "agent");
    assert.equal(sent.idempotencyKey, "a2a:client-a:m-hostile");
    assert.equal(Object.getPrototypeOf(sent), Object.prototype);
  });

  it("keeps the retry key within FieldProof's 128 characters at the longest client id and message id", async () => {
    const longId = "c".repeat(32);
    const { fp, rpc } = setup({ clients: new Map([[sha(KEY_A), longId]]) });
    const mid = "m".repeat(MAX_MESSAGE_ID);
    assert.equal(retryKey(longId, mid).length, 117);
    const r = await rpc("SendMessage", { message: { messageId: mid, role: "ROLE_USER", parts: [{ data: job }] } });
    assert.equal(r.body.result.task.status.state, "TASK_STATE_SUBMITTED");
    assert.ok(String(fp.bodies[0].idempotencyKey).length <= 128);
    assert.equal((await rpc("SendMessage", { message: { messageId: `${mid}x`, role: "ROLE_USER", parts: [{ data: job }] } })).body.error.code, -32602);
  });

  it("takes the documented camelCase names and the snake_case aliases alike", async () => {
    const { fp, rpc } = setup();
    const camel = {
      title: "Camel job", outcome: "Photograph each sample bag tag.", region: "Riau, Sumatra", windowStart: "2030-11-10", windowEnd: "2030-11-12",
      budgetMin: 50, budgetMax: 100, currency: "USD", bidDeadline: "2030-11-05T18:00:00+08:00", site: "Store", items: ["B12"],
      checkDeadline: "2030-11-20T18:00:00+08:00", photoTips: ["Fill the frame"],
    };
    assert.equal((await rpc("SendMessage", msg([{ data: camel }]))).body.result.task.status.state, "TASK_STATE_SUBMITTED");
    assert.equal((await rpc("SendMessage", msg([{ data: job }]))).body.result.task.status.state, "TASK_STATE_SUBMITTED");
    assert.equal(fp.jobs.size, 2);
  });

  it("takes the job as a JSON text part, and answers plain words with the format", async () => {
    const { rpc } = setup();
    assert.equal((await rpc("SendMessage", msg([{ text: JSON.stringify(job) }]))).body.result.task.status.state, "TASK_STATE_SUBMITTED");
    const words = (await rpc("SendMessage", msg([{ text: "Can someone check our sample bags?" }]))).body.result.message;
    assert.equal(words.role, "ROLE_AGENT");
    assert.match(words.parts[0].text, /windowStart/);
    assert.equal(typeof words.parts[1].data.example.title, "string");
  });

  it("explains a job FieldProof refuses, in this agent's field names, and saves nothing", async () => {
    const { fp, rpc } = setup();
    const missing = (await rpc("SendMessage", msg([{ data: { title: "Only a title" } }]))).body.result.message;
    assert.ok(missing.parts[1].data.missing.includes("site"));
    const leak = (await rpc("SendMessage", msg([{ data: { ...job, outcome: "Start with B12." } }]))).body.result.message;
    assert.equal(leak.parts[1].data.error, "job_leaks_code");
    assert.equal(leak.parts[1].data.field, "outcome");
    assert.match(leak.parts[0].text, /Nothing was saved/);
    const site = (await rpc("SendMessage", msg([{ data: { ...job, site: "Store B17" } }]))).body.result.message;
    assert.equal(site.parts[1].data.field, "site", "FieldProof's siteLabel is this agent's site");
    assert.match(site.parts[0].text, /The site text mentions/);
    assert.equal((await rpc("SendMessage", msg([{ data: { ...job, outcome: "Mail me at a@b.co" } }]))).body.result.message.parts[1].data.error, "contact_details_not_allowed");
    assert.equal(fp.jobs.size, 0);
    assert.equal((await rpc("ListTasks", {})).body.result.totalSize, 0);
  });

  it("treats any other FieldProof answer as a service problem, without passing FieldProof's words on", async () => {
    const { fp, rpc } = setup();
    for (const n of [{ status: 404, error: "unexpected" }, { status: 429, error: "rate_limited" }, { status: 401, error: "who_are_you" }, { status: 405, error: "method" }, { status: 400, error: "new_rule_we_do_not_know" }]) {
      fp.nextCreate = n;
      const r = await rpc("SendMessage", msg([{ data: job }]));
      assert.equal(r.http, 503, JSON.stringify(n));
      assert.equal(r.body.error.code, -32603);
      assert.ok(!JSON.stringify(r.body).includes(n.error), `${n.error} is not passed on`);
    }
    assert.equal((await rpc("ListTasks", {})).body.result.totalSize, 0);
  });

  it("uses the A2A error codes for what it does not do", async () => {
    const { rpc } = setup();
    assert.equal((await rpc("SendMessage", { message: { role: "ROLE_USER", parts: [{ text: "x" }] } })).body.error.code, -32602);
    assert.equal((await rpc("SendMessage", msg([{ url: "https://x.example/a.pdf", mediaType: "application/pdf" }]))).body.error.code, -32005);
    assert.equal((await rpc("SendMessage", msg([{ data: job }], { taskId: "j_unknown" }))).body.error.code, -32001);
    assert.equal((await rpc("SendMessage", { ...msg([{ data: job }]), configuration: { taskPushNotificationConfig: { url: "https://x.example/h" } } })).body.error.code, -32003);
    assert.equal((await rpc("SendMessage", { ...msg([{ data: job }]), configuration: { taskPushNotificationConfig: null } })).body.result.task.status.state, "TASK_STATE_SUBMITTED", "a null push config means none");
    assert.equal((await rpc("SendStreamingMessage", msg([{ data: job }]))).body.error.code, -32004);
    assert.equal((await rpc("SubscribeToTask", { id: "j_x" })).body.error.code, -32004);
    assert.equal((await rpc("ListTaskPushNotificationConfigs", {})).body.error.code, -32003);
    assert.equal((await rpc("GetExtendedAgentCard", {})).body.error.code, -32004);
    assert.equal((await rpc("message/send", {})).body.error.code, -32601);
    const old = await rpc("GetTask", { id: "j_x" }, { "a2a-version": "" });
    assert.equal(old.body.error.code, -32009, "an empty A2A-Version means 0.3");
    assert.equal(old.body.error.data[0]["@type"], "type.googleapis.com/google.rpc.ErrorInfo");
    assert.equal(old.body.error.data[0].reason, "VERSION_NOT_SUPPORTED");
  });

  it("accepts A2A-Version 1.0 and 1.0.x only", async () => {
    const { rpc } = setup();
    for (const v of ["1.0", "1.0.0", " 1.0 "]) assert.equal((await rpc("ListTasks", {}, { "a2a-version": v })).body.result.totalSize, 0, v);
    for (const v of ["1.0abc", "1.0, 1.0", "1.0.0.0", "2.0", "0.3", "1", "1.1"]) assert.equal((await rpc("ListTasks", {}, { "a2a-version": v })).body.error.code, -32009, v);
  });

  it("answers malformed requests per JSON-RPC", async () => {
    const { handle } = setup();
    const send = async (body: string) => (await (await handle(new Request("https://a2a.example/a2a", { method: "POST", body, headers: { "x-fieldwork-key": KEY_A } }))).json()) as J;
    assert.equal((await send("{nope")).error.code, -32700);
    assert.equal((await send(JSON.stringify({ method: "GetTask" }))).error.code, -32600);
    assert.equal((await handle(new Request("https://a2a.example/a2a"))).status, 405);
  });
});

describe("pilot limits", () => {
  it("caps new jobs per client per UTC day (429, Retry-After) and in total; a retried message does not count", async () => {
    const { rpc, clock, fp } = setup({ limits: { perDay: 2, total: 3 } });
    const first = msg([{ data: job }]);
    await rpc("SendMessage", first);
    assert.equal((await rpc("SendMessage", first)).body.result.task.status.state, "TASK_STATE_SUBMITTED", "a retry");
    await draft(rpc, {}, { ...job, title: "Second" });
    const over = await rpc("SendMessage", msg([{ data: { ...job, title: "Third" } }]));
    assert.equal(over.http, 429);
    assert.equal(over.body.error.code, -32000);
    assert.equal(over.body.error.data[0].reason, "RESOURCE_EXHAUSTED");
    assert.ok(Number(over.res.headers.get("retry-after")) > 0);
    assert.equal(fp.jobs.size, 2, "nothing was drafted in FieldProof");
    // Client B has its own allowance.
    assert.equal((await rpc("SendMessage", msg([{ data: job }]), { "x-fieldwork-key": KEY_B })).http, 200);
    clock.t += 24 * 3600 * 1000;
    await draft(rpc, {}, { ...job, title: "Next day" });
    const total = await rpc("SendMessage", msg([{ data: { ...job, title: "Over the total" } }]));
    assert.equal(total.http, 429);
    assert.match(total.body.error.message, /pilot limit of 3 jobs/);
  });
});

describe("pilot limits under pressure", () => {
  it("holds the daily limit against parallel requests", async () => {
    const { rpc, fp } = setup({ limits: { perDay: 2, total: 100 } });
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => rpc("SendMessage", msg([{ data: { ...job, title: `Burst ${i}` } }]))));
    assert.equal(results.filter((r) => r.http === 200).length, 2);
    assert.equal(results.filter((r) => r.http === 429).length, 4);
    assert.equal(fp.jobs.size, 2, "only two drafts reached FieldProof");
  });

  it("answers a retry of the last allowed job with its task, not 429", async () => {
    const { rpc, fp } = setup({ limits: { perDay: 1, total: 100 } });
    const m = msg([{ data: job }]);
    const id = (await rpc("SendMessage", m)).body.result.task.id;
    const again = await rpc("SendMessage", m);
    assert.equal(again.http, 200);
    assert.equal(again.body.result.task.id, id);
    assert.equal(fp.jobs.size, 1);
    const other = await rpc("SendMessage", { message: { ...m.message, parts: [{ data: { ...job, title: "Different" } }] } });
    assert.equal(other.body.error.code, -32602, "the same message id with a different job is refused");
  });

  it("reuses a slot given back out of order", async () => {
    class SlowOnce extends FakeFieldProof {
      gate: Promise<void> | null = null;
      override async createJob(code: string, body: Record<string, unknown>) {
        if (this.gate !== null) {
          const g = this.gate;
          this.gate = null;
          await g;
          return { ok: false as const, status: 0, error: "unreachable" };
        }
        return super.createJob(code, body);
      }
    }
    const fp = new SlowOnce(CODE);
    let open!: () => void;
    fp.gate = new Promise<void>((r) => (open = r));
    const { rpc } = setup({ fp, limits: { perDay: 2, total: 100 } });
    const slow = rpc("SendMessage", msg([{ data: { ...job, title: "Slow, then fails" } }]));
    await new Promise((r) => setTimeout(r, 10));
    assert.equal((await rpc("SendMessage", msg([{ data: { ...job, title: "Second" } }]))).http, 200);
    open();
    assert.equal((await slow).http, 503);
    assert.equal((await rpc("SendMessage", msg([{ data: { ...job, title: "Third" } }]))).http, 200, "the slot given back is used again");
    assert.equal((await rpc("SendMessage", msg([{ data: { ...job, title: "Fourth" } }]))).http, 429);
  });

  it("gives the slot back when FieldProof refuses the job or cannot be reached", async () => {
    const { rpc, fp } = setup({ limits: { perDay: 1, total: 100 } });
    assert.equal((await rpc("SendMessage", msg([{ data: { ...job, outcome: "Start with B12." } }]))).body.result.message.parts[1].data.error, "job_leaks_code");
    fp.down = true;
    assert.equal((await rpc("SendMessage", msg([{ data: job }]))).http, 503);
    fp.down = false;
    assert.equal((await rpc("SendMessage", msg([{ data: job }]))).http, 200, "the one daily slot is still free");
  });
});

describe("the 180Climate operator queue", () => {
  const OPS_KEY = "fwo_operator-test-key";
  function opsSetup(operators = new Map([[sha(OPS_KEY), "ops-180climate"]])) {
    const base = setup({ clients: new Map([[sha(KEY_A), "client-a"], [sha(KEY_B), "client-b"], [sha("k-ab"), "client-ab"]]) });
    const ops = createOperatorHandler({ kv: base.kv, fieldproof: base.fp, clients: new Map(), operators, fieldproofCode: CODE });
    const get = async (query = "", headers: Record<string, string> = { "x-fieldwork-operator-key": OPS_KEY }, method = "GET") => {
      const res = await ops(new Request(`https://a2a.example/ops/queue${query}`, { method, headers }));
      return { http: res.status, body: (await res.json()) as J, res };
    };
    return { ...base, get };
  }

  it("refuses every key but an operator key, and is never cached", async () => {
    const { get } = opsSetup();
    assert.equal((await get("", {})).http, 401);
    assert.equal((await get("", { "x-fieldwork-operator-key": KEY_A })).http, 401, "a client key");
    assert.equal((await get("", { "x-fieldwork-key": OPS_KEY })).http, 401, "an operator key in the client header");
    assert.equal((await get("", { "x-fieldwork-operator-key": CODE })).http, 401, "FieldProof's code");
    const ok = await get();
    assert.equal(ok.http, 200);
    assert.equal(ok.res.headers.get("cache-control"), "no-store");
    assert.equal((await get("", undefined, "POST")).http, 405);
    assert.equal((await get("?state=everything")).http, 400);
    assert.equal((await opsSetup(new Map()).get()).http, 503, "not configured");
  });

  it("an operator key opens nothing on /a2a", async () => {
    const { rpc } = opsSetup();
    assert.equal((await rpc("ListTasks", {}, { "x-fieldwork-key": OPS_KEY })).http, 401);
  });

  it("lists drafts from every client, oldest first, with the claim link and no secrets or item codes", async () => {
    const { rpc, get, fp } = opsSetup();
    const a = await draft(rpc, {}, { ...job, title: "From A" });
    const ab = await draft(rpc, {}, { ...job, title: "From AB" }, { "x-fieldwork-key": "k-ab" });
    const b = await draft(rpc, {}, { ...job, title: "From B" }, { "x-fieldwork-key": KEY_B });
    fp.set(b, { status: "open" });
    const q = (await get()).body;
    assert.deepEqual(q.tasks.map((t: J) => t.jobReference), [a, ab], "drafts only, oldest first; B's job is already open");
    assert.deepEqual(q.tasks.map((t: J) => t.clientId), ["client-a", "client-ab"]);
    assert.equal(q.tasks[0].claimLink, `${fp.base}/#/jobs/claim/${a}`);
    assert.match(q.tasks[0].clientSees, /180Climate person reviews it/);
    const text = JSON.stringify(q);
    for (const secret of ["agent-", "agentToken", "request", "B12", "B17", "expectedLabel", CODE]) assert.ok(!text.includes(secret), secret);
    assert.deepEqual((await get("?state=open")).body.tasks.map((t: J) => t.jobReference), [b]);
    assert.equal((await get("?state=all")).body.count, 3);
  });
});

describe("the task follows the job, and only people move it", () => {
  it("goes SUBMITTED -> WORKING -> COMPLETED as 180Climate publishes and a professional accepts", async () => {
    const { fp, rpc } = setup();
    const id = await draft(rpc, { contextId: "ctx-life" });
    const cancel = await rpc("CancelTask", { id });
    assert.equal(cancel.body.error.code, -32002, "the agent cannot cancel");
    assert.match(cancel.body.error.message, /Only 180Climate can cancel/);
    fp.set(id, { status: "open", invited: 2, submitted: 1 });
    const open = (await rpc("GetTask", { id })).body.result;
    assert.equal(open.status.state, "TASK_STATE_WORKING");
    assert.match(open.status.message.parts[0].text, /2 professional\(s\) invited, 1 bid\(s\) received\./);
    const bound = await rpc("SendMessage", msg([{ data: job }], { taskId: id }));
    assert.equal(bound.body.error.code, -32004);
    assertClean("task-bound SendMessage", bound.body);
    fp.set(id, { status: "accepted", engaged: true, missionId: "m_abc" });
    const done = (await rpc("GetTask", { id })).body.result;
    assert.equal(done.status.state, "TASK_STATE_COMPLETED");
    assert.equal(done.artifacts[0].parts[0].data.missionId, "m_abc");
    assert.ok(done.status.timestamp > open.status.timestamp, "the timestamp moves when the state moves");
    assert.equal((await rpc("SendMessage", msg([{ data: job }], { taskId: id }))).body.error.code, -32004);
    assert.equal((await rpc("CancelTask", { id })).body.error.code, -32002, "a finished task cannot be canceled");
    assertClean("GetTask (accepted)", done);
    assertClean("ListTasks (accepted)", (await rpc("ListTasks", { includeArtifacts: true })).body.result.tasks);
  });

  it("does not move the timestamp for a reworded title, only for a state change", async () => {
    const { fp, rpc } = setup();
    const id = await draft(rpc);
    const a = (await rpc("GetTask", { id })).body.result.status.timestamp;
    fp.set(id, { title: "Reworded" });
    const b = (await rpc("GetTask", { id })).body.result;
    assert.equal(b.status.timestamp, a);
    assert.equal(b.artifacts[0].parts[0].data.title, "Reworded");
  });

  it("says when bidding has closed and a choice is being made", async () => {
    const { fp, rpc } = setup();
    const id = await draft(rpc);
    fp.set(id, { status: "open", invited: 3, submitted: 2, bidDeadline: "2026-11-01T10:00:00.000Z" });
    assert.match((await rpc("GetTask", { id })).body.result.status.message.parts[0].text, /bidding closed at 2026-11-01T10:00:00.000Z/);
  });

  it("keeps the last known state when FieldProof is briefly unreachable", async () => {
    const { fp, rpc } = setup();
    const id = await draft(rpc);
    fp.set(id, { status: "open" });
    await rpc("GetTask", { id });
    fp.down = true;
    const r = (await rpc("GetTask", { id })).body.result;
    assert.equal(r.status.state, "TASK_STATE_WORKING");
    assert.equal(r.artifacts[0].parts[0].data.stale, undefined, "a brief outage is not flagged");
  });

  it("renews the 14-day agent link by itself, and keeps following the job", async () => {
    const { fp, rpc } = setup();
    const id = await draft(rpc);
    fp.set(id, { status: "open", invited: 1 });
    fp.expire(id);
    const before = fp.createCalls;
    const r = (await rpc("GetTask", { id })).body.result;
    assert.equal(r.status.state, "TASK_STATE_WORKING");
    assert.equal(fp.createCalls, before + 1, "one renewal through job-create");
    assert.equal(fp.jobs.size, 1, "the same job, not a new one");
    fp.set(id, { invited: 3 });
    assert.match((await rpc("GetTask", { id })).body.result.status.message.parts[0].text, /3 professional/);
    assert.equal(fp.createCalls, before + 1, "the renewed link is kept");
  });

  it("says plainly when the live state cannot be read, and clears that once it can", async () => {
    const { fp, rpc } = setup();
    const id = await draft(rpc);
    fp.set(id, { status: "open" });
    await rpc("GetTask", { id });
    fp.expire(id);
    fp.codeRevoked = true;
    const r = (await rpc("GetTask", { id })).body.result;
    assert.equal(r.status.state, "TASK_STATE_WORKING");
    assert.equal(r.artifacts[0].parts[0].data.stale, true);
    assert.equal(typeof r.artifacts[0].parts[0].data.lastConfirmedAt, "string");
    assert.match(r.status.message.parts[0].text, /live status could not be read/);
    fp.codeRevoked = false;
    const back = (await rpc("GetTask", { id })).body.result;
    assert.equal(back.artifacts[0].parts[0].data.stale, undefined);
  });

  it("a retried message still follows its job after the agent link expired", async () => {
    const { fp, rpc } = setup();
    const m = msg([{ data: job }]);
    const id = (await rpc("SendMessage", m)).body.result.task.id as string;
    fp.expire(id);
    await rpc("SendMessage", m);
    const calls = fp.createCalls;
    assert.equal((await rpc("GetTask", { id })).body.result.status.state, "TASK_STATE_SUBMITTED");
    assert.equal(fp.createCalls, calls, "no renewal needed");
  });
});

describe("ListTasks", () => {
  it("lists tasks newest first, filters them and pages with an opaque cursor", async () => {
    const { fp, rpc } = setup();
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push(await draft(rpc, { contextId: "ctx-page" }, { ...job, title: `Job ${i}` }));
    await draft(rpc, { contextId: "ctx-other" }, { ...job, title: "Elsewhere" });
    fp.set(ids[0], { status: "open" });
    await rpc("GetTask", { id: ids[0] });
    const first = (await rpc("ListTasks", { contextId: "ctx-page", pageSize: 2 })).body.result;
    assert.equal(first.totalSize, 3);
    assert.equal(first.pageSize, 2);
    assert.equal(first.tasks[0].id, ids[0], "the job that last changed is newest");
    assert.equal("artifacts" in first.tasks[0], false, "artifacts only when asked");
    const second = (await rpc("ListTasks", { contextId: "ctx-page", pageSize: 2, pageToken: first.nextPageToken })).body.result;
    assert.equal(second.tasks.length, 1);
    assert.equal(second.nextPageToken, "");
    assert.equal(new Set([...first.tasks, ...second.tasks].map((t: J) => t.id)).size, 3);
    assert.equal((await rpc("ListTasks", { status: "TASK_STATE_WORKING" })).body.result.totalSize, 1);
    assert.equal((await rpc("ListTasks", { status: 2 })).body.result.totalSize, 1);
    assert.equal((await rpc("ListTasks", { includeArtifacts: true, pageSize: 1 })).body.result.tasks[0].artifacts.length, 1);
    const forged = Buffer.from(JSON.stringify({ t: "9999-01-01T00:00:00.000Z", id: "zzz" })).toString("base64url");
    assert.equal((await rpc("ListTasks", { pageToken: forged })).body.result.totalSize, 4, "a forged cursor only pages over the caller's own tasks");
    for (const bad of [{ pageSize: 0 }, { pageSize: 101 }, { pageToken: "not-ours" }, { pageToken: Buffer.from(JSON.stringify({ t: "soon", id: "x" })).toString("base64url") }, { status: "TASK_STATE_DONE" }, { statusTimestampAfter: "soon" }]) {
      assert.equal((await rpc("ListTasks", bad)).body.error.code, -32602, JSON.stringify(bad));
    }
  });

  it("reaches every task of a large client, newest included, and reads FieldProof only for the page", async () => {
    const { fp, rpc } = setup();
    const ids: string[] = [];
    for (let i = 0; i < 230; i++) ids.push(await draft(rpc, {}, { ...job, title: `Bulk ${i}` }));
    const calls = fp.statusCalls;
    const one = (await rpc("ListTasks", { pageSize: 1 })).body.result;
    assert.equal(one.totalSize, 230);
    assert.equal(one.tasks[0].id, ids[229], "the newest task is first");
    assert.ok(fp.statusCalls - calls <= 1, `one page of 1 reads FieldProof at most once (read ${fp.statusCalls - calls})`);
    const seen = new Set<string>();
    let token = "";
    do {
      const page = (await rpc("ListTasks", { pageSize: 100, pageToken: token })).body.result;
      for (const t of page.tasks) seen.add(t.id);
      token = page.nextPageToken;
    } while (token !== "");
    assert.equal(seen.size, 230);
  });

  it("does not read finished jobs again", async () => {
    const { fp, rpc } = setup();
    const id = await draft(rpc);
    fp.set(id, { status: "accepted", engaged: true, missionId: "m_1" });
    await rpc("GetTask", { id });
    const calls = fp.statusCalls;
    await rpc("ListTasks", {});
    await rpc("GetTask", { id });
    assert.equal(fp.statusCalls, calls);
  });

  it("answers within its time budget when FieldProof is slow, with the stored states", async () => {
    class SlowFieldProof extends FakeFieldProof {
      slow = false;
      override async jobStatus(jobId: string, token: string) {
        if (this.slow) await new Promise((r) => setTimeout(r, 400));
        return super.jobStatus(jobId, token);
      }
    }
    const fp = new SlowFieldProof(CODE);
    const { rpc } = setup({ fp, refreshBudgetMs: 60 });
    for (let i = 0; i < 20; i++) await draft(rpc, {}, { ...job, title: `Slow ${i}` });
    fp.slow = true;
    const t0 = performance.now();
    const r = (await rpc("ListTasks", { pageSize: 100 })).body.result;
    const ms = performance.now() - t0;
    assert.equal(r.tasks.length, 20);
    assert.ok(ms < 300, `answered in ${Math.round(ms)} ms`);
  });
});

describe("the FieldProof client", () => {
  const view = { jobId: "j_1", status: "accepted", title: "T", bidDeadline: "2030-01-01T00:00:00Z", invited: 1, submitted: 1, selectionPending: false, engaged: true, missionId: "m_1" };
  const stub = (status: number, body: unknown) => async (): Promise<Response> => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  it("keeps the job view limited: the check's requester link and any owner link are dropped", async () => {
    const fpc = fieldProofClient("https://fp.example", stub(200, { status: view, check: { missionId: "m_1", requesterToken: "SECRET-RT" } }));
    const s = await fpc.jobStatus("j_1", "t");
    assert.ok(s.ok);
    assert.ok(!JSON.stringify(s).includes("SECRET-RT"));
    const c = await fieldProofClient("https://fp.example", stub(200, { jobId: "j_1", agentToken: "AT", ownerToken: "SECRET-OT" })).createJob("code", {});
    assert.ok(!JSON.stringify(c).includes("SECRET-OT"));
  });

  it("calls FieldProof over https only (plain http only on this machine)", () => {
    assert.ok(fieldProofBaseOk("https://fieldproof-180climate.netlify.app"));
    assert.ok(fieldProofBaseOk("http://localhost:8888"));
    for (const bad of ["http://fieldproof-180climate.netlify.app", "ftp://x", "not a url", ""]) assert.ok(!fieldProofBaseOk(bad), bad);
    assert.throws(() => fieldProofClient("http://evil.example"));
  });

  it("reports a non-JSON or unexpected answer as an error, not a job", async () => {
    const r = await fieldProofClient("https://fp.example", async () => new Response("<html>", { status: 404 })).createJob("code", {});
    assert.deepEqual(r, { ok: false, status: 404, error: "unexpected" });
  });
});

describe("the Agent Card", () => {
  it("points at /a2a over JSON-RPC 1.0, declares the client key, names 180Climate's review, and its example is a job this endpoint takes", async () => {
    const card = JSON.parse(readFileSync(new URL("../public/.well-known/agent-card.json", import.meta.url), "utf8")) as J;
    assert.match(card.supportedInterfaces[0].url, /\/a2a$/);
    assert.equal(card.supportedInterfaces[0].protocolBinding, "JSONRPC");
    assert.equal(card.supportedInterfaces[0].protocolVersion, "1.0");
    assert.equal(card.capabilities.streaming, false);
    assert.equal(card.capabilities.pushNotifications, false);
    assert.equal(card.securitySchemes.fieldworkClientKey.apiKeySecurityScheme.name, "X-Fieldwork-Key");
    assert.deepEqual(Object.keys(card.securityRequirements[0].schemes), ["fieldworkClientKey"]);
    assert.match(card.description, /180Climate reviews/);
    assertClean("Agent Card", { d: card.description, s: card.skills });
    const { rpc } = setup();
    const r = await rpc("SendMessage", msg([{ data: JSON.parse(card.skills[0].examples[0]) }]));
    assert.equal(r.body.result.task.status.state, "TASK_STATE_SUBMITTED");
  });

  it("the human page says the same", () => {
    const page = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
    assert.match(page, /180Climate reviews/);
    assert.ok(!/claim|access code|client's side/i.test(page));
  });
});
