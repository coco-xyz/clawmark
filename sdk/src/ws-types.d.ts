declare module 'ws' {
  import { EventEmitter } from 'events';

  class WebSocket extends EventEmitter {
    static readonly OPEN: number;
    static readonly CLOSED: number;

    constructor(url: string, options?: { headers?: Record<string, string> });

    readyState: number;

    send(data: string | Buffer): void;
    close(code?: number, reason?: string): void;
    ping(): void;

    on(event: 'open', listener: () => void): this;
    on(event: 'close', listener: (code: number, reason: Buffer) => void): this;
    on(event: 'message', listener: (data: Buffer | string) => void): this;
    on(event: 'error', listener: (err: Error) => void): this;
    on(event: 'pong', listener: () => void): this;
    on(event: string, listener: (...args: any[]) => void): this;

    once(event: 'open', listener: () => void): this;
    once(event: string, listener: (...args: any[]) => void): this;

    removeListener(event: string, listener: (...args: any[]) => void): this;
  }

  export = WebSocket;
}
