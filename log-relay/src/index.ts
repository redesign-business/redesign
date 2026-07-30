import { DurableObject } from "cloudflare:workers";
import { Hono } from "hono";

type Role = "reader" | "writer";
type StreamName = "stdout" | "stderr" | "status";

type LogEvent = {
  seq: number;
  phase?: string;
  stream?: StreamName;
  data: string;
  at: string;
};

type SocketAttachment = {
  role: Role;
};

type StoredBuffer = {
  nextSeq: number;
  messages: LogEvent[];
};

export interface Env {
  LOG_RUNS: DurableObjectNamespace<LogRun>;
  LOG_RELAY_TOKEN: string;
}

const maxBufferMessages = 5_000;
const runIdPattern = /^[a-zA-Z0-9._:-]{1,160}$/;

const app = new Hono<{ Bindings: Env }>();

app.get("/health", (c) => c.json({ ok: true }));

app.get("/runs/:runId", async (c) => {
  if (c.req.header("Upgrade")?.toLowerCase() !== "websocket") {
    return c.text("Expected Upgrade: websocket", 426);
  }

  const role = c.req.query("role");
  if (role !== "reader" && role !== "writer") {
    return c.text("role must be reader or writer", 400);
  }

  if (!c.env.LOG_RELAY_TOKEN || c.req.query("token") !== c.env.LOG_RELAY_TOKEN) {
    return c.text("Unauthorized", 401);
  }

  const runId = c.req.param("runId");
  if (!runIdPattern.test(runId)) {
    return c.text("Invalid run id", 400);
  }

  return c.env.LOG_RUNS.getByName(runId).fetch(c.req.raw);
});

export class LogRun extends DurableObject<Env> {
  private nextSeq = 1;
  private messages: LogEvent[] = [];

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      const saved = await this.ctx.storage.get<StoredBuffer>("buffer");
      this.nextSeq = saved?.nextSeq ?? 1;
      this.messages = saved?.messages ?? [];
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const role = parseRole(url.searchParams.get("role"));
    if (!role) {
      return new Response("role must be reader or writer", { status: 400 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.serializeAttachment({ role } satisfies SocketAttachment);
    this.ctx.acceptWebSocket(server);

    if (role === "reader") {
      const after = parseSeq(url.searchParams.get("after"));
      for (const message of this.messages) {
        if (message.seq > after) {
          server.send(JSON.stringify(message));
        }
      }
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const attachment = ws.deserializeAttachment() as SocketAttachment | null;
    if (attachment?.role !== "writer") {
      return;
    }

    const event = this.toLogEvent(message);
    await this.store(event);
    this.broadcast(event);
  }

  private toLogEvent(message: string | ArrayBuffer): LogEvent {
    const text =
      typeof message === "string" ? message : new TextDecoder().decode(message);
    const parsed = parseIncomingMessage(text);

    return {
      seq: this.nextSeq++,
      phase: stringValue(parsed.phase),
      stream: streamValue(parsed.stream),
      data: stringifyData(parsed.data ?? text),
      at: new Date().toISOString(),
    };
  }

  private async store(message: LogEvent): Promise<void> {
    this.messages.push(message);
    this.messages = this.messages.slice(-maxBufferMessages);
    await this.ctx.storage.put("buffer", {
      nextSeq: this.nextSeq,
      messages: this.messages,
    } satisfies StoredBuffer);
  }

  private broadcast(message: LogEvent): void {
    const payload = JSON.stringify(message);
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as SocketAttachment | null;
      if (attachment?.role === "reader") {
        socket.send(payload);
      }
    }
  }
}

function parseRole(value: string | null): Role | null {
  return value === "reader" || value === "writer" ? value : null;
}

function parseSeq(value: string | null): number {
  const seq = Number(value ?? 0);
  return Number.isSafeInteger(seq) && seq > 0 ? seq : 0;
}

function parseIncomingMessage(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : { data: value };
  } catch {
    return { data: value };
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function streamValue(value: unknown): StreamName | undefined {
  return value === "stdout" || value === "stderr" || value === "status"
    ? value
    : undefined;
}

function stringifyData(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

export default app;
