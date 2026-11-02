import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { McpServer, type ToolAnnotations } from "@modelcontextprotocol/server";
import { z } from "zod";
import { fogaCellSpecification } from "../core/asf.js";
import type { Node } from "../node/node.js";
import { ACTION_RANK, type ActCapability, type Caller, type Capability, type Catalog, type Mode, type ReadCapability, type ToolResult } from "../tools/index.js";
import { repoRoot } from "../util/fs.js";

/**
 * The MCP entrance (design memo, Phase 3, section 4): one `McpServer` built from the catalog for one caller. The
 * tool list is the catalog filtered by what the caller may see and do; every call still goes through
 * `Catalog.invoke`, so hiding a tool is never the authorization and showing one never grants it. Annotations are
 * static, so a write capability is three tool definitions over one handler — `<name>` acts, `<name>_simulate` runs
 * every check and sends nothing, `<name>_build` returns the calls for the caller's own account. Results are
 * `structuredContent` under the capability's output schema; a refusal of an act is `isError: true` carrying the
 * gate, the reason and the decision record's id (a business refusal is a tool execution error in MCP's terms), while
 * `tender_precheck` reports an ineligible tender as an ordinary result (`eligible: false`), because finding out is
 * what it is for. Admin capabilities are not offered over MCP in Phase 3: they are the owner's and the guardian's
 * CLI commands.
 */
export interface McpServerOptions {
  node: Node;
  catalog: Catalog;
  caller: Caller;
  version: string;
}

const READ_ANNOTATIONS: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const ACT_ANNOTATIONS: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true };
const GENTLE_ACT_ANNOTATIONS: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const SIMULATE_ANNOTATIONS: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const BUILD_ANNOTATIONS: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

/** Acts that commit nothing and move nothing: their act tool is not marked destructive. */
const GENTLE_ACTS = new Set(["tender_precheck", "aid_heartbeat"]);

const text = (value: unknown) => JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2);

function success(structured: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text: text(structured) }], structuredContent: structured };
}

function refusal(r: { gate: string; reason: string; decisionId?: number; jobId?: string }) {
  const structured = { ok: false, gate: r.gate, reason: r.reason, decisionId: r.decisionId ?? null, jobId: r.jobId ?? null };
  return { isError: true, content: [{ type: "text" as const, text: `refused at ${r.gate}: ${r.reason}` }], structuredContent: structured };
}

/** The output schema of an act tool: the capability's output under `output`, or a refusal's fields. */
function actOutputSchema(cap: ActCapability) {
  return z.object({
    ok: z.boolean(),
    gate: z.string().optional(),
    reason: z.string().optional(),
    decisionId: z.number().nullable().optional(),
    jobId: z.string().nullable().optional(),
    operations: z.array(z.string()).optional(),
    output: cap.output.optional(),
  });
}

const buildOutputSchema = z.object({
  ok: z.boolean(),
  as: z.string().optional(),
  calls: z.array(z.object({ to: z.string(), value: z.string(), data: z.string(), label: z.string() })).optional(),
  gate: z.string().optional(),
  reason: z.string().optional(),
  decisionId: z.number().nullable().optional(),
});

const precheckOutputSchema = (cap: ActCapability) =>
  z.object({
    eligible: z.boolean(),
    gate: z.string().optional(),
    reason: z.string().optional(),
    decisionId: z.number().nullable().optional(),
    jobId: z.string().nullable().optional(),
    result: cap.output.optional(),
  });

/** A read output that is not an object is carried under `result` (structuredContent must be an object). */
function readOutputSchema(cap: ReadCapability): { schema: z.ZodType; wrap: boolean } {
  const json = z.toJSONSchema(cap.output, { target: "draft-2020-12", io: "output" }) as { type?: string };
  if (json.type === "object") return { schema: cap.output, wrap: false };
  return { schema: z.object({ result: cap.output }), wrap: true };
}

