import type {
  PerceptionEvent,
  PerceptionQueryOptions,
  PerceptionQueryResult,
  PerceptionReportResult,
  PerceptionStat,
  PerceptionIssue,
  UpsertIssueInput,
} from './types';
import { AuthError, HttpError, RateLimitError } from './errors';

interface HttpClientOptions {
  serverUrl: string;
  agentKey: string;
  timeout: number;
}

export class HttpClient {
  private readonly baseUrl: string;
  private readonly agentKey: string;
  private readonly timeout: number;

  constructor(opts: HttpClientOptions) {
    this.baseUrl = opts.serverUrl.replace(/\/+$/, '');
    this.agentKey = opts.agentKey;
    this.timeout = opts.timeout;
  }

  // ── Perception ──────────────────────────────

  /** Upload perception events */
  async reportEvents(events: PerceptionEvent[]): Promise<PerceptionReportResult> {
    return this.post('/api/v2/agent-channel/perception', { events });
  }

  /** Query perception events (cursor-based pagination) */
  async queryEvents(opts: PerceptionQueryOptions = {}): Promise<PerceptionQueryResult> {
    const params = new URLSearchParams();
    if (opts.cursor) params.set('cursor', opts.cursor);
    if (opts.limit) params.set('limit', String(opts.limit));
    if (opts.agent_id) params.set('agent_id', opts.agent_id);
    if (opts.severity) params.set('severity', opts.severity);
    if (opts.url) params.set('url', opts.url);
    if (opts.since) params.set('since', opts.since);
    if (opts.until) params.set('until', opts.until);

    return this.get('/api/v2/agent-channel/perception', params);
  }

  /** Get aggregated error statistics by fingerprint */
  async getStats(limit?: number): Promise<{ stats: PerceptionStat[] }> {
    const params = new URLSearchParams();
    if (limit) params.set('limit', String(limit));
    return this.get('/api/v2/agent-channel/perception/stats', params);
  }

  /** Get tracked perception issues */
  async getIssues(): Promise<{ issues: PerceptionIssue[] }> {
    return this.get('/api/v2/agent-channel/perception/issues');
  }

  /** Upsert a tracked perception issue */
  async upsertIssue(input: UpsertIssueInput): Promise<PerceptionIssue> {
    return this.post('/api/v2/agent-channel/perception/issues', input);
  }

  // ── Internal HTTP helpers ─────────────────

  private async get<T>(path: string, params?: URLSearchParams): Promise<T> {
    const qs = params?.toString();
    const url = `${this.baseUrl}${path}${qs ? `?${qs}` : ''}`;
    return this.request(url, { method: 'GET' });
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    return this.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  private async request<T>(url: string, init: RequestInit): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);

    try {
      const res = await fetch(url, {
        ...init,
        signal: controller.signal,
        headers: {
          'X-Agent-Key': this.agentKey,
          ...init.headers,
        },
      });

      const data = await res.json().catch(() => null);

      if (!res.ok) {
        if (res.status === 401) throw new AuthError();
        if (res.status === 429) throw new RateLimitError(data);
        throw new HttpError(res.status, data);
      }

      return data as T;
    } finally {
      clearTimeout(timer);
    }
  }
}
