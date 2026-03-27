/** Base error for all OpenClaw errors */
export class OpenClawError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OpenClawError';
  }
}

/** Authentication failed (invalid or expired agent key) */
export class AuthError extends OpenClawError {
  public readonly statusCode: number;

  constructor(message = 'Authentication failed') {
    super(message);
    this.name = 'AuthError';
    this.statusCode = 401;
  }
}

/** HTTP request failed */
export class HttpError extends OpenClawError {
  public readonly statusCode: number;
  public readonly body: unknown;

  constructor(statusCode: number, body: unknown) {
    const msg = typeof body === 'object' && body && 'error' in body
      ? (body as { error: string }).error
      : `HTTP ${statusCode}`;
    super(msg);
    this.name = 'HttpError';
    this.statusCode = statusCode;
    this.body = body;
  }
}

/** Rate limit exceeded */
export class RateLimitError extends HttpError {
  constructor(body: unknown) {
    super(429, body);
    this.name = 'RateLimitError';
  }
}

/** Action timed out waiting for result */
export class ActionTimeoutError extends OpenClawError {
  public readonly actionId: string;

  constructor(actionId: string, timeoutMs: number) {
    super(`Action ${actionId} timed out after ${timeoutMs}ms`);
    this.name = 'ActionTimeoutError';
    this.actionId = actionId;
  }
}

/** WebSocket not connected */
export class NotConnectedError extends OpenClawError {
  constructor() {
    super('WebSocket not connected. Call actions.connect() first.');
    this.name = 'NotConnectedError';
  }
}
