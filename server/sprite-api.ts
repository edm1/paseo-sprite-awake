import { stat } from "node:fs/promises";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import type { ClientRequest } from "node:http";

export const SPRITE_SOCKET_PATH = "/.sprite/api.sock";
export const SPRITE_HTTP_HOST = "sprite";
export const TASK_EXPIRY = "5m";
export const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;
export const DEFAULT_HEARTBEAT_MS = 60_000;

export interface HttpResponse {
  statusCode: number;
  headers: IncomingHttpHeaders;
  body: string;
}

export type HttpRequestPort = (input: {
  socketPath: string;
  host: string;
  path: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  timeoutMs: number;
}) => Promise<HttpResponse>;

export interface SpriteTaskPort {
  inspectTask(name: string): Promise<unknown | null>;
  upsertTask(name: string): Promise<void>;
  deleteTask(name: string): Promise<void>;
}

export class SpriteApiError extends Error {
  readonly statusCode: number | undefined;

  constructor(message: string, statusCode?: number) {
    super(message);
    this.name = "SpriteApiError";
    this.statusCode = statusCode;
  }
}

export function createNodeHttpRequest(
  requestFactory: typeof httpRequest = httpRequest,
): HttpRequestPort {
  return (input) => new Promise((resolve, reject) => {
    let settled = false;
    let responseBody = "";
    let req: ClientRequest | null = null;
    let deadlineTimer: ReturnType<typeof setTimeout> | null = null;

    const clearDeadline = (): void => {
      if (deadlineTimer !== null) clearTimeout(deadlineTimer);
      deadlineTimer = null;
    };

    const finishReject = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearDeadline();
      reject(error);
    };

    const finishResolve = (response: HttpResponse): void => {
      if (settled) return;
      settled = true;
      clearDeadline();
      resolve(response);
    };

    try {
      req = requestFactory(
        {
          socketPath: input.socketPath,
          host: input.host,
          path: input.path,
          method: input.method,
          headers: input.headers,
        },
        (res) => {
          res.setEncoding("utf8");
          res.on("data", (chunk: string) => {
            responseBody += chunk;
            if (responseBody.length > 64 * 1024) {
              res.destroy(new Error("Sprite Tasks API response exceeded 64 KiB"));
            }
          });
          res.on("end", () => {
            finishResolve({
              statusCode: res.statusCode ?? 0,
              headers: res.headers,
              body: responseBody,
            });
          });
          res.on("error", finishReject);
        },
      );
    } catch (error) {
      finishReject(error instanceof Error ? error : new Error(String(error)));
      return;
    }

    deadlineTimer = setTimeout(() => {
      const error = new Error(`Sprite Tasks API request timed out after ${input.timeoutMs} ms`);
      req?.destroy(error);
      finishReject(error);
    }, input.timeoutMs);
    try {
      req.on("error", finishReject);
      if (input.body !== undefined) req.write(input.body);
      req.end();
    } catch (error) {
      const requestError = error instanceof Error ? error : new Error(String(error));
      finishReject(requestError);
      req.destroy(requestError);
    }
  });
}

export interface SpriteApiOptions {
  socketPath?: string;
  host?: string;
  timeoutMs?: number;
  request?: HttpRequestPort;
  statSocket?: (path: string) => Promise<{ isSocket(): boolean }>;
}

export type SpriteDetection =
  | { state: "available"; task: unknown | null }
  | { state: "unavailable"; diagnostic: string }
  | { state: "error"; diagnostic: string };

export class SpriteTasksApi implements SpriteTaskPort {
  private readonly socketPath: string;
  private readonly host: string;
  private readonly timeoutMs: number;
  private readonly send: HttpRequestPort;
  private readonly statSocket: NonNullable<SpriteApiOptions["statSocket"]>;

  constructor(options: SpriteApiOptions = {}) {
    this.socketPath = options.socketPath ?? SPRITE_SOCKET_PATH;
    this.host = options.host ?? SPRITE_HTTP_HOST;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.send = options.request ?? createNodeHttpRequest();
    this.statSocket = options.statSocket ?? (async (path) => stat(path));
  }

  async detect(taskName: string): Promise<SpriteDetection> {
    let socketInfo: { isSocket(): boolean };
    try {
      socketInfo = await this.statSocket(this.socketPath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code === "ENOENT" || code === "ENOTDIR") {
        return { state: "unavailable", diagnostic: `Sprite management socket not found at ${this.socketPath}` };
      }
      return { state: "error", diagnostic: `Cannot inspect Sprite management socket: ${errorMessage(error)}` };
    }

    if (!socketInfo.isSocket()) {
      return { state: "error", diagnostic: `${this.socketPath} exists but is not a Unix socket` };
    }

    try {
      const task = await this.inspectTask(taskName);
      return { state: "available", task };
    } catch (error) {
      return { state: "error", diagnostic: `Sprite Tasks API is inaccessible: ${errorMessage(error)}` };
    }
  }

  async inspectTask(name: string): Promise<unknown | null> {
    const response = await this.request("GET", taskPath(name));
    if (response.statusCode === 404) return null;
    this.requireSuccess(response, "inspect task");
    if (!response.body.trim()) return {};
    try {
      return JSON.parse(response.body) as unknown;
    } catch {
      throw new SpriteApiError("Sprite Tasks API returned invalid JSON while inspecting the owned task", response.statusCode);
    }
  }

  async upsertTask(name: string): Promise<void> {
    const response = await this.request("PUT", taskPath(name), JSON.stringify({ expire: TASK_EXPIRY }));
    this.requireSuccess(response, "upsert task");
  }

  async deleteTask(name: string): Promise<void> {
    const response = await this.request("DELETE", taskPath(name));
    if (response.statusCode === 404) return;
    this.requireSuccess(response, "delete task");
  }

  private async request(method: string, path: string, body?: string): Promise<HttpResponse> {
    return this.send({
      socketPath: this.socketPath,
      host: this.host,
      path,
      method,
      headers: body === undefined ? { Host: this.host } : { Host: this.host, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body }),
      timeoutMs: this.timeoutMs,
    });
  }

  private requireSuccess(response: HttpResponse, action: string): void {
    if (response.statusCode < 200 || response.statusCode >= 300) {
      const detail = response.body.trim().slice(0, 500);
      throw new SpriteApiError(
        `Sprite Tasks API failed to ${action}: HTTP ${response.statusCode}${detail ? ` (${detail})` : ""}`,
        response.statusCode,
      );
    }
  }
}

export function taskPath(name: string): string {
  if (!/^[a-zA-Z0-9._-]{1,128}$/.test(name)) throw new Error("Invalid Sprite task name");
  return `/v1/tasks/${encodeURIComponent(name)}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
