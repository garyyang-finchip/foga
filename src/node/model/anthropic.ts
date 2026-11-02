import { ModelError, type ContentBlock, type ModelAdapter, type ProposeRequest, type ProposeResult } from "./types.js";

/**
 * The Anthropic Messages API as a model adapter: tool use over plain `fetch`, no SDK (the node's dependency tree
 * stays ethers, zod and the MCP SDK). The key comes from `ANTHROPIC_API_KEY` (or the option), is sent in the
 * `x-api-key` header and appears in no error, log or record; the model name comes from the cell configuration
 * (`runtime.model.model`) — there is no default, because an actor on a chain should name the model it runs.
 * `baseUrl` (`ANTHROPIC_BASE_URL`) exists so a test can stand in for the API.
 */
export interface AnthropicOptions {
  apiKey?: string;
  baseUrl?: string;
  maxTokens?: number;
  timeoutMs?: number;
  /** Retries on 429 and 5xx (each after a short, growing pause). */
  retries?: number;
  fetch?: typeof fetch;
}

export const ANTHROPIC_VERSION = "2023-06-01";

export class AnthropicAdapter implements ModelAdapter {
  readonly provider = "anthropic" as const;
  private readonly key: string;
  private readonly baseUrl: string;
  private readonly maxTokens: number;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly fetchImpl: typeof fetch;

  constructor(
    readonly model: string,
    opts: AnthropicOptions = {},
  ) {
    if (!model) throw new ModelError("runtime.model.model names no model; set it in the cell configuration (provider anthropic)");
    const key = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
    if (!key) throw new ModelError("ANTHROPIC_API_KEY is not set; the anthropic provider needs it in the node's environment");
    this.key = key;
    this.baseUrl = (opts.baseUrl ?? process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com").replace(/\/+$/, "");
    this.maxTokens = opts.maxTokens ?? 2048;
    this.timeoutMs = opts.timeoutMs ?? 120_000;
    this.retries = opts.retries ?? 2;
    this.fetchImpl = opts.fetch ?? fetch;
  }

  async propose(req: ProposeRequest): Promise<ProposeResult> {
    const body = {
      model: this.model,
      max_tokens: this.maxTokens,
      system: req.system,
      tools: req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: inputSchema(t.inputSchema) })),
      messages: req.messages.map((m) => ({ role: m.role, content: m.content.map(toWire) })),
    };
    let attempt = 0;
    for (;;) {
      let res: Response;
      try {
        res = await this.fetchImpl(`${this.baseUrl}/v1/messages`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-api-key": this.key, "anthropic-version": ANTHROPIC_VERSION },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (e) {
        if (attempt++ < this.retries) {
          await pause(attempt);
          continue;
        }
        throw new ModelError(`the Messages API could not be reached: ${(e as Error).message}`);
      }
      if (res.status === 429 || res.status >= 500) {
        if (attempt++ < this.retries) {
          const after = Number(res.headers.get("retry-after"));
          await pause(attempt, Number.isFinite(after) && after > 0 ? after * 1000 : undefined);
          continue;
        }
        throw new ModelError(`the Messages API answered ${res.status} after ${attempt} attempts`, res.status);
      }
      if (!res.ok) {
        let detail = "";
        try {
          const err = (await res.json()) as { error?: { type?: string; message?: string } };
          detail = err.error ? `${err.error.type ?? "error"}: ${err.error.message ?? ""}` : "";
        } catch {
          detail = "";
        }
        throw new ModelError(`the Messages API answered ${res.status}${detail ? ` (${detail})` : ""}`, res.status);
      }
      const data = (await res.json()) as { content?: unknown; stop_reason?: string; usage?: { input_tokens?: number; output_tokens?: number } };
      if (!Array.isArray(data.content)) throw new ModelError("the Messages API answered without a content array");
      const content: ContentBlock[] = [];
      for (const raw of data.content as Record<string, unknown>[]) {
        if (raw.type === "text" && typeof raw.text === "string") content.push({ type: "text", text: raw.text });
        else if (raw.type === "tool_use" && typeof raw.id === "string" && typeof raw.name === "string") content.push({ type: "tool_use", id: raw.id, name: raw.name, input: (raw.input ?? {}) as Record<string, unknown> });
      }
      return { content, stopReason: data.stop_reason ?? "end_turn", usage: { inputTokens: data.usage?.input_tokens ?? 0, outputTokens: data.usage?.output_tokens ?? 0 } };
    }
  }
}

/** The API wants a plain object schema; the catalog's `$schema` marker is dropped. */
function inputSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const { $schema: _s, ...rest } = schema as Record<string, unknown> & { $schema?: string };
  return rest.type ? rest : { type: "object", ...rest };
}

function toWire(b: ContentBlock): Record<string, unknown> {
  if (b.type === "tool_result") return { type: "tool_result", tool_use_id: b.tool_use_id, content: b.content, ...(b.is_error ? { is_error: true } : {}) };
  return b;
}

function pause(attempt: number, ms?: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms ?? 500 * 2 ** (attempt - 1)));
}