export function buildMcpServer(o: McpServerOptions): McpServer {
  const { node, catalog, caller } = o;
  const cell = node.cell;
  const server = new McpServer(
    { name: "foga", title: `FOGA node ${node.config.name}`, version: o.version },
    {
      instructions: [
        `This is the Finch OG Agent node of cell ${node.config.name}${cell ? ` (account ${cell.address})` : ""} on world ${node.world.file.worldId} (chain ${node.chainId}).`,
        "Reads need nothing. A write capability is three tools: the act itself, `_simulate` (every check and a dry run, a decision record, nothing sent) and `_build` (the calls for your own account, pass `as`).",
        "To take a tender: tender_inspect, then tender_precheck (eligible: false names the gate), skill_run with the task's input, tender_submit with the run's resultHash, tender_settle with the answer.",
        "A refused act returns isError with gate, reason and decisionId; the decision record is the node's account of why. Nothing you say changes a gate: policy is code.",
      ].join(" "),
    },
  );

  for (const summary of catalog.list(caller)) {
    const cap = catalog.get(summary.name) as Capability;
    if (cap.action === "read") {
      const { schema, wrap } = readOutputSchema(cap);
      server.registerTool(cap.name, { title: cap.title, description: cap.description, inputSchema: cap.input, outputSchema: schema, annotations: READ_ANNOTATIONS }, async (args) => {
        const r: ToolResult = await catalog.invoke(node, cap.name, args ?? {}, caller);
        if (!r.ok) return refusal(r);
        return success(wrap ? { result: r.output } : (r.output as Record<string, unknown>));
      });
      continue;
    }
    if (cap.action === "admin") continue;
    const act = cap as ActCapability;
    const modes = summary.modes;
    if (modes.includes("act")) {
      if (act.name === "tender_precheck") {
        server.registerTool(act.name, { title: act.title, description: act.description, inputSchema: act.input, outputSchema: precheckOutputSchema(act), annotations: GENTLE_ACT_ANNOTATIONS }, async (args) => {
          const r = await catalog.invoke(node, act.name, args ?? {}, caller, { mode: "act" });
          if (!r.ok) return success({ eligible: false, gate: r.gate, reason: r.reason, decisionId: r.decisionId ?? null, jobId: r.jobId ?? null });
          return success({ eligible: true, decisionId: r.decisionId ?? null, jobId: r.jobId ?? null, result: r.output });
        });
      } else {
        server.registerTool(act.name, { title: act.title, description: act.description, inputSchema: act.input, outputSchema: actOutputSchema(act), annotations: GENTLE_ACTS.has(act.name) ? GENTLE_ACT_ANNOTATIONS : ACT_ANNOTATIONS }, async (args) => {
          const r = await catalog.invoke(node, act.name, args ?? {}, caller, { mode: "act" });
          if (!r.ok) return refusal(r);
          return success({ ok: true, decisionId: r.decisionId ?? null, jobId: r.jobId ?? null, operations: r.operations ?? [], output: r.output });
        });
      }
    }
    if (modes.includes("simulate")) {
      const name = `${act.name}_simulate`;
      const schema = act.name === "tender_precheck" ? precheckOutputSchema(act) : actOutputSchema(act);
      server.registerTool(name, { title: `${act.title} (dry run)`, description: `${act.description} Dry run: every check and a simulation of the first call, a decision record, nothing sent.`, inputSchema: act.input, outputSchema: schema, annotations: SIMULATE_ANNOTATIONS }, async (args) => {
        const r = await catalog.invoke(node, act.name, args ?? {}, caller, { mode: "simulate" });
        if (act.name === "tender_precheck") {
          if (!r.ok) return success({ eligible: false, gate: r.gate, reason: r.reason, decisionId: r.decisionId ?? null, jobId: r.jobId ?? null });
          return success({ eligible: true, decisionId: r.decisionId ?? null, jobId: r.jobId ?? null, result: r.output });
        }
        if (!r.ok) return refusal(r);
        return success({ ok: true, decisionId: r.decisionId ?? null, jobId: r.jobId ?? null, output: r.output });
      });
    }
    if (modes.includes("build") && act.name !== "tender_precheck" && act.name !== "skill_run") {
      const name = `${act.name}_build`;
      server.registerTool(name, { title: `${act.title} (calldata)`, description: `${act.description} Build: the unsigned calls for the account named in \`as\` (your own), to sign and send yourself.`, inputSchema: act.input, outputSchema: buildOutputSchema, annotations: BUILD_ANNOTATIONS }, async (args) => {
        const r = await catalog.invoke(node, act.name, args ?? {}, caller, { mode: "build" });
        if (!r.ok) return refusal(r);
        return success({ ok: true, ...(r.output as Record<string, unknown>), decisionId: r.decisionId ?? null });
      });
    }
  }

  // resources: what a model reads rules and state from
  server.registerResource("world", "foga://world", { title: "The world", description: "World id, chain, contracts, bundle hash.", mimeType: "application/json" }, async (uri) => {
    const r = await catalog.invoke(node, "world_describe", {}, caller);
    return { contents: [{ uri: uri.href, mimeType: "application/json", text: text(r.ok ? r.output : r) }] };
  });
  if (cell) {
    server.registerResource("cell-status", "foga://cell/status", { title: "The cell's status", description: "Anchor, binding, skills, policy summary (and for the operator the budget and open work).", mimeType: "application/json" }, async (uri) => {
      const r = await catalog.invoke(node, "cell_status", {}, caller);
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: text(r.ok ? r.output : r) }] };
    });
  }
  server.registerResource("policy", "foga://policy", { title: "The cell's policy", description: "Budget and tender rules the policy engine applies to every act.", mimeType: "application/json" }, async (uri) => ({ contents: [{ uri: uri.href, mimeType: "application/json", text: text(node.config.policy) }] }));
  server.registerResource("spec-foga-cell-v1", "foga://spec/foga-cell-v1", { title: "FOGA-Cell-v1", description: "The ERC-8468 safety specification every FOGA cell adopts.", mimeType: "application/json" }, async (uri) => ({ contents: [{ uri: uri.href, mimeType: "application/json", text: text(fogaCellSpecification()) }] }));
  const matrix = join(repoRoot(), "docs", "compatibility-matrix.md");
  if (existsSync(matrix)) {
    server.registerResource("compatibility-matrix", "foga://docs/compatibility-matrix", { title: "Compatibility matrix", description: "The ten standards, what the kernel exercises of each, and the evidence.", mimeType: "text/markdown" }, async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: readFileSync(matrix, "utf8") }] }));
  }

  // the one prompt: take a tender as the node's operator would
  server.registerPrompt("take-tender", { title: "Take a tender", description: "Work one ERC-8414 tender the way the node's operator would: inspect, pre-check, run the skill, submit, settle.", argsSchema: z.object({ tokenId: z.string().describe("the tender's token id") }) }, ({ tokenId }) => ({
    messages: [
      {
        role: "user" as const,
        content: {
          type: "text" as const,
          text: [
            `Take tender ${tokenId} for cell ${node.config.name} if the cell's rules allow it.`,
            `1. tender_inspect {"tokenId":"${tokenId}"}: read the task document (skill, packageHash, input, acceptance).`,
            `2. tender_precheck {"tokenId":"${tokenId}"}: if eligible is false, stop and report the gate and reason — do not look for a way around it.`,
            `3. skill_run {"skill":<the task's skill>,"input":<the task's input>,"tokenId":"${tokenId}"}: the run returns answer, answerHash and resultHash.`,
            `4. tender_submit {"tokenId":"${tokenId}","resultHash":<resultHash>,"runReceipt":<runReceipt>}.`,
            `5. tender_settle {"tokenId":"${tokenId}","submissionId":<from the submit>,"answer":<answer>}; then credit_withdraw if creditWei is above zero.`,
            "Report every decisionId you were given. A refusal is the node's verdict, not an obstacle.",
          ].join("\n"),
        },
      },
    ],
  }));

  return server;
}

/** The highest mode a caller gets over MCP, for the server's own description of itself. */
export function callerSummary(caller: Caller): string {
  return `${caller.id} (${caller.entrance}; level ${caller.level}, ${caller.visibility} data${ACTION_RANK[caller.level] >= ACTION_RANK.act ? "; may act" : ""})`;
}

export type { Mode };
