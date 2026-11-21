// Makes a new Fieldwork A2A client key. Run by 180Climate only.
//
//   node scripts/new-client-key.mjs <client-id>
//
// It prints two things:
//   1. the client key: give it to that client once, privately. It is not stored anywhere.
//   2. the line to add to the Netlify setting FIELDWORK_A2A_CLIENTS: only the key's
//      SHA-256 goes there, so the setting never holds a usable key.
import { createHash, randomBytes } from "node:crypto";

const id = process.argv[2] ?? "";
if (!/^[a-z0-9][a-z0-9-]{1,31}$/.test(id)) {
  console.error("Give a client id: 2-32 lower-case letters, digits or dashes, e.g. acme-eudr");
  process.exit(2);
}
const key = `fwk_${randomBytes(32).toString("base64url")}`;
const hash = createHash("sha256").update(key, "utf8").digest("hex");
console.log(`\nClient id:   ${id}`);
console.log(`Client key:  ${key}`);
console.log("\nAdd this entry to FIELDWORK_A2A_CLIENTS (a JSON object; keep the other entries):");
console.log(`  "${hash}": "${id}"\n`);
