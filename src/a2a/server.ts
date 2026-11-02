import { randomUUID } from "node:crypto";
import type { Node } from "../node/node.js";
import { ACTION_RANK, type Caller, type Catalog } from "../tools/index.js";
import { A2A_ERRORS, A2A_PROTOCOL_VERSION, TERMINAL_STATES, type Artifact, type CancelTaskRequest, type GetTaskRequest, type ListTasksRequest, type ListTasksResponse, type Message, type Part, type SendMessageRequest, type SendMessageResponse, type Task, type TaskState } from "./types.js";

/**
 * The A2A entrance (design memo, Phase 3, section 6; A2A 1.0, JSON-RPC binding): `POST /a2a`, the three operations
 * plus ListTasks, no streaming, no push. An inbound message becomes a FOGA task and takes one of two roads by the
 * `foga` object in its data part (or its text, for a question in words):
 *
 *   quote   (the default, open to anyone): can the cell do this, with which skill, on what terms — a tender template
 *           (the acceptance authority, the reward floor, the deadlines). Nothing runs, nothing touches the chain.
 *   tender  `{"foga":{"mode":"tender","tokenId":"23"}}`: an ERC-8414 tender that exists, funded, its answer committed.
 *           The node works it through its own catalog — tender_precheck, skill_run, tender_submit — as the caller,
 *           so the caller needs the act level (an API key or a signer grant): the public is told to quote. The
 *           economics stay on chain; the settlement is the node's watchers' duty afterwards.
 *
 * A task is kept in the cell's store (facts `a2a.task.<id>`), deduplicated by (caller, messageId), visible to the
 * caller that made it and to the operator. A refusal by the catalog is TASK_STATE_REJECTED with the decision id; a
 * run that fails is TASK_STATE_FAILED; cancellation works until the submission is broadcast.
 */
export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown[] };
}

interface StoredTask {
  task: Task;
  caller: string;
  messageIds: string[];
  createdAt: string;
  /** The FOGA jobs the task made, by step. */
  jobs: { precheck?: string; run?: string; submit?: string };
  cancelRequested?: boolean;
  tokenId?: string;
}

const TASK_PREFIX = "a2a.task.";
const MSG_PREFIX = "a2a.msg.";
const QUOTE_SKILL_LIMIT = 50;

const now = () => new Date().toISOString();

function errorInfo(reason: string, metadata: Record<string, unknown> = {}): { "@type": string; reason: string; domain: string; metadata: Record<string, unknown> } {
  return { "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason, domain: "a2a-protocol.org", metadata: { ...metadata, timestamp: now() } };
}

export class A2AError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown[],
  ) {
    super(message);
  }
}

function agentMessage(text: string, data?: unknown, taskId?: string, contextId?: string): Message {
  const parts: Part[] = [{ text }];
  if (data !== undefined) parts.push({ data, mediaType: "application/json" });
  return { messageId: randomUUID(), role: "ROLE_AGENT", parts, ...(taskId ? { taskId } : {}), ...(contextId ? { contextId } : {}) };
}

/** The `foga` request in a message: from a data part with a `foga` object, or a text part (a question in words → quote). */
export function fogaRequestOf(message: Message): { mode: "quote" | "tender"; skill?: string; input?: unknown; tokenId?: string; text?: string } {
  for (const p of message.parts) {
    const d = p.data as { foga?: Record<string, unknown> } | undefined;
    if (d && typeof d === "object" && d.foga && typeof d.foga === "object") {
      const f = d.foga as { mode?: string; skill?: string; input?: unknown; tokenId?: string | number };
      const mode = f.mode === "tender" ? "tender" : "quote";
      return { mode, skill: typeof f.skill === "string" ? f.skill : undefined, input: f.input, tokenId: f.tokenId !== undefined ? String(f.tokenId) : undefined };
    }
  }
  const text = message.parts.map((p) => p.text).filter((t): t is string => typeof t === "string").join("\n").trim();
  return { mode: "quote", text: text || undefined };
}

export class A2AServer {
  constructor(
    readonly node: Node,
    readonly catalog: Catalog,
    private readonly log: (line: string) => void = () => {},
  ) {}

  private get store() {
    return this.node.store;
  }

  private load(id: string): StoredTask | undefined {
    return this.store.getFact<StoredTask>(TASK_PREFIX + id);
  }

  private save(t: StoredTask): void {
    this.store.setFact(TASK_PREFIX + t.task.id, t);
  }

