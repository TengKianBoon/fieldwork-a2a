// Netlify entry point for the Fieldwork A2A endpoint, served at /a2a.
// Settings (Netlify environment variables, set by 180Climate only):
//   FIELDWORK_A2A_CLIENTS     {"<sha256 of client key>": "<client id>"}
//   FIELDPROOF_REQUESTER_CODE 180Climate's FieldProof requester code
//   FIELDPROOF_URL            optional, default https://fieldproof-180climate.netlify.app (https only)
// Without the first two, every call answers 503 "not configured yet".
import { createA2AHandler, parseClients, serviceUnavailable } from "../../src/protocol.mts";
import { fieldProofBaseOk, fieldProofClient } from "../../src/fieldproof.mts";
import { blobsKV } from "../../src/store.mts";

const DEFAULT_FIELDPROOF = "https://fieldproof-180climate.netlify.app";

export default async function handler(req: Request): Promise<Response> {
  let clients = new Map<string, string>();
  try {
    clients = parseClients(process.env.FIELDWORK_A2A_CLIENTS, (n) => console.warn(`fieldwork-a2a: ${n} FIELDWORK_A2A_CLIENTS entr${n === 1 ? "y" : "ies"} ignored (hash or client id malformed)`));
  } catch {
    console.warn("fieldwork-a2a: FIELDWORK_A2A_CLIENTS is not a JSON object; no client is configured");
  }
  const base = process.env.FIELDPROOF_URL?.trim() || DEFAULT_FIELDPROOF;
  // The requester code is never sent to a FieldProof URL that is not https.
  const baseOk = fieldProofBaseOk(base);
  if (!baseOk) console.error("fieldwork-a2a: FIELDPROOF_URL must be an https URL; calls answer 'not configured'");
  let kv;
  try {
    kv = await blobsKV();
  } catch (e) {
    console.error(`fieldwork-a2a: storage unavailable: ${e instanceof Error ? `${e.name}: ${e.message}` : typeof e}`);
    return serviceUnavailable();
  }
  return createA2AHandler({
    kv,
    fieldproof: fieldProofClient(baseOk ? base : DEFAULT_FIELDPROOF),
    clients,
    fieldproofCode: baseOk ? (process.env.FIELDPROOF_REQUESTER_CODE ?? "").trim() : "",
  })(req);
}

// "/a2a/" too: some clients join "/" onto the interface URL.
export const config = { path: ["/a2a", "/a2a/"] };
