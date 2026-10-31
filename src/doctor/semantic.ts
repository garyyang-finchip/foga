import { readJson } from "../util/fs.js";

/**
 * Doctor layer 5 — semantic validation: the genesis scenario is the evidence. The doctor consumes a
 * `foga.genesis-evidence/1` file (docs/genesis.md), attributes every recorded check to the standards it
 * exercises and reports, per ERC, what the evidence establishes. It does not re-run anything: a check the
 * genesis recorded as skipped (proving material absent) counts as untested for the standard it belongs to,
 * never as a pass.
 */
export interface GenesisCheck {
  step: string;
  name: string;
  pass: boolean;
  detail: string;
}

export interface GenesisEvidenceFile {
  schema: string;
  worldId: string;
  chainId: number;
  until: string;
  ranAt: string;
  checks: GenesisCheck[];
  summary: { checks: number; passed: number; failed: number; operations: Record<string, number> };
  facts: Record<string, unknown>;
}

export interface Layer5Result {
  erc: string;
  verdict: "Pass" | "Fail" | "NotTested";
  checks: number;
  passed: number;
  failed: number;
  skipped: number;
  steps: string[];
  failing: string[];
  detail: string;
}

/**
 * Which standards a genesis check exercises, by the dotted tokens of its name; several may apply. A token matches
 * whole (`aid` does not match `unpaid`), so a name is attributed by what it names.
 */
const tok = (...words: string[]) => new RegExp(`(^|\\.)(${words.join("|")})(\\.|$)`);
const RULES: { test: RegExp; ercs: string[] }[] = [
  { test: tok("kya", "scheme", "zk", "S_att", "S_cred", "S_pred", "nullifier", "epoch", "predicate", "attest"), ercs: ["8419"] },
  { test: tok("aid", "anchor", "heartbeat", "document", "retire", "retired", "stale", "bind"), ercs: ["8434"] },
  { test: /^A\.active|^Aprime\.active/, ercs: ["8434"] },
  { test: tok("asf", "spec", "binding", "status", "suspend", "resume", "escape", "bypass", "derisk", "newrisk", "safety", "requirementId", "bindingId"), ercs: ["8468"] },
  { test: tok("skill", "tamper", "commitment", "finch-extract-verify", "foga-probe"), ercs: ["8338"] },
  { test: tok("tender", "submission", "submissions", "settle", "paid", "escrow", "completion", "copy", "answer", "fulfilment", "attribution", "withdraw", "accepted"), ercs: ["8414"] },
  { test: tok("council", "ballot", "round", "nd", "gov", "judgment", "decide", "finalize", "appeal", "judges", "execute"), ercs: ["8436"] },
  { test: tok("swarm", "roster", "join", "represent", "eligibility", "challenge", "charter", "members", "activate", "seat"), ercs: ["8447"] },
  { test: tok("unit", "resolver", "receipt", "method", "measurement", "value"), ercs: ["8454"] },
  { test: /^assertion\./, ercs: ["8454"] },
  { test: tok("ard", "record", "backed", "adopted", "discovery"), ercs: ["8444"] },
  { test: tok("dispute", "case", "ruling", "refund", "call1", "call2", "file", "finding", "service", "provider", "balances", "conforms", "released", "deposited", "charged", "held"), ercs: ["8471"] },
  { test: tok("8004", "identity", "histories", "inherit"), ercs: ["8004"] },
];

/** Steps and the standards they are about, used when a check name says nothing. */
const STEP_ERCS: Record<string, string[]> = {
  T0: ["8419", "8468", "8436", "8471"],
  T1: ["8004", "8434", "8468", "8419", "8444", "8454"],
  T2: ["8338", "8444", "8454", "8434"],
  T3: ["8414", "8444", "8338"],
  T4: ["8447", "8436", "8414", "8454"],
  T5: ["8436", "8447", "8414"],
  T6: ["8471", "8436", "8338"],
  T7: ["8468", "8414", "8434"],
  T8: ["8454"],
  T9: ["8434", "8004", "8444", "8338", "8419", "8447"],
};

export function ercsOf(check: GenesisCheck): string[] {
  const out = new Set<string>();
  for (const r of RULES) if (r.test.test(check.name)) for (const e of r.ercs) out.add(e);
  if (out.size === 0) for (const e of STEP_ERCS[check.step] ?? []) out.add(e);
  return [...out];
}

export function loadGenesisEvidence(path: string): GenesisEvidenceFile {
  const e = readJson<GenesisEvidenceFile>(path);
  if (e.schema !== "foga.genesis-evidence/1") throw new Error(`${path} is not a genesis evidence file (schema ${e.schema})`);
  return e;
}

/** Layer-5 verdicts per ERC from one evidence file. `ercs` are the standards present in the world. */
export function semanticVerdicts(evidence: GenesisEvidenceFile, ercs: string[]): Layer5Result[] {
  const per = new Map<string, { checks: GenesisCheck[] }>();
  for (const e of ercs) per.set(e, { checks: [] });
  for (const c of evidence.checks) for (const e of ercsOf(c)) per.get(e)?.checks.push(c);
  const out: Layer5Result[] = [];
  for (const erc of ercs) {
    const checks = per.get(erc)!.checks;
    const skipped = checks.filter((c) => /^skipped:/.test(c.detail));
    const effective = checks.filter((c) => !/^skipped:/.test(c.detail));
    const failed = effective.filter((c) => !c.pass);
    const steps = [...new Set(checks.map((c) => c.step))].sort();
    let verdict: Layer5Result["verdict"] = "NotTested";
    if (effective.length > 0) verdict = failed.length ? "Fail" : "Pass";
    out.push({
      erc,
      verdict,
      checks: checks.length,
      passed: effective.length - failed.length,
      failed: failed.length,
      skipped: skipped.length,
      steps,
      failing: failed.map((c) => `${c.step} ${c.name}`),
      detail: effective.length === 0 ? `no genesis check exercises ERC-${erc} in this evidence (until ${evidence.until})` : `${effective.length - failed.length}/${effective.length} checks pass over ${steps.join(", ")}${skipped.length ? `; ${skipped.length} skipped` : ""}${failed.length ? `; failing: ${failed.map((c) => `${c.step} ${c.name}`).join(", ")}` : ""}`,
    });
  }
  return out;
}
