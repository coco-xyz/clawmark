import { EventEmitter } from 'events';
import type WebSocket from 'ws';
import type {
  ActionRequest,
  ActionResult,
  WsOptions,
  WsIncomingMessage,
  WsResultMessage,
} from './types';
import { ActionTimeoutError, NotConnectedError } from './errors';

const DEFAULT_WS_OPTIONS: Required<WsOptions> = {
  autoReconnect: true,
  maxReconnectDelay: 30000,
  initialReconnectDelay: 1000,
};

const HEARTBEAT_INTERVAL = 25000; // slightly under server's 30s

interface PendingAction {
  resolve: (result: ActionResult) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class WsClient extends EventEmitter {
  private readonly serverUrl: string;
  private readonly agentKey: string;
  private readonly options: Required<WsOptions>;
  private ws: WebSocket | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private intentionalClose = false;
  private pendingActions = new Map<string, PendingAction>();
  private _connected = false;

  constructor(serverUrl: string, agentKey: string, options?: WsOptions) {
    super();
    this.serverUrl = serverUrl.replace(/\/+$/, '');
    this.agentKey = agentKey;
    this.options = { ...DEFAULT_WS_OPTIONS, ...options };
  }

  get connected(): boolean {
    return this._connected;
  }

  /** Connect to the Action WebSocket */
  async connect(): Promise<void> {
    if (this._connected) return;
    this.intentionalClose = false;

    return new Promise<void>((resolve, reject) => {
      try {
        const wsUrl = this.serverUrl.replace(/^http/, 'ws') + '/ws/agent-channel/actions';

        // Dynamic import for ws (peerDependency)
        let WsConstructor: typeof WebSocket;
        try {
          WsConstructor = require('ws');
        } catch {
          throw new Error('The "ws" package is required. Install it: npm install ws');
        }

        this.ws = new WsConstructor(wsUrl, {
          headers: { 'X-Agent-Key': this.agentKey },
        });

        const onOpen = (): void => {
          // Wait for 'connected' message before resolving
        };

        const onMessage = (raw: Buffer | string): void => {
          const msg = this.parseMessage(raw);
          if (!msg) return;

          if (msg.type === 'connected') {
            this._connected = true;
            this.reconnectAttempts = 0;
            this.startHeartbeat();
            cleanup();
            this.emit('connected');
            resolve();
          }
        };

        const onError = (err: Error): void => {
          cleanup();
          reject(err);
        };

        const onClose = (): void => {
          cleanup();
          reject(new Error('WebSocket closed before connected message'));
        };

        // eslint-disable-next-line @typescript-eslint/no-this-alias
        const self = this;

        function cleanup(): void {
          self.ws?.removeListener('open', onOpen);
          self.ws?.removeListener('message', onMessage);
          self.ws?.removeListener('error', onError);
          self.ws?.removeListener('close', onClose);
        }

        this.ws.on('open', onOpen);
        this.ws.on('message', onMessage);
        this.ws.on('error', onError);
        this.ws.on('close', onClose);

        // After initial setup, attach persistent handlers
        this.ws.once('open', () => {
          this.ws!.on('message', (raw: Buffer | string) => this.handleMessage(raw));
          this.ws!.on('close', (code: number, reason: Buffer) => this.handleClose(code, reason.toString()));
          this.ws!.on('error', (err: Error) => this.emit('error', err));
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  /** Disconnect from the WebSocket */
  disconnect(): void {
    this.intentionalClose = true;
    this.cleanup();
    if (this.ws) {
      this.ws.close(1000, 'client disconnect');
      this.ws = null;
    }
  }

  /**
   * Execute an action and wait for the result.
   * Returns a Promise that resolves when the extension completes the action.
   */
  async execute(request: ActionRequest): Promise<ActionResult> {
    if (!this._connected || !this.ws) {
      throw new NotConnectedError();
    }

    const timeoutMs = request.timeout ?? 30000;

    // Send action to server
    this.ws.send(JSON.stringify({
      type: 'action',
      action_type: request.type,
      payload: {
        target: request.target,
        value: request.value,
        options: request.options,
      },
      session_id: request.session_id,
      timeout_ms: timeoutMs,
    }));

    // Wait for action_queued → then wait for result
    return new Promise<ActionResult>((resolve, reject) => {
      let settled = false;

      const onQueued = (msg: WsIncomingMessage) => {
        if (msg.type !== 'action_queued') return;

        const actionId = msg.action_id;

        const timer = setTimeout(() => {
          this.pendingActions.delete(actionId);
          settle();
          reject(new ActionTimeoutError(actionId, timeoutMs));
        }, timeoutMs + 5000); // slightly over server timeout

        this.pendingActions.set(actionId, {
          resolve: (val) => { settle(); resolve(val); },
          reject: (err) => { settle(); reject(err); },
          timer,
        });
        this.emit('action:queued', msg);
      };

      const onError = (msg: WsIncomingMessage) => {
        if (msg.type !== 'error') return;
        settle();
        reject(new Error(msg.error));
      };

      // If the connection drops before action_queued arrives, reject immediately
      const onDisconnect = () => {
        if (!settled) {
          settle();
          reject(new Error('WebSocket disconnected before action could be queued'));
        }
      };

      const settle = () => {
        if (settled) return;
        settled = true;
        this.removeListener('_ws_message', onQueued);
        this.removeListener('_ws_message', onError);
        this.removeListener('disconnected', onDisconnect);
      };

      this.on('_ws_message', onQueued);
      this.on('_ws_message', onError);
      this.on('disconnected', onDisconnect);
    });
  }

  // ── Internal handlers ─────────────────────

  private parseMessage(raw: Buffer | string): WsIncomingMessage | null {
    try {
      return JSON.parse(raw.toString());
    } catch {
      return null;
    }
  }

  private handleMessage(raw: Buffer | string): void {
    const msg = this.parseMessage(raw);
    if (!msg) return;

    // Emit internal event for execute() to listen on
    this.emit('_ws_message', msg);

    switch (msg.type) {
      case 'result':
        this.handleResult(msg);
        break;
      case 'action_queued':
        // Already handled by execute() via _ws_message
        break;
      case 'error':
        this.emit('error', new Error(msg.error));
        break;
    }
  }

  private handleResult(msg: WsResultMessage): void {
    const pending = this.pendingActions.get(msg.action_id);
    if (pending) {
      clearTimeout(pending.timer);
      this.pendingActions.delete(msg.action_id);

      if (msg.status === 'failed') {
        pending.reject(new Error(msg.error || 'Action failed'));
      } else {
        pending.resolve(msg);
      }
    }

    this.emit('action:result', msg);
  }

  private handleClose(code: number, reason: string): void {
    this._connected = false;
    this.cleanup();

    // Reject all pending actions
    for (const [id, pending] of this.pendingActions) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`WebSocket closed (code=${code})`));
    }
    this.pendingActions.clear();

    this.emit('disconnected', code, reason);

    if (!this.intentionalClose && this.options.autoReconnect) {
      this.scheduleReconnect();
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState === 1) {
        this.ws.send(JSON.stringify({ type: 'pong' }));
      }
    }, HEARTBEAT_INTERVAL);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;

    const delay = Math.min(
      this.options.initialReconnectDelay * Math.pow(2, this.reconnectAttempts),
      this.options.maxReconnectDelay
    );
    this.reconnectAttempts++;

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try {
        await this.connect();
      } catch {
        // connect() failed, handleClose will schedule next reconnect
      }
    }, delay);
  }

  private cleanup(): void {
    this.stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}
