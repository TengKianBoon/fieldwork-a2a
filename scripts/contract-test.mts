// Contract test: this service's job format against FieldProof's REAL
// validation code (read-only; FieldProof is not changed). Run with the path
// of a FieldProof checkout's app folder:
//   FIELDPROOF_SRC=/path/to/fieldproof/app node scripts/contract-test.mts
// It checks that the documented example and the Agent Card example pass
// FieldProof's validation as this service sends them, that every validation
// answer FieldProof gives is one this service explains (anything else is
// treated as a service problem), that FieldProof's field names map onto this
// agent's names, and that the retry key fits FieldProof's 128 characters.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { EXAMPLE_JOB, FIELD_NAMES, MAX_MESSAGE_ID, WHY, retryKey, toFieldProof } from "../src/protocol.mts";

const src = process.env.FIELDPROOF_SRC;
if (src === undefined || src === "") {
  console.log("SKIP: set FIELDPROOF_SRC to a FieldProof checkout's app folder");
  process.exit(0);
}
const { validateJobInput } = (await import(pathToFileURL(`${src}/shared/fieldJobs.ts`).href)) as {
  validateJobInput: (b: Record<string, unknown>, p: (s: unknown) => string | null) => { ok: boolean; error?: string; value?: unknown };
};
const { parseAbsolute } = (await import(pathToFileURL(`${src}/shared/timezone.ts`).href)) as {
  parseAbsolute: (s: unknown) => { ok: boolean; instant?: string };
};
const parse = (s: unknown): string | null => {
  const a = parseAbsolute(s);
  return a.ok ? (a.instant as string) : null;
};
const longKey = retryKey("c".repeat(32), "m".repeat(MAX_MESSAGE_ID));
const validate = (job: Record<string, unknown>) => validateJobInput(toFieldProof(job, longKey), parse);
let checks = 0;
const ok = (name: string, fn: () => void): void => {
  fn();
  checks += 1;
  console.log(`PASS ${name}`);
};

ok("the documented example passes FieldProof's validation", () => assert.equal(validate(EXAMPLE_JOB).ok, true));
const card = JSON.parse(readFileSync(new URL("../public/.well-known/agent-card.json", import.meta.url), "utf8")) as { skills: Array<{ examples: string[] }> };
ok("the Agent Card example passes FieldProof's validation", () => assert.equal(validate(JSON.parse(card.skills[0].examples[0])).ok, true));
ok("optional fields pass too", () =>
  assert.equal(validate({ ...EXAMPLE_JOB, deliverables: "A photo per bag.", skills: ["Sampling"], safetyNotes: "Wear boots.", photoTips: ["Fill the frame", "Avoid glare"] }).ok, true));
ok("the longest retry key fits FieldProof's 128 characters", () => assert.ok(longKey.length <= 128));

const bad: Array<[string, Record<string, unknown>]> = [
  ["missing title", { ...EXAMPLE_JOB, title: "" }],
  ["bad window", { ...EXAMPLE_JOB, windowStart: "2026-12-10", windowEnd: "2026-12-09" }],
  ["bad date", { ...EXAMPLE_JOB, windowStart: "7 Dec" }],
  ["bad money", { ...EXAMPLE_JOB, budgetMin: 500, budgetMax: 100 }],
  ["bad currency", { ...EXAMPLE_JOB, currency: "dollars" }],
  ["bad deadline", { ...EXAMPLE_JOB, bidDeadline: "next week" }],
  ["no items", { ...EXAMPLE_JOB, items: [] }],
  ["bad label", { ...EXAMPLE_JOB, items: ["B 12"] }],
  ["contact details", { ...EXAMPLE_JOB, outcome: "Call +62 812 3456 7890 first." }],
  ["text too long", { ...EXAMPLE_JOB, title: "x".repeat(5000) }],
  ["bad skills", { ...EXAMPLE_JOB, skills: "sampling" }],
  ["leaks a code in the outcome", { ...EXAMPLE_JOB, outcome: "Start with bag B12." }],
  ["leaks a code in the site", { ...EXAMPLE_JOB, site: "Store B17" }],
  ["leaks a code in a photo tip", { ...EXAMPLE_JOB, photoTips: ["B12 is on the left"] }],
  ["leaks a code in the deliverables", { ...EXAMPLE_JOB, deliverables: "One photo of B17." }],
];
for (const [name, job] of bad) {
  ok(`FieldProof's answer to "${name}" is one this service explains`, () => {
    const r = validate(job);
    assert.equal(r.ok, false, name);
    const [code, field] = String(r.error).split(":");
    assert.ok(WHY[code] !== undefined, `${name}: FieldProof answered ${code}, which this service does not explain`);
    if (code === "job_leaks_code") assert.ok(field !== undefined && FIELD_NAMES[field] !== undefined, `${name}: field ${field} has no name here`);
  });
}
console.log(`\nRESULT: PASS (${checks} checks against FieldProof's validation at ${src})`);