  private visible(t: StoredTask, caller: Caller): boolean {
    return caller.visibility === "operator" || t.caller === caller.id;
  }

  private setState(t: StoredTask, state: TaskState, message?: Message): void {
    t.task.status = { state, timestamp: now(), ...(message ? { message } : {}) };
    if (message) t.task.history = [...(t.task.history ?? []), message];
    this.save(t);
  }

  /** The JSON-RPC dispatcher: one request in, one response out; the HTTP layer checks the version header and the media type. */
  async handle(request: unknown, caller: Caller, version: string | undefined): Promise<JsonRpcResponse> {
    const id = (request as JsonRpcRequest)?.id ?? null;
    try {
      if (!request || typeof request !== "object" || (request as JsonRpcRequest).jsonrpc !== "2.0" || typeof (request as JsonRpcRequest).method !== "string") throw new A2AError(A2A_ERRORS.InvalidRequestError, "Request payload validation error");
      const v = (version ?? "").trim() || "0.3";
      if (v !== A2A_PROTOCOL_VERSION) throw new A2AError(A2A_ERRORS.VersionNotSupportedError, `A2A version ${v} is not supported; this agent speaks ${A2A_PROTOCOL_VERSION} (send A2A-Version: ${A2A_PROTOCOL_VERSION})`, [errorInfo("VERSION_NOT_SUPPORTED", { requested: v, supported: [A2A_PROTOCOL_VERSION] })]);
      const { method, params } = request as JsonRpcRequest;
      let result: unknown;
      switch (method) {
        case "SendMessage":
          result = await this.sendMessage(params as SendMessageRequest, caller);
          break;
        case "GetTask":
          result = this.getTask(params as GetTaskRequest, caller);
          break;
        case "ListTasks":
          result = this.listTasks((params ?? {}) as ListTasksRequest, caller);
          break;
        case "CancelTask":
          result = await this.cancelTask(params as CancelTaskRequest, caller);
          break;
        case "SendStreamingMessage":
        case "SubscribeToTask":
          throw new A2AError(A2A_ERRORS.UnsupportedOperationError, "streaming is not supported by this agent (capabilities.streaming is false)");
        case "GetExtendedAgentCard":
          throw new A2AError(A2A_ERRORS.UnsupportedOperationError, "no extended agent card (capabilities.extendedAgentCard is false)");
        case "CreateTaskPushNotificationConfig":
        case "GetTaskPushNotificationConfig":
        case "ListTaskPushNotificationConfigs":
        case "DeleteTaskPushNotificationConfig":
          throw new A2AError(A2A_ERRORS.PushNotificationNotSupportedError, "push notifications are not supported by this agent (capabilities.pushNotifications is false)");
        default:
          throw new A2AError(A2A_ERRORS.MethodNotFoundError, "Method not found");
      }
      return { jsonrpc: "2.0", id, result };
    } catch (e) {
      if (e instanceof A2AError) return { jsonrpc: "2.0", id, error: { code: e.code, message: e.message, ...(e.data ? { data: e.data } : {}) } };
      this.log(`a2a: ${(e as Error).message}`);
      return { jsonrpc: "2.0", id, error: { code: A2A_ERRORS.InternalError, message: "Internal error" } };
    }
  }

  // ---------------------------------------------------------------------------- SendMessage

