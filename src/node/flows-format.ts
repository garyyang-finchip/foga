/** The flows status (flow_status) as `foga flow status` prints it: the channel, the market, the registries, what the node keeps. */
export interface FlowStatusView {
  available: boolean;
  meaning: string;
  registries: { paradigms: string; channels: string; participation: string; verifier: string; anchor: string; identityVerifier: string | null } | null;
  paradigms: Record<string, { paradigmId: string; registered: boolean | null }>;
  channel: { channelId: string; paradigm: string; paradigmId: string | null; authority: string | null; authorityIsTheCell: boolean | null; state: string | null; openedAt: number | null; bindings: number; roles: Record<string, string>; disclosureCount: number | null } | null;
  market: { channelId: string; source: string; paradigmId: string | null; fogaMarket: boolean | null; authority: string | null; state: string | null; join: boolean; wanted: string[]; roles: Record<string, string>; admitted: Record<string, { bindingId: string }>; eligibility: { ok: boolean; detail: string } | null } | null;
  local: { dir: string; anchors: number; disclosures: number; lastAnchor: { objectRef: string; action: string; version: number } | null; publication: { objectRef: string; version: number; anchored: boolean; disclosed: boolean } | null; watcher: { auto: boolean; checkEverySeconds: number; nextCheckAt: number | null; lastAction: string | null } };
}

const iso = (t: number | null) => (t ? new Date(t * 1000).toISOString().replace(/\.\d{3}Z$/, "Z") : "-");
const short = (h: string | null) => (h ? `${h.slice(0, 10)}…` : "-");

export function formatFlowStatus(s: FlowStatusView): string {
  const lines: string[] = [];
  if (!s.available || !s.registries) return `${s.meaning}\n`;
  lines.push(`ERC-8489 registries: paradigms ${s.registries.paradigms}, channels ${s.registries.channels}, participation ${s.registries.participation}, verifier ${s.registries.verifier}, anchor ${s.registries.anchor}, identity verifier ${s.registries.identityVerifier ?? "none"}`);
  for (const [name, p] of Object.entries(s.paradigms)) lines.push(`paradigm ${name}: ${p.paradigmId} (${p.registered === null ? "unreadable" : p.registered ? "registered" : "NOT registered on this chain"})`);
  lines.push("");
  if (!s.channel) lines.push("channel: none (foga cell extend --covenants 8489 opens the cell's channel; a new cell opens it at birth)");
  else {
    const c = s.channel;
    lines.push(`channel ${c.channelId} (${c.paradigm}): authority ${c.authority ?? "-"}${c.authorityIsTheCell === false ? " (NOT the cell)" : ""}, ${c.state ?? "-"}, opened ${iso(c.openedAt)}, ${c.bindings} transport binding(s), ${c.disclosureCount ?? "-"} disclosure record(s)`);
    lines.push(`  roles of the cell: ${Object.entries(c.roles).map(([r, o]) => `${r} ${o}`).join(", ")}`);
  }
  if (!s.market) lines.push("market: none (this world names no default market and the configuration none either)");
  else {
    const m = s.market;
    lines.push(`market ${m.channelId} (${m.source}): authority ${m.authority ?? "-"}, ${m.state ?? "-"}, paradigm ${short(m.paradigmId)}${m.fogaMarket === false ? " (not FOGA's tender market for this world)" : ""}; join ${m.join ? `on (${m.wanted.join(", ")})` : "off"}`);
    lines.push(`  roles of the cell: ${Object.entries(m.roles).map(([r, o]) => `${r} ${o}`).join(", ")}${Object.keys(m.admitted).length ? `; admitted: ${Object.keys(m.admitted).join(", ")}` : ""}`);
    if (m.eligibility) lines.push(`  eligibility now: ${m.eligibility.ok ? "ok" : "NOT eligible"} (${m.eligibility.detail})`);
  }
  lines.push("");
  lines.push(`local: ${s.local.anchors} anchor(s), ${s.local.disclosures} disclosure(s)${s.local.lastAnchor ? `; last anchored ${short(s.local.lastAnchor.objectRef)} (${s.local.lastAnchor.action}, documents v${s.local.lastAnchor.version})` : ""}${s.local.publication ? `; current publication ${short(s.local.publication.objectRef)} (v${s.local.publication.version}) ${s.local.publication.anchored ? "anchored" : "NOT anchored"}, ${s.local.publication.disclosed ? "disclosed" : "not disclosed"}` : "; no publication yet"}; documents under ${s.local.dir}`);
  lines.push(s.local.watcher.auto ? `watcher: on — checks every ${s.local.watcher.checkEverySeconds} s${s.local.watcher.nextCheckAt ? `, next check ${iso(s.local.watcher.nextCheckAt)}` : ""}${s.local.watcher.lastAction ? `, last: ${s.local.watcher.lastAction}` : ""}` : "watcher: off (flows.auto false)");
  lines.push(s.meaning);
  return lines.join("\n") + "\n";
}
