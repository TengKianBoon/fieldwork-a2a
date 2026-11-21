// Netlify entry point for the 180Climate operator queue, served at /ops/queue.
// Settings (Netlify environment variables, set by 180Climate only):
//   FIELDWORK_OPERATOR_KEYS   {"<sha256 of operator key>": "<operator name>"}
//   plus the same FIELDPROOF_REQUESTER_CODE and FIELDPROOF_URL as /a2a
// Without FIELDWORK_OPERATOR_KEYS the queue answers 503 "not configured".
import { createOperatorHandler, parseClients } from "../../src/protocol.mts";
import { fieldProofBaseOk, fieldProofClient } from "../../src/fieldproof.mts";
import { blobsKV } from "../../src/store.mts";

const DEFAULT_FIELDPROOF = "https://fieldproof-180climate.netlify.app";

export default async function handler(req: Request): Promise<Response> {
  let operators = new Map<string, string>();
  try {
    operators = parseClients(process.env.FIELDWORK_OPERATOR_KEYS, (n) => console.warn(`fieldwork-a2a: ${n} FIELDWORK_OPERATOR_KEYS entries ignored`));
  } catch {
    console.warn("fieldwork-a2a: FIELDWORK_OPERATOR_KEYS is not a JSON object");
  }
  const base = process.env.FIELDPROOF_URL?.trim() || DEFAULT_FIELDPROOF;
  const baseOk = fieldProofBaseOk(base);
  let kv;
  try {
    kv = await blobsKV();
  } catch (e) {
    console.error(`fieldwork-a2a: storage unavailable: ${e instanceof Error ? `${e.name}: ${e.message}` : typeof e}`);
    return new Response(JSON.stringify({ error: "unavailable" }), { status: 503, headers: { "content-type": "application/json", "cache-control": "no-store" } });
  }
  return createOperatorHandler({
    kv, operators, clients: new Map(),
    fieldproof: fieldProofClient(baseOk ? base : DEFAULT_FIELDPROOF),
    fieldproofCode: baseOk ? (process.env.FIELDPROOF_REQUESTER_CODE ?? "").trim() : "",
  })(req);
}

export const config = { path: "/ops/queue" };