  async sendMessage(params: SendMessageRequest, caller: Caller): Promise<SendMessageResponse> {
    const m = params?.message;
    if (!m || typeof m !== "object" || typeof m.messageId !== "string" || !Array.isArray(m.parts) || m.parts.length === 0) throw new A2AError(A2A_ERRORS.InvalidParamsError, "Invalid parameters", [{ "@type": "type.googleapis.com/google.rpc.BadRequest", fieldViolations: [{ field: "message", description: "messageId and at least one part are required" }] }]);
    for (const p of m.parts) {
      if (p.raw !== undefined || p.url !== undefined) throw new A2AError(A2A_ERRORS.ContentTypeNotSupportedError, "file parts are not accepted; send text/plain or an application/json data part");
      if (p.mediaType && !/^(text\/plain|application\/json)\b/.test(p.mediaType)) throw new A2AError(A2A_ERRORS.ContentTypeNotSupportedError, `media type ${p.mediaType} is not accepted; text/plain or application/json`);
    }
    // the same message from the same caller is the same task (3.3.1: messageId detects duplicates)
    const dedupeKey = `${MSG_PREFIX}${caller.id}:${m.messageId}`;
    const known = this.store.getFact<string>(dedupeKey);
    if (known) {
      const t = this.load(known);
      if (t) return { task: this.publicTask(t, params.configuration?.historyLength) };
    }
    // a message to an existing task: input for one that asked, nothing for a terminal one
    if (m.taskId) {
      const t = this.load(m.taskId);
      if (!t || !this.visible(t, caller)) throw new A2AError(A2A_ERRORS.TaskNotFoundError, "Task not found", [errorInfo("TASK_NOT_FOUND", { taskId: m.taskId })]);
      if (TERMINAL_STATES.includes(t.task.status.state)) throw new A2AError(A2A_ERRORS.UnsupportedOperationError, `task ${m.taskId} is ${t.task.status.state} and accepts no further message`);
      t.messageIds.push(m.messageId);
      t.task.history = [...(t.task.history ?? []), m];
      this.store.setFact(dedupeKey, t.task.id);
      await this.work(t, m, caller);
      return { task: this.publicTask(t, params.configuration?.historyLength) };
    }
    const task: StoredTask = { task: { id: randomUUID(), contextId: m.contextId ?? randomUUID(), status: { state: "TASK_STATE_SUBMITTED", timestamp: now() }, history: [m], artifacts: [], metadata: { caller: caller.id, cell: this.node.config.name } }, caller: caller.id, messageIds: [m.messageId], createdAt: now(), jobs: {} };
    this.save(task);
    this.store.setFact(dedupeKey, task.task.id);
    await this.work(task, m, caller);
    return { task: this.publicTask(task, params.configuration?.historyLength) };
  }

  /** Decide what a message asks for and do it: a quote at once, a tender's work started. */
  private async work(t: StoredTask, m: Message, caller: Caller): Promise<void> {
    const req = fogaRequestOf(m);
    if (req.mode === "quote") {
      await this.quote(t, req);
      return;
    }
    const tokenId = req.tokenId ?? t.tokenId;
    if (!tokenId) {
      this.setState(t, "TASK_STATE_INPUT_REQUIRED", agentMessage("Which tender? Send a data part {\"foga\":{\"mode\":\"tender\",\"tokenId\":\"<id>\"}} naming an ERC-8414 tender that exists, is funded, and has its answer committed to the hashlock verifier.", { foga: { need: ["tokenId"] } }, t.task.id, t.task.contextId));
      return;
    }
    if (ACTION_RANK[caller.level] < ACTION_RANK.act) {
      this.setState(t, "TASK_STATE_REJECTED", agentMessage("This caller may not ask the cell to act: the tender mode needs an act-level credential (an API key the operator issued, or a wallet signature the cell's policy grants). A quote is open to everyone.", { foga: { gate: "permission", callerLevel: caller.level } }, t.task.id, t.task.contextId));
      return;
    }
    t.tokenId = tokenId;
    this.setState(t, "TASK_STATE_WORKING", agentMessage(`Working tender ${tokenId}: pre-check, run, submit. Settlement is the node's own duty afterwards.`, undefined, t.task.id, t.task.contextId));
    // the work continues after the response (3.3.3); GetTask reads the result
    void this.takeTender(t, tokenId, caller).catch((e) => {
      this.log(`a2a: task ${t.task.id}: ${(e as Error).message}`);
      const fresh = this.load(t.task.id) ?? t;
      this.setState(fresh, "TASK_STATE_FAILED", agentMessage(`The work failed: ${(e as Error).message}`, undefined, t.task.id, t.task.contextId));
    });
  }

