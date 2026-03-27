// ──────────────────────────────────────────────
// OpenClaw SDK — Type Definitions
// ──────────────────────────────────────────────

/** SDK configuration */
export interface OpenClawOptions {
  /** ClawMark server URL (e.g. "https://clawmark.example.com") */
  serverUrl: string;
  /** Agent API key (cmak_ prefix) */
  agentKey: string;
  /** Request timeout in ms (default: 10000) */
  timeout?: number;
}

/** WebSocket connection options */
export interface WsOptions {
  /** Auto-reconnect on disconnect (default: true) */
  autoReconnect?: boolean;
  /** Max reconnect delay in ms (default: 30000) */
  maxReconnectDelay?: number;
  /** Initial reconnect delay in ms (default: 1000) */
  initialReconnectDelay?: number;
}

// ── Perception ──────────────────────────────

export type PerceptionEventType =
  | 'runtime-error'
  | 'network-error'
  | 'console-error'
  | 'slow-request'
  | 'resource-error'
  | 'long-task'
  | 'unknown';

export type Severity = 'critical' | 'error' | 'warning' | 'info';

export interface PerceptionEvent {
  type?: PerceptionEventType;
  message?: string;
  stack?: string;
  source?: string;
  line?: number;
  severity?: Severity;
  url?: string;
  fingerprint: string;
  context?: Record<string, unknown>;
}

export interface StoredPerceptionEvent extends PerceptionEvent {
  id: string;
  app_id: string;
  agent_id: string | null;
  created_at: string;
}

export interface PerceptionQueryOptions {
  cursor?: string;
  limit?: number;
  agent_id?: string;
  severity?: Severity;
  url?: string;
  since?: string;
  until?: string;
}

export interface PerceptionQueryResult {
  events: StoredPerceptionEvent[];
  cursor: string | null;
  count: number;
}

export interface PerceptionReportResult {
  created: number;
  events: StoredPerceptionEvent[];
}

export interface PerceptionStat {
  fingerprint: string;
  type: string;
  message: string;
  count: number;
  first_seen: string;
  last_seen: string;
}

export interface PerceptionIssue {
  fingerprint: string;
  count: number;
  first_seen: string;
  last_seen: string;
  gitlab_issue_id?: string;
  gitlab_issue_url?: string;
}

export interface UpsertIssueInput {
  fingerprint: string;
  count?: number;
  first_seen?: string;
  last_seen?: string;
  gitlab_issue_id?: string;
  gitlab_issue_url?: string;
}

// ── Actions ─────────────────────────────────

export type ActionType = 'click' | 'type' | 'navigate' | 'screenshot' | 'scroll' | 'form-fill';

export interface ActionRequest {
  type: ActionType;
  target?: string;
  value?: string;
  timeout?: number;
  options?: Record<string, unknown>;
  session_id?: string;
}

export interface ActionResult {
  action_id: string;
  action_type: ActionType;
  status: 'completed' | 'failed';
  result: unknown;
  error: string | null;
}

export interface ActionQueuedResponse {
  action_id: string;
  status: 'queued';
}

// ── WebSocket messages ──────────────────────

export interface WsConnectedMessage {
  type: 'connected';
  role: string;
  app_id: string;
}

export interface WsActionQueuedMessage {
  type: 'action_queued';
  action_id: string;
  status: 'queued';
}

export interface WsResultMessage {
  type: 'result';
  action_id: string;
  action_type: ActionType;
  status: 'completed' | 'failed';
  result: unknown;
  error: string | null;
}

export interface WsErrorMessage {
  type: 'error';
  error: string;
}

export type WsIncomingMessage =
  | WsConnectedMessage
  | WsActionQueuedMessage
  | WsResultMessage
  | WsErrorMessage;

// ── Events ──────────────────────────────────

export interface OpenClawEvents {
  connected: () => void;
  disconnected: (code: number, reason: string) => void;
  error: (error: Error) => void;
  'action:queued': (msg: WsActionQueuedMessage) => void;
  'action:result': (msg: WsResultMessage) => void;
}
