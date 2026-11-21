// Client for FieldProof's existing, live job system: the same two calls the
// FieldProof MCP tools already make. FieldProof itself is not changed.
//   draft a job             POST job-create (createdBy agent, idempotency key)
//   read a job's status     POST job-status with the read-only agent link
// The same job-create call with the same idempotency key and job returns the
// same job with a fresh agent link: that is how an expired link is renewed.

export interface JobView {
  jobId: string;
  status: string;
  title: string;
  bidDeadline: string;
  invited: number;
  submitted: number;
  selectionPending: boolean;
  engaged: boolean;
  missionId: string | null;
}

export type Created = { ok: true; jobId: string; agentToken: string } | { ok: false; status: number; error: string; field?: string };
export type Status = { ok: true; view: JobView } | { ok: false; status: number; error: string };

export interface FieldProof {
  base: string;
  createJob(code: string, body: Record<string, unknown>): Promise<Created>;
  jobStatus(jobId: string, agentToken: string): Promise<Status>;
}

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

// The requester code travels in a header, so FieldProof is only ever called
// over https (plain http only for a local test stack on this machine).
export function fieldProofBaseOk(base: string): boolean {
  try {
    const u = new URL(base);
    if (u.protocol === "https:") return true;
    return u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  } catch {
    return false;
  }
}

export function fieldProofClient(base: string, fetchFn: Fetch = fetch, timeoutMs = 4_000): FieldProof {
  if (!fieldProofBaseOk(base)) throw new Error("FieldProof URL must use https");
  const root = base.replace(/\/+$/, "");
  async function post(name: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: Record<string, unknown> } | null> {
    try {
      const r = await fetchFn(`${root}/.netlify/functions/${name}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
      let parsed: Record<string, unknown> = {};
      try {
        const j = (await r.json()) as unknown;
        if (typeof j === "object" && j !== null && !Array.isArray(j)) parsed = j as Record<string, unknown>;
      } catch {
        parsed = {};
      }
      return { status: r.status, body: parsed };
    } catch {
      return null;
    }
  }
  return {
    base: root,
    async createJob(code, body) {
      const r = await post("job-create", body, { "x-requester-code": code });
      if (r === null) return { ok: false, status: 0, error: "unreachable" };
      if (r.status === 200 && typeof r.body.jobId === "string" && typeof r.body.agentToken === "string") {
        return { ok: true, jobId: r.body.jobId, agentToken: r.body.agentToken };
      }
      return {
        ok: false,
        status: r.status,
        error: typeof r.body.error === "string" ? r.body.error : "unexpected",
        ...(typeof r.body.field === "string" ? { field: r.body.field } : {}),
      };
    },
    async jobStatus(jobId, agentToken) {
      const r = await post("job-status", { jobId, token: agentToken });
      if (r === null) return { ok: false, status: 0, error: "unreachable" };
      const v = r.body.status as Record<string, unknown> | undefined;
      if (r.status === 200 && typeof v === "object" && v !== null && typeof v.status === "string") {
        // Keep the documented counts-and-states view only. FieldProof also sends
        // a read-only link for an accepted job's check: it is dropped here.
        const view: JobView = {
          jobId: String(v.jobId), status: v.status, title: String(v.title ?? ""), bidDeadline: String(v.bidDeadline ?? ""),
          invited: Number(v.invited ?? 0), submitted: Number(v.submitted ?? 0),
          selectionPending: v.selectionPending === true, engaged: v.engaged === true,
          missionId: typeof v.missionId === "string" ? v.missionId : null,
        };
        return { ok: true, view };
      }
      return { ok: false, status: r.status, error: typeof r.body.error === "string" ? r.body.error : "unexpected" };
    },
  };
}