  private async quote(t: StoredTask, req: { skill?: string; input?: unknown; text?: string }): Promise<void> {
    const cfg = this.node.config;
    const held = this.node.cell ? await this.node.heldSkills() : [];
    const offered = held.filter((h) => cfg.skills.offered.includes(h.name)).slice(0, QUOTE_SKILL_LIMIT);
    const terms = { acceptance: "hashlock", verifier: this.node.acceptance.hashlock, asset: "native", minRewardWei: cfg.policy.tenders.minRewardWei, minSubmitWindowSeconds: cfg.policy.tenders.minSubmitWindowSeconds, minSettleWindowSeconds: cfg.policy.tenders.minSettleWindowSeconds, counterpartyMinLevel: cfg.policy.tenders.counterpartyMinLevel };
    const how = "Mint an ERC-8414 tender for the skill with these terms (tender_mint_build gives the calls for your own account), fund it, commit the answer hash to the hashlock verifier, then send {\"foga\":{\"mode\":\"tender\",\"tokenId\":\"<id>\"}} with an act-level credential.";
    if (req.skill && !offered.some((h) => h.name === req.skill)) {
      this.setState(t, "TASK_STATE_REJECTED", agentMessage(`The cell does not offer a skill named ${req.skill}. Offered: ${offered.map((h) => h.name).join(", ") || "none"}.`, { foga: { quote: { skill: req.skill, offered: false, available: offered.map((h) => h.name) } } }, t.task.id, t.task.contextId));
      return;
    }
    const chosen = req.skill ? offered.filter((h) => h.name === req.skill) : offered;
    const quote = { cell: cfg.name, account: this.node.cell?.address ?? null, skills: chosen.map((h) => ({ name: h.name, version: String((h.pkg.manifest as { skillVersion?: string }).skillVersion ?? h.pkg.version), packageHash: h.packageHash, tokenId: h.tokenId.toString(), summary: (h.pkg.manifest as { summary?: string }).summary ?? null })), terms, ...(req.input !== undefined ? { inputEchoed: req.input } : {}), how };
    const artifact: Artifact = { artifactId: randomUUID(), name: "quote", description: "What the cell can do and on what terms", parts: [{ data: { foga: { quote } }, mediaType: "application/json" }] };
    t.task.artifacts = [artifact];
    const text = req.text ? `You asked: ${req.text.slice(0, 200)}. ` : "";
    this.setState(t, "TASK_STATE_COMPLETED", agentMessage(`${text}The cell offers ${chosen.length} skill(s)${chosen.length ? `: ${chosen.map((h) => h.name).join(", ")}` : ""}; the terms are in the quote artifact. Nothing ran and nothing touched the chain.`, undefined, t.task.id, t.task.contextId));
  }

  /** The tender road: the catalog decides every step as the caller; the task records the decisions. */
  private async takeTender(t: StoredTask, tokenId: string, caller: Caller): Promise<void> {
    const reject = (text: string, data: unknown) => this.setState(this.load(t.task.id) ?? t, "TASK_STATE_REJECTED", agentMessage(text, data, t.task.id, t.task.contextId));
    const cancelled = () => Boolean(this.load(t.task.id)?.cancelRequested);
    const pre = await this.catalog.invoke(this.node, "tender_precheck", { tokenId }, caller, { mode: "act" });
    if (!pre.ok) return reject(`Tender ${tokenId} refused at ${pre.gate}: ${pre.reason}`, { foga: { gate: pre.gate, reason: pre.reason, decisionId: pre.decisionId ?? null } });
    const view = (pre.output as { tender: { task: { skill: string; input: unknown } | null } }).tender;
    if (!view.task) return reject(`Tender ${tokenId} has no readable task document`, { foga: { gate: "input" } });
    if (cancelled()) return this.setState(this.load(t.task.id)!, "TASK_STATE_CANCELED", agentMessage("Cancelled before the run.", undefined, t.task.id, t.task.contextId));
    const run = await this.catalog.invoke(this.node, "skill_run", { skill: view.task.skill, input: view.task.input, tokenId }, caller, { mode: "act" });
    if (!run.ok) return reject(`The run for tender ${tokenId} was refused at ${run.gate}: ${run.reason}`, { foga: { gate: run.gate, reason: run.reason, decisionId: run.decisionId ?? null } });
    const stored = this.load(t.task.id) ?? t;
    stored.jobs.run = run.jobId;
    this.save(stored);
    if (cancelled()) return this.setState(this.load(t.task.id)!, "TASK_STATE_CANCELED", agentMessage("Cancelled before the submission.", undefined, t.task.id, t.task.contextId));
    const out = run.output as { resultHash: string; runReceipt: unknown; answerHash: string };
    const sub = await this.catalog.invoke(this.node, "tender_submit", { tokenId, resultHash: out.resultHash, runReceipt: out.runReceipt }, caller, { mode: "act" });
    const latest = this.load(t.task.id) ?? t;
    if (!sub.ok) {
      latest.jobs.submit = sub.jobId;
      this.save(latest);
      return reject(`The submission for tender ${tokenId} was refused at ${sub.gate}: ${sub.reason}`, { foga: { gate: sub.gate, reason: sub.reason, decisionId: sub.decisionId ?? null, jobId: sub.jobId ?? null } });
    }
    latest.jobs.submit = sub.jobId;
    const result = sub.output as { submissionId?: string; txHash?: string };
    latest.task.artifacts = [{ artifactId: randomUUID(), name: "submission", description: "The cell's submission on the tender", parts: [{ data: { foga: { tokenId, resultHash: out.resultHash, answerHash: out.answerHash, submissionId: result.submissionId ?? null, txHash: result.txHash ?? null, jobId: sub.jobId, decisionId: sub.decisionId ?? null, operations: sub.operations ?? [] } }, mediaType: "application/json" }] }];
    this.setState(latest, "TASK_STATE_COMPLETED", agentMessage(`Tender ${tokenId} submitted (job ${sub.jobId}); the node settles it once the chain allows.`, undefined, t.task.id, t.task.contextId));
  }

