// Storage for the A2A layer: one small record per task, one entry per
// message id (for retries) and one slot per job drafted each day (pilot limit).
// Production uses Netlify Blobs (strong consistency); tests use memory.
// Access codes are never stored. The FieldProof agent link stored per task
// is read-only (job status only) and is never returned to any caller.

export interface KV {
  get(key: string): Promise<string | null>;
  // Writes only if the key is new. True when this call wrote it.
  setIfAbsent(key: string, value: string): Promise<boolean>;
  set(key: string, value: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
  delete(key: string): Promise<void>;
}

export class MemoryKV implements KV {
  private m = new Map<string, string>();
  async get(key: string): Promise<string | null> {
    return this.m.get(key) ?? null;
  }
  async setIfAbsent(key: string, value: string): Promise<boolean> {
    if (this.m.has(key)) return false;
    this.m.set(key, value);
    return true;
  }
  async set(key: string, value: string): Promise<void> {
    this.m.set(key, value);
  }
  async list(prefix: string): Promise<string[]> {
    return [...this.m.keys()].filter((k) => k.startsWith(prefix));
  }
  async delete(key: string): Promise<void> {
    this.m.delete(key);
  }
}

interface BlobsStore {
  get(key: string, opts: { type: "text" }): Promise<string | null>;
  set(key: string, value: string, opts?: { onlyIfNew?: boolean }): Promise<{ modified: boolean }>;
  list(opts: { prefix: string }): Promise<{ blobs: Array<{ key: string }> }>;
  delete(key: string): Promise<void>;
}

export async function blobsKV(name = "fieldwork-a2a"): Promise<KV> {
  const { getStore } = await import("@netlify/blobs");
  const store = getStore({ name, consistency: "strong" }) as unknown as BlobsStore;
  return {
    get: (key) => store.get(key, { type: "text" }),
    async setIfAbsent(key, value) {
      return (await store.set(key, value, { onlyIfNew: true })).modified;
    },
    async set(key, value) {
      await store.set(key, value);
    },
    async list(prefix) {
      return (await store.list({ prefix })).blobs.map((b) => b.key);
    },
    async delete(key) {
      await store.delete(key);
    },
  };
}
