// @ts-check
import { spawn } from "node:child_process";

const [cmd, ...args] = process.argv.slice(2);
if (!cmd) throw new Error("Missing command");

const relayUrl = process.env.LOG_RELAY_URL?.replace(/\/+$/, "");
const token = process.env.LOG_RELAY_TOKEN;
const runId = process.env.LOG_RELAY_RUN_ID;
const phase = process.env.LOG_RELAY_PHASE;
const url = relayUrl && token && runId
  ? relayUrl + "/runs/" + encodeURIComponent(runId) + "?role=writer&token=" + encodeURIComponent(token)
  : undefined;

/** @type {WebSocket | undefined} */
let ws;
let connecting = false;
let closed = false;
/** @type {Array<{ phase: string | undefined; stream: string; data: string }>} */
const queue = [];

function connect() {
  if (!url || closed || connecting || ws?.readyState === WebSocket.OPEN) return;
  connecting = true;
  const next = new WebSocket(url);
  const timeout = setTimeout(() => {
    try {
      next.close();
    } catch {
      // Ignore close races while reconnecting.
    }
  }, 5_000);

  next.addEventListener("open", () => {
    clearTimeout(timeout);
    connecting = false;
    ws = next;
    while (queue.length && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(queue.shift()));
    }
  }, { once: true });

  next.addEventListener("close", () => {
    clearTimeout(timeout);
    connecting = false;
    if (ws === next) ws = undefined;
    if (!closed) setTimeout(connect, 500);
  });

  next.addEventListener("error", () => {
    clearTimeout(timeout);
    connecting = false;
  });
}

function send(stream, data) {
  if (!url) return;
  const message = { phase, stream, data };
  if (ws?.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify(message));
      return;
    } catch {
      // Queue and reconnect below.
    }
  }
  queue.push(message);
  if (queue.length > 1_000) queue.shift();
  connect();
}

connect();
const child = spawn(cmd, args, { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
child.stdout.on("data", (chunk) => {
  const data = chunk.toString();
  process.stdout.write(data);
  send("stdout", data);
});
child.stderr.on("data", (chunk) => {
  const data = chunk.toString();
  process.stderr.write(data);
  send("stderr", data);
});
child.on("error", (error) => {
  process.stderr.write(error.message + "\n");
  process.exitCode = 1;
});
child.on("close", async (code) => {
  const deadline = Date.now() + 2_000;
  while (queue.length && Date.now() < deadline) {
    connect();
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  closed = true;
  try {
    ws?.close();
  } catch {
    // Process is exiting; nothing useful to recover here.
  }
  process.exit(code ?? 1);
});
