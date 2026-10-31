import { readFileSync } from "node:fs";
import { jcs, sha256Hex } from "../core/canonical.js";

/**
 * The deterministic path of the `finch-extract-verify` skill: line-label extraction over a pinned document and
 * the consistency rules its field list declares. No model is involved; the model path (free-form documents)
 * belongs to the real-agent acceptance of a later phase. The report is the deliverable a judged tender
 * accepts or rejects; its hash is the submission's resultHash.
 */
export interface FieldSpec {
  name: string;
  kind: "text" | "date" | "amount";
  label: string;
  where?: string;
}

export interface FieldsSpec {
  schema: string;
  fields: FieldSpec[];
  rules: { id: string; check: string; tolerance?: string }[];
}

export interface ExtractedField {
  value: string | null;
  evidence: { line: number; quote: string }[];
}

export interface ExtractReport {
  schema: "finch.extract-verify/1";
  skill: { name: "finch-extract-verify"; packageHash: string };
  documentDigest: string;
  fields: Record<string, ExtractedField>;
  rules: { id: string; verdict: "pass" | "fail" | "unknown"; note: string }[];
}

function normalize(kind: FieldSpec["kind"], raw: string): string | null {
  const v = raw.trim();
  if (!v) return null;
  if (kind === "amount") {
    const n = v.replace(/,/g, "").match(/^-?\d+(\.\d+)?/);
    return n ? n[0] : null;
  }
  if (kind === "date") {
    const d = v.match(/^\d{4}-\d{2}-\d{2}/);
    return d ? d[0] : null;
  }
  return v;
}

export function extractVerify(text: string, spec: FieldsSpec, packageHash: string): ExtractReport {
  const lines = text.split(/\r?\n/);
  const fields: Record<string, ExtractedField> = {};
  for (const f of spec.fields) {
    const prefix = `${f.label}:`;
    const idx = lines.findIndex((l) => l.startsWith(prefix));
    if (idx < 0) {
      fields[f.name] = { value: null, evidence: [] };
      continue;
    }
    fields[f.name] = { value: normalize(f.kind, lines[idx].slice(prefix.length)), evidence: [{ line: idx + 1, quote: lines[idx].trim() }] };
  }
  const num = (name: string) => (fields[name]?.value === null || fields[name]?.value === undefined ? null : Number(fields[name].value));
  const rules: ExtractReport["rules"] = [];
  for (const r of spec.rules) {
    if (r.id === "balance") {
      const a = num("totalAssets");
      const l = num("totalLiabilities");
      const e = num("totalEquity");
      if (a === null || l === null || e === null) rules.push({ id: r.id, verdict: "unknown", note: "a term is missing" });
      else {
        const diff = Math.abs(a - (l + e));
        const tol = Number(r.tolerance ?? "0");
        rules.push({ id: r.id, verdict: diff <= tol ? "pass" : "fail", note: `${a} vs ${l} + ${e} (difference ${diff}, tolerance ${tol})` });
      }
    } else if (r.id === "period") {
      const p = fields.periodEnd?.value ?? null;
      const d = fields.documentDate?.value ?? null;
      if (!p || !d) rules.push({ id: r.id, verdict: "unknown", note: "a date is missing" });
      else rules.push({ id: r.id, verdict: p <= d ? "pass" : "fail", note: `period end ${p}, document date ${d}` });
    } else {
      rules.push({ id: r.id, verdict: "unknown", note: "rule not implemented by the deterministic path" });
    }
  }
  return { schema: "finch.extract-verify/1", skill: { name: "finch-extract-verify", packageHash }, documentDigest: sha256Hex(text), fields, rules };
}

export function extractVerifyFile(documentPath: string, fieldsPath: string, packageHash: string): { report: ExtractReport; canonical: string; resultHash: string } {
  const text = readFileSync(documentPath, "utf8");
  const spec = JSON.parse(readFileSync(fieldsPath, "utf8")) as FieldsSpec;
  const report = extractVerify(text, spec, packageHash);
  const canonical = jcs(report);
  return { report, canonical, resultHash: sha256Hex(canonical) };
}
