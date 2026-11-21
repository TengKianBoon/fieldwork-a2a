// A small in-memory stand-in for FieldProof's job system, with the same
// answers the live endpoints give: codes, drafts, idempotency (the same key
// and job return the same job with a fresh agent link), 14-day link expiry
// and status. scripts/contract-test.mts checks this service's job format
// against FieldProof's real validation code.
import { createHash, randomUUID } from "node:crypto";
import type { Created, FieldProof, JobView, Status } from "../src/fieldproof.mts";

interface FakeJob { view: JobView; tokens: Set<string>; print: string }

export class FakeFieldProof implements FieldProof {
  base = "https://fieldproof.example";
  code: string;
  jobs = new Map<string, FakeJob>();
  idem = new Map<string, string>();
  down = false;
  // Every job-create body received, as FieldProof would see it.
  bodies: Array<Record<string, unknown>> = [];
  statusCalls = 0;
  createCalls = 0;
  // The next job-create answers this instead (once).
  nextCreate: { status: number; error: string; field?: string } | null = null;
  // job-create refuses everything with 403 (e.g. the requester code was rotated).
  codeRevoked = false;
  constructor(code = "good-code") {
    this.code = code;
  }
  async createJob(code: string, body: Record<string, unknown>): Promise<Created> {
    this.createCalls += 1;
    this.bodies.push(JSON.parse(JSON.stringify(body)) as Record<string, unknown>);
    if (this.down) return { ok: false, status: 0, error: "unreachable" };
    if (this.nextCreate !== null) {
      const n = this.nextCreate;
      this.nextCreate = null;
      return { ok: false, ...n };
    }
    if (code !== this.code || this.codeRevoked) return { ok: false, status: 403, error: "requester_code_denied" };
    const items = body.items as Array<{ expectedLabel: string }>;
    if (!Array.isArray(items) || items.length === 0 || items.some((i) => !/^[A-Z0-9]{1,20}$/.test(i.expectedLabel))) return { ok: false, status: 400, error: "bad_label" };
    if (String(body.outcome).includes("B12")) return { ok: false, status: 400, error: "job_leaks_code", field: "outcome" };
    if (String(body.siteLabel).includes("B17")) return { ok: false, status: 400, error: "job_leaks_code", field: "siteLabel" };
    if (/@|https?:\/\//.test(String(body.outcome))) return { ok: false, status: 400, error: "contact_details_not_allowed" };
    const key = body.idempotencyKey;
    if (typeof key !== "string" || key === "" || key.length > 128) return { ok: false, status: 400, error: "bad_input" };
    const { idempotencyKey: _k, ...rest } = body;
    const print = createHash("sha256").update(JSON.stringify(rest)).digest("hex");
    const token = `agent-${randomUUID()}`;
    const seen = this.idem.get(key);
    if (seen !== undefined) {
      const j = this.jobs.get(seen) as FakeJob;
      if (j.print !== print) return { ok: false, status: 409, error: "idempotency_conflict" };
      j.tokens.add(token);
      return { ok: true, jobId: seen, agentToken: token };
    }
    const jobId = `j_${randomUUID().replace(/-/g, "")}`;
    this.jobs.set(jobId, {
      tokens: new Set([token]), print,
      view: { jobId, status: "draft", title: String(body.title).trim(), bidDeadline: String(body.bidDeadline), invited: 0, submitted: 0, selectionPending: false, engaged: false, missionId: null },
    });
    this.idem.set(key, jobId);
    return { ok: true, jobId, agentToken: token };
  }
  async jobStatus(jobId: string, token: string): Promise<Status> {
    this.statusCalls += 1;
    if (this.down) return { ok: false, status: 0, error: "unreachable" };
    const j = this.jobs.get(jobId);
    if (j === undefined) return { ok: false, status: 404, error: "not_found" };
    if (!j.tokens.has(token)) return { ok: false, status: 403, error: "expired" };
    return { ok: true, view: { ...j.view } };
  }
  // What people do on the FieldProof website.
  set(jobId: string, change: Partial<JobView>): void {
    const j = this.jobs.get(jobId) as FakeJob;
    j.view = { ...j.view, ...change };
  }
  // Fourteen days pass: every agent link issued so far for this job expires.
  expire(jobId: string): void {
    (this.jobs.get(jobId) as FakeJob).tokens.clear();
  }
}