  // ---------------------------------------------------------------------------- GetTask, ListTasks, CancelTask

  getTask(params: GetTaskRequest, caller: Caller): Task {
    if (!params || typeof params.id !== "string") throw new A2AError(A2A_ERRORS.InvalidParamsError, "Invalid parameters", [{ "@type": "type.googleapis.com/google.rpc.BadRequest", fieldViolations: [{ field: "id", description: "the task id is required" }] }]);
    const t = this.load(params.id);
    if (!t || !this.visible(t, caller)) throw new A2AError(A2A_ERRORS.TaskNotFoundError, "Task not found", [errorInfo("TASK_NOT_FOUND", { taskId: params.id })]);
    return this.publicTask(t, params.historyLength);
  }

  listTasks(params: ListTasksRequest, caller: Caller): ListTasksResponse {
    const all = Object.values(this.store.facts(TASK_PREFIX)) as StoredTask[];
    let tasks = all.filter((t) => this.visible(t, caller));
    if (params.contextId) tasks = tasks.filter((t) => t.task.contextId === params.contextId);
    if (params.status) tasks = tasks.filter((t) => t.task.status.state === params.status);
    if (params.statusTimestampAfter) tasks = tasks.filter((t) => (t.task.status.timestamp ?? "") > params.statusTimestampAfter!);
    tasks.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    const pageSize = Math.min(100, Math.max(1, params.pageSize ?? 50));
    const offset = params.pageToken ? Number(params.pageToken) || 0 : 0;
    const page = tasks.slice(offset, offset + pageSize);
    return { tasks: page.map((t) => this.publicTask(t, params.historyLength, params.includeArtifacts ?? false)), nextPageToken: offset + pageSize < tasks.length ? String(offset + pageSize) : "", pageSize, totalSize: tasks.length };
  }

  async cancelTask(params: CancelTaskRequest, caller: Caller): Promise<Task> {
    if (!params || typeof params.id !== "string") throw new A2AError(A2A_ERRORS.InvalidParamsError, "Invalid parameters");
    const t = this.load(params.id);
    if (!t || !this.visible(t, caller)) throw new A2AError(A2A_ERRORS.TaskNotFoundError, "Task not found", [errorInfo("TASK_NOT_FOUND", { taskId: params.id })]);
    if (TERMINAL_STATES.includes(t.task.status.state)) throw new A2AError(A2A_ERRORS.TaskNotCancelableError, `task ${params.id} is ${t.task.status.state}`, [errorInfo("TASK_NOT_CANCELABLE", { taskId: params.id, state: t.task.status.state })]);
    // a submission on its way to the chain is not undone by a cancellation: what was broadcast stays
    if (t.jobs.submit) throw new A2AError(A2A_ERRORS.TaskNotCancelableError, `task ${params.id} has submitted on chain (job ${t.jobs.submit}); a broadcast is not undone`, [errorInfo("TASK_NOT_CANCELABLE", { taskId: params.id, jobId: t.jobs.submit })]);
    if (t.task.status.state === "TASK_STATE_WORKING") {
      t.cancelRequested = true;
      this.save(t);
      return this.publicTask(t);
    }
    this.setState(t, "TASK_STATE_CANCELED", agentMessage("Cancelled.", undefined, t.task.id, t.task.contextId));
    return this.publicTask(t);
  }

  private publicTask(t: StoredTask, historyLength?: number, artifacts = true): Task {
    const task: Task = { ...t.task };
    if (historyLength !== undefined && task.history) task.history = historyLength <= 0 ? [] : task.history.slice(-historyLength);
    if (!artifacts) delete task.artifacts;
    return task;
  }
}
