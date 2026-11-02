/**
 * The A2A 1.0 data model, the subset this node implements, in the JSON form the specification prescribes for every
 * binding (camelCase fields, enums as their Protocol Buffer names; `specification/a2a.proto` of the A2A project at
 * 1.0 is the source of these shapes). Nothing here is invented: a field name that is not in the proto is not here.
 */
export type TaskState = "TASK_STATE_UNSPECIFIED" | "TASK_STATE_SUBMITTED" | "TASK_STATE_WORKING" | "TASK_STATE_COMPLETED" | "TASK_STATE_FAILED" | "TASK_STATE_CANCELED" | "TASK_STATE_INPUT_REQUIRED" | "TASK_STATE_REJECTED" | "TASK_STATE_AUTH_REQUIRED";
export const TERMINAL_STATES: TaskState[] = ["TASK_STATE_COMPLETED", "TASK_STATE_FAILED", "TASK_STATE_CANCELED", "TASK_STATE_REJECTED"];

export type Role = "ROLE_UNSPECIFIED" | "ROLE_USER" | "ROLE_AGENT";

/** One of text, raw (base64), url or data; filename and mediaType describe a file or data part. */
export interface Part {
  text?: string;
  raw?: string;
  url?: string;
  data?: unknown;
  metadata?: Record<string, unknown>;
  filename?: string;
  mediaType?: string;
}

export interface Message {
  messageId: string;
  contextId?: string;
  taskId?: string;
  role: Role;
  parts: Part[];
  metadata?: Record<string, unknown>;
  extensions?: string[];
  referenceTaskIds?: string[];
}

export interface Artifact {
  artifactId: string;
  name?: string;
  description?: string;
  parts: Part[];
  metadata?: Record<string, unknown>;
  extensions?: string[];
}

export interface TaskStatus {
  state: TaskState;
  message?: Message;
  /** ISO 8601, UTC. */
  timestamp?: string;
}

export interface Task {
  id: string;
  contextId?: string;
  status: TaskStatus;
  artifacts?: Artifact[];
  history?: Message[];
  metadata?: Record<string, unknown>;
}

export interface SendMessageConfiguration {
  acceptedOutputModes?: string[];
  historyLength?: number;
  returnImmediately?: boolean;
}

export interface SendMessageRequest {
  tenant?: string;
  message: Message;
  configuration?: SendMessageConfiguration;
  metadata?: Record<string, unknown>;
}

export interface SendMessageResponse {
  task?: Task;
  message?: Message;
}

export interface GetTaskRequest {
  tenant?: string;
  id: string;
  historyLength?: number;
}

export interface ListTasksRequest {
  tenant?: string;
  contextId?: string;
  status?: TaskState;
  pageSize?: number;
  pageToken?: string;
  historyLength?: number;
  statusTimestampAfter?: string;
  includeArtifacts?: boolean;
}

export interface ListTasksResponse {
  tasks: Task[];
  nextPageToken: string;
  pageSize: number;
  totalSize: number;
}

export interface CancelTaskRequest {
  tenant?: string;
  id: string;
  metadata?: Record<string, unknown>;
}

export interface AgentInterface {
  url: string;
  protocolBinding: "JSONRPC" | "GRPC" | "HTTP+JSON" | string;
  tenant?: string;
  protocolVersion: string;
}

export interface AgentProvider {
  url: string;
  organization: string;
}

export interface AgentCapabilities {
  streaming?: boolean;
  pushNotifications?: boolean;
  extensions?: { uri: string; description?: string; required?: boolean; params?: Record<string, unknown> }[];
  extendedAgentCard?: boolean;
}

export interface AgentSkill {
  id: string;
  name: string;
  description: string;
  tags: string[];
  examples?: string[];
  inputModes?: string[];
  outputModes?: string[];
  securityRequirements?: SecurityRequirement[];
}

export interface SecurityRequirement {
  schemes: Record<string, { list: string[] }>;
}

export type SecurityScheme =
  | { apiKeySecurityScheme: { description?: string; location: "query" | "header" | "cookie"; name: string } }
  | { httpAuthSecurityScheme: { description?: string; scheme: string; bearerFormat?: string } };

export interface AgentCard {
  name: string;
  description: string;
  supportedInterfaces: AgentInterface[];
  provider?: AgentProvider;
  version: string;
  documentationUrl?: string;
  capabilities: AgentCapabilities;
  securitySchemes?: Record<string, SecurityScheme>;
  securityRequirements?: SecurityRequirement[];
  defaultInputModes: string[];
  defaultOutputModes: string[];
  skills: AgentSkill[];
  iconUrl?: string;
}

/** JSON-RPC error codes of the binding (specification section 5.4 and 9.5). */
export const A2A_ERRORS = {
  JSONParseError: -32700,
  InvalidRequestError: -32600,
  MethodNotFoundError: -32601,
  InvalidParamsError: -32602,
  InternalError: -32603,
  TaskNotFoundError: -32001,
  TaskNotCancelableError: -32002,
  PushNotificationNotSupportedError: -32003,
  UnsupportedOperationError: -32004,
  ContentTypeNotSupportedError: -32005,
  InvalidAgentResponseError: -32006,
  ExtendedAgentCardNotConfiguredError: -32007,
  ExtensionSupportRequiredError: -32008,
  VersionNotSupportedError: -32009,
} as const;

export const A2A_PROTOCOL_VERSION = "1.0";
export const A2A_WELL_KNOWN = "/.well-known/agent-card.json";
