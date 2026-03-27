import { EventEmitter } from 'events';
import type {
  OpenClawOptions,
  WsOptions,
  PerceptionEvent,
  PerceptionQueryOptions,
  PerceptionQueryResult,
  PerceptionReportResult,
  PerceptionStat,
  PerceptionIssue,
  UpsertIssueInput,
  ActionRequest,
  ActionResult,
  OpenClawEvents,
} from './types';
import { HttpClient } from './http';
import { WsClient } from './ws';

const DEFAULT_TIMEOUT = 10000;

/**
 * OpenClaw — ClawMark Agent SDK
 *
 * Unified client for the ClawMark Agent Channel API.
 * Provides perception event management (HTTP) and action execution (WebSocket).
 *
 * @example
 * ```typescript
 * const claw = new OpenClaw({
 *   serverUrl: 'https://clawmark.example.com',
 *   agentKey: 'cmak_xxxxxxxxxxxx',
 * });
 *
 * // Report errors
 * await claw.perception.report([
 *   { type: 'runtime-error', message: 'TypeError...', fingerprint: 'abc123' }
 * ]);
 *
 * // Execute browser actions
 * await claw.actions.connect();
 * const result = await claw.actions.execute({ type: 'click', target: '#btn' });
 * ```
 */
export class OpenClaw extends EventEmitter {
  public readonly perception: PerceptionAPI;
  public readonly actions: ActionAPI;
  private readonly http: HttpClient;
  private readonly wsClient: WsClient;

  constructor(options: OpenClawOptions) {
    super();

    if (!options.serverUrl) throw new Error('serverUrl is required');
    if (!options.agentKey) throw new Error('agentKey is required');
    if (!options.agentKey.startsWith('cmak_')) {
      throw new Error('agentKey must start with "cmak_" prefix');
    }

    const timeout = options.timeout ?? DEFAULT_TIMEOUT;

    this.http = new HttpClient({
      serverUrl: options.serverUrl,
      agentKey: options.agentKey,
      timeout,
    });

    this.wsClient = new WsClient(options.serverUrl, options.agentKey);

    // Proxy WS events
    this.wsClient.on('connected', () => this.emit('connected'));
    this.wsClient.on('disconnected', (code: number, reason: string) => this.emit('disconnected', code, reason));
    this.wsClient.on('error', (err: Error) => this.emit('error', err));
    this.wsClient.on('action:queued', (msg) => this.emit('action:queued', msg));
    this.wsClient.on('action:result', (msg) => this.emit('action:result', msg));

    this.perception = new PerceptionAPI(this.http);
    this.actions = new ActionAPI(this.wsClient);
  }

  /** Type-safe event listener */
  on<K extends keyof OpenClawEvents>(event: K, listener: OpenClawEvents[K]): this {
    return super.on(event, listener);
  }

  /** Type-safe event listener (once) */
  once<K extends keyof OpenClawEvents>(event: K, listener: OpenClawEvents[K]): this {
    return super.once(event, listener);
  }
}

/** Perception API — error events, stats, and issues */
class PerceptionAPI {
  constructor(private readonly http: HttpClient) {}

  /** Upload perception events to ClawMark */
  async report(events: PerceptionEvent[]): Promise<PerceptionReportResult> {
    return this.http.reportEvents(events);
  }

  /** Query perception events with cursor-based pagination */
  async query(options?: PerceptionQueryOptions): Promise<PerceptionQueryResult> {
    return this.http.queryEvents(options);
  }

  /** Get aggregated error statistics by fingerprint */
  async stats(limit?: number): Promise<{ stats: PerceptionStat[] }> {
    return this.http.getStats(limit);
  }

  /** Get tracked perception issues */
  async issues(): Promise<{ issues: PerceptionIssue[] }> {
    return this.http.getIssues();
  }

  /** Create or update a tracked perception issue */
  async upsertIssue(input: UpsertIssueInput): Promise<PerceptionIssue> {
    return this.http.upsertIssue(input);
  }
}

/** Action API — browser action execution via WebSocket */
class ActionAPI {
  constructor(private readonly ws: WsClient) {}

  /** Whether the WebSocket is connected */
  get connected(): boolean {
    return this.ws.connected;
  }

  /** Connect to the Action WebSocket */
  async connect(options?: WsOptions): Promise<void> {
    return this.ws.connect();
  }

  /** Disconnect from the Action WebSocket */
  disconnect(): void {
    this.ws.disconnect();
  }

  /**
   * Execute an action in the browser and wait for the result.
   *
   * @example
   * ```typescript
   * const result = await actions.execute({
   *   type: 'click',
   *   target: '#submit-btn',
   *   timeout: 5000,
   * });
   * ```
   */
  async execute(request: ActionRequest): Promise<ActionResult> {
    return this.ws.execute(request);
  }
}
