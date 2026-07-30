import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config as loadEnv } from "dotenv";
import { Command, CommandFinished, Sandbox } from "@vercel/sandbox";

loadEnv({ path: ".env.local", quiet: true });

export type RedesignOptions = {
  site: string;
  slug?: string;
  timeoutMinutes?: number;
  keepSandbox?: boolean;
};

export type RedesignResult = {
  sandbox: string;
  command: string;
  slug: string;
  originalUrl: string;
  repoUrl: string;
  expectedRedesignUrl: string;
  model: string;
  aiGatewayBudget: number;
  metricsPath: string;
  logRelayRunId?: string;
};

type AiGatewayUsage = {
  model?: string;
  totalCost: number;
  marketCost: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheCreationInputTokens: number;
  reasoningTokens: number;
  requestCount: number;
};

type ModelPricing = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};

type RunMetrics = RedesignResult & {
  aiGatewayKeyId?: string;
  aiGatewayKeyName: string;
  startedAt: string;
  endedAt?: string;
  status: "running" | "failed" | "succeeded";
  [key: string]: unknown;
};

const OPENCODE_BIN = "/home/vercel-sandbox/.opencode/node_modules/.bin/opencode";
const WORKDIR = "/vercel/sandbox";
const LOG_RELAY_WRAPPER_PATH = "/tmp/redesign-log-relay-wrapper.mjs";
const DEFAULT_RESEARCH_MODEL = "deepseek/deepseek-v4-pro";
const DEFAULT_DRAFT_MODEL = "openai/gpt-5.6-sol";
const DEFAULT_IMPLEMENTATION_MODEL = "deepseek/deepseek-v4-pro";
const DEFAULT_GITHUB_OWNER = "redesign-business";
const DEFAULT_BASE_DOMAIN = "redesign.business";
const DEFAULT_AI_GATEWAY_BUDGET = 1;
const LOG_STREAM_IDLE_MS = 10_000;
const LOG_RELAY_RECONNECT_MS = 500;

const skillFiles = [
  "nextjs-site-building",
] as const;

const LOG_RELAY_WRAPPER = String.raw`
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

let ws;
let connecting = false;
let closed = false;
const queue = [];

function connect() {
  if (!url || closed || connecting || ws?.readyState === WebSocket.OPEN) return;
  connecting = true;
  const next = new WebSocket(url);
  const timeout = setTimeout(() => {
    try { next.close(); } catch {}
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
    } catch {}
  }
  queue.push(message);
  if (queue.length > 1000) queue.shift();
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
  try { ws?.close(); } catch {}
  process.exit(code ?? 1);
});
`;

export function parseArgs(argv: string[]) {
  const args = new Map<string, string>();
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith("--")) {
      positional.push(key);
      continue;
    }

    const name = key.slice(2);
    if (name === "keep-sandbox") {
      args.set(name, "true");
      continue;
    }

    const value = argv[i + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for ${key}`);
    }

    args.set(name, value);
    i += 1;
  }

  return { args, positional };
}

export function readRequired(args: Map<string, string>, key: string) {
  const value = args.get(key);
  if (!value) throw new Error(`Missing --${key}`);
  return value;
}

export function normalizeHttpUrl(value: string) {
  const withProtocol = /^[a-z]+:\/\//i.test(value) ? value : `https://${value}`;
  const url = new URL(withProtocol);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`Expected http(s) URL: ${value}`);
  }
  return url.toString();
}

export function slugFromUrl(site: string) {
  const host = new URL(site).hostname.replace(/^www\./, "");
  const labels = host.split(".");
  const domainWithoutTld = labels.length > 1 ? labels.slice(0, -1).join(".") : host;
  return domainWithoutTld.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

export function normalizeSlug(slug: string) {
  const normalized = slug.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, "");
  if (!/^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$/.test(normalized)) {
    throw new Error(`Invalid slug: ${slug}`);
  }
  return normalized;
}

export function makeSandboxName(slug: string) {
  return `redesign-${slug.slice(0, 32)}-${randomUUID().slice(0, 8)}`;
}

export function gatewayModelFromInput(model: string) {
  return model.startsWith("vercel/") ? model.slice("vercel/".length) : model;
}

export function opencodeModelForGatewayModel(model: string) {
  return `vercel/${gatewayModelFromInput(model)}`;
}

function modelForContinue(previous: RunMetrics) {
  if (previous.phase === "draft" && typeof previous.draftModel === "string") return gatewayModelFromInput(previous.draftModel);
  if (previous.phase === "implementation" && typeof previous.implementationModel === "string") return gatewayModelFromInput(previous.implementationModel);
  return gatewayModelFromInput(typeof previous.implementationModel === "string" ? previous.implementationModel : previous.model);
}

export function buildResearchPrompt(options: {
  site: string;
  slug: string;
  repoUrl: string;
}) {
  return [
    `Research ${options.site}.`,
    "",
    `Project slug: ${options.slug}`,
    `GitHub repo: ${options.repoUrl}`,
    `Original URL: ${options.site}`,
    "",
    "1) Scrape the URL for copy and images. Put copy in raw.md and images in an images directory. Commit and push.",
    "2) Make a proof.md that directly copies and organizes all the business's demonstrated proof from raw.md. Examples of demonstrated proof are completed work, testimonials, awards, statistics, guarantees, credentials, press, partnerships, and anything the business has or has done that makes a potential customer trust them. Do not invent proof. Commit and push.",
    "",
    "You are done when raw.md, proof.md, and images/ are pushed to GitHub.",
  ].join("\n");
}

export function buildDraftPrompt(options: {
  site: string;
  slug: string;
  repoUrl: string;
}) {
  return [
    "Build the first draft of the website from proof.md, raw.md, and images/.",
    "",
    "Use this local skill file:",
    "1. .opencode/skills/nextjs-site-building/SKILL.md",
    "",
    `Project slug: ${options.slug}`,
    `GitHub repo: ${options.repoUrl}`,
    `Original URL: ${options.site}`,
    "",
    "Task:",
    "Build the site in page.tsx. Use the business's unique proof to inspire the design.",
    "Typical structure: nav, hero, several proof sections, FAQ, final CTA, footer.",
    "No text-only sections except nav, banners, the bar below hero, and footer. Do not repeat images or other media.",
    "There is one CTA; use it everywhere.",
    "",
    "You are done when page.tsx is created. Don't build, commit, or push.",
  ].join("\n");
}

export function buildSitePrompt(options: {
  site: string;
  slug: string;
  repoUrl: string;
  expectedRedesignUrl: string;
}) {
  return [
    "Deploy the existing first-draft website.",
    "",
    `Project slug: ${options.slug}`,
    `GitHub repo: ${options.repoUrl}`,
    `Original URL: ${options.site}`,
    `Expected redesign URL: ${options.expectedRedesignUrl}`,
    "",
    "Task:",
    "Run production build needed to prove the draft compiles.",
    "Commit and push the first complete site to main with: feat: build landing page",
    "Deploy intentionally exactly once with the Vercel CLI after the site is finished. Use the slug as the Vercel project name.",
    `Add ${new URL(options.expectedRedesignUrl).host} to the ${options.slug} Vercel project, then alias the final deployment to ${options.expectedRedesignUrl} with the Vercel CLI. The final Redesign URL must be ${options.expectedRedesignUrl}, not a vercel.app URL.`,
    "",
    "You are done when you have a URL to the landing page.",
  ].join("\n");
}

export function extractRedesignUrl(output: string) {
  const matches = [...output.matchAll(/Redesign URL:\s*(https?:\/\/[^\s]+)/gi)];
  return matches.at(-1)?.[1];
}

export function aliasHostForRedesignUrl(deploymentUrl: string | undefined, expectedRedesignUrl: string) {
  if (!deploymentUrl || deploymentUrl === expectedRedesignUrl || !deploymentUrl.includes(".vercel.app")) {
    return undefined;
  }
  return new URL(expectedRedesignUrl).host;
}

function money(value: number) {
  return `$${value.toFixed(6)}`;
}

function outputTail(output: string, maxChars = 4000) {
  return output.slice(Math.max(0, output.length - maxChars));
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function appendWithoutReplay(output: string, data: string) {
  let overlap = Math.min(output.length, data.length);
  while (overlap > 0 && !output.endsWith(data.slice(0, overlap))) overlap--;
  return data.slice(overlap);
}

type LogRelay = {
  url: string;
  token: string;
  runId: string;
  afterSeq: number;
};

type RelayMessage = {
  seq?: number;
  stream?: "stdout" | "stderr" | "status";
  data?: string;
};

type WebSocketLike = {
  addEventListener: (
    event: "open" | "message" | "error" | "close",
    listener: (event: { data?: string; error?: unknown }) => void,
    options?: { once?: boolean },
  ) => void;
  close: () => void;
};

const WebSocketCtor = globalThis.WebSocket as unknown as {
  new (url: string): WebSocketLike;
};

function logRelayFromEnv(slug: string): LogRelay | undefined {
  const url = process.env.LOG_RELAY_URL;
  const token = process.env.LOG_RELAY_TOKEN;
  if (!url || !token) return undefined;

  return {
    url: url.replace(/\/+$/, ""),
    token,
    runId: `${slug}-${randomUUID().slice(0, 8)}`,
    afterSeq: 0,
  };
}

function logRelaySocketUrl(relay: LogRelay, role: "reader" | "writer", phase?: string) {
  const params = new URLSearchParams({
    role,
    token: relay.token,
  });
  if (role === "reader") params.set("after", String(relay.afterSeq));
  if (phase) params.set("phase", phase);
  return `${relay.url}/runs/${encodeURIComponent(relay.runId)}?${params}`;
}

function logRelayCommandEnv(relay: LogRelay, phase: string) {
  return {
    LOG_RELAY_URL: relay.url,
    LOG_RELAY_TOKEN: relay.token,
    LOG_RELAY_RUN_ID: relay.runId,
    LOG_RELAY_PHASE: phase,
  };
}

function opencodeCommand(args: string[], relay: LogRelay | undefined, phase: string, env?: Record<string, string>) {
  const commandEnv = {
    ...env,
    ...(relay ? logRelayCommandEnv(relay, phase) : {}),
  };

  return {
    cmd: relay ? "node" : OPENCODE_BIN,
    args: relay ? [LOG_RELAY_WRAPPER_PATH, OPENCODE_BIN, ...args] : args,
    detached: true,
    env: Object.keys(commandEnv).length ? commandEnv : undefined,
  };
}

function openRelayReader(relay: LogRelay) {
  return new Promise<WebSocketLike>((resolve, reject) => {
    const ws = new WebSocketCtor(logRelaySocketUrl(relay, "reader"));
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("Log relay connect timeout"));
    }, 5_000);

    ws.addEventListener("open", () => {
      clearTimeout(timer);
      resolve(ws);
    }, { once: true });
    ws.addEventListener("error", (event) => {
      clearTimeout(timer);
      reject(event.error instanceof Error ? event.error : new Error("Log relay connect failed"));
    }, { once: true });
  });
}

function parseRelayMessage(data: string | undefined): RelayMessage | undefined {
  if (!data) return undefined;
  try {
    const parsed = JSON.parse(data) as RelayMessage;
    return typeof parsed.data === "string" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

async function streamFromRelay(relay: LogRelay, finished: () => boolean, write: (data: string, stream?: string) => void) {
  while (!finished()) {
    let sawClose = false;
    try {
      const ws = await openRelayReader(relay);
      ws.addEventListener("message", (event) => {
        const message = parseRelayMessage(event.data);
        if (!message) return;
        if (typeof message.seq === "number") relay.afterSeq = Math.max(relay.afterSeq, message.seq);
        write(message.data ?? "", message.stream);
      });
      await new Promise<void>((resolve) => {
        ws.addEventListener("close", () => {
          sawClose = true;
          resolve();
        }, { once: true });
        ws.addEventListener("error", () => resolve(), { once: true });
        const interval = setInterval(() => {
          if (finished()) {
            clearInterval(interval);
            ws.close();
            resolve();
          }
        }, 250);
      });
    } catch {
      // The command still writes to Vercel logs. Reconnect quickly and fall back later if needed.
    }
    if (!finished() || sawClose) await sleep(LOG_RELAY_RECONNECT_MS);
  }
}

async function waitForCommand(command: Command) {
  while (true) {
    try {
      return await command.wait();
    } catch (error) {
      console.error(`\nCommand status check failed; retrying. ${error instanceof Error ? error.message : String(error)}`);
      await sleep(5_000);
    }
  }
}

async function streamUntilFinished(command: Command, _startedAt: number, relay?: LogRelay) {
  const logsAbort = new AbortController();
  let output = "";
  let finished = false;
  const waitPromise = waitForCommand(command).finally(() => {
    finished = true;
  });

  const write = (data: string, streamName?: string) => {
    const fresh = appendWithoutReplay(output, data);
    if (!fresh) return;
    output += fresh;
    const stream = streamName === "stderr" ? process.stderr : process.stdout;
    stream.write(fresh);
  };

  if (relay) {
    let result: CommandFinished;
    try {
      await Promise.race([
        streamFromRelay(relay, () => finished, write),
        waitPromise,
      ]);
      result = await waitPromise;
    } finally {
      logsAbort.abort();
    }

    try {
      const finalOutput = await command.output("both");
      if (!output) write(finalOutput);
      else if (finalOutput.startsWith(output)) write(finalOutput.slice(output.length));
    } catch {
      // Relay already carried the live output. Command output is only a fallback/catch-up.
    }

    return { output, finished: result };
  }

  const logsPromise = (async () => {
    while (!finished && !logsAbort.signal.aborted) {
      const streamAbort = new AbortController();
      let idleReconnect = false;
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      const resetIdleTimer = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          idleReconnect = true;
          streamAbort.abort("Log stream idle");
        }, LOG_STREAM_IDLE_MS);
      };
      const abortStream = () => streamAbort.abort(logsAbort.signal.reason);
      logsAbort.signal.addEventListener("abort", abortStream, { once: true });
      resetIdleTimer();

      try {
        for await (const log of command.logs({ signal: streamAbort.signal })) {
          resetIdleTimer();
          write(log.data, log.stream);
        }
      } catch (error) {
        if (!logsAbort.signal.aborted && !finished) {
          if (!idleReconnect) {
            console.error(`\nLog stream disconnected; reconnecting. ${error instanceof Error ? error.message : String(error)}`);
          }
          await sleep(2_000);
        }
      } finally {
        if (idleTimer) clearTimeout(idleTimer);
        logsAbort.signal.removeEventListener("abort", abortStream);
      }
      if (!finished && !logsAbort.signal.aborted) await sleep(1_000);
    }
  })();

  let result: CommandFinished;
  try {
    result = await waitPromise;
  } finally {
    logsAbort.abort();
    await logsPromise;
  }

  return { output, finished: result };
}

async function estimateUsageForModel(usage: AiGatewayUsage) {
  const pricing = await modelPricing(usage.model ?? "");
  const totalCost =
    usage.inputTokens * pricing.input +
    usage.outputTokens * pricing.output +
    usage.cachedInputTokens * pricing.cacheRead +
    usage.cacheCreationInputTokens * pricing.cacheWrite;
  return {
    ...usage,
    totalCost,
    marketCost: totalCost,
  };
}

function sumUsage(usages: AiGatewayUsage[]) {
  return usages.reduce((sum, usage) => ({
    totalCost: sum.totalCost + usage.totalCost,
    marketCost: sum.marketCost + usage.marketCost,
    inputTokens: sum.inputTokens + usage.inputTokens,
    outputTokens: sum.outputTokens + usage.outputTokens,
    cachedInputTokens: sum.cachedInputTokens + usage.cachedInputTokens,
    cacheCreationInputTokens: sum.cacheCreationInputTokens + usage.cacheCreationInputTokens,
    reasoningTokens: sum.reasoningTokens + usage.reasoningTokens,
    requestCount: sum.requestCount + usage.requestCount,
  }), {
    totalCost: 0,
    marketCost: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    cacheCreationInputTokens: 0,
    reasoningTokens: 0,
    requestCount: 0,
  } satisfies AiGatewayUsage);
}

async function localCommandOutput(command: string, args: string[]) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(command, args);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk; });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code: number | null) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${command} failed\n${stderr.trim()}`));
    });
  });
}

async function estimateOpenCodeUsage(sandbox: Sandbox, models?: string[]) {
  const dir = await mkdtemp(join(tmpdir(), "redesign-opencode-"));
  try {
    const dbPath = join(dir, "opencode.db");
    const downloaded = await sandbox.downloadFile(
      { path: "/home/vercel-sandbox/.local/share/opencode/opencode.db" },
      { path: dbPath },
    );
    if (!downloaded) return undefined;

    const json = await localCommandOutput("sqlite3", ["-json", dbPath, [
      "select json_extract(model,'$.id') as model,",
      "sum(tokens_input) as input_tokens,",
      "sum(tokens_output) as output_tokens,",
      "sum(tokens_reasoning) as reasoning_tokens,",
      "sum(tokens_cache_read) as cached_input_tokens,",
      "sum(tokens_cache_write) as cache_creation_input_tokens,",
      "count(*) as request_count",
      "from session where model is not null group by 1",
    ].join(" ")]);
    const expected = models ? new Set(models) : undefined;
    const rows = JSON.parse(json) as Array<{
      model?: string;
      input_tokens?: number;
      output_tokens?: number;
      reasoning_tokens?: number;
      cached_input_tokens?: number;
      cache_creation_input_tokens?: number;
      request_count?: number;
    }>;
    const usage = await Promise.all(rows
      .filter((row) => row.model && (!expected || expected.has(row.model)))
      .map((row) => estimateUsageForModel({
        model: row.model,
        totalCost: 0,
        marketCost: 0,
        inputTokens: row.input_tokens ?? 0,
        outputTokens: row.output_tokens ?? 0,
        cachedInputTokens: row.cached_input_tokens ?? 0,
        cacheCreationInputTokens: row.cache_creation_input_tokens ?? 0,
        reasoningTokens: row.reasoning_tokens ?? 0,
        requestCount: row.request_count ?? 0,
      } satisfies AiGatewayUsage)));
    return usage.length ? usage : undefined;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function modelPricing(model: string) {
  const response = await fetch("https://ai-gateway.vercel.sh/v1/models");
  if (!response.ok) throw new Error(`Model pricing lookup failed: ${response.statusText}`);

  const json = await response.json() as {
    data?: Array<{
      id?: string;
      pricing?: {
        input?: string;
        output?: string;
        input_cache_read?: string;
        input_cache_write?: string;
      };
    }>;
  };
  const pricing = json.data?.find((item) => item.id === model)?.pricing;
  if (!pricing?.input || !pricing.output) throw new Error(`No pricing found for ${model}`);

  return {
    input: Number(pricing.input),
    output: Number(pricing.output),
    cacheRead: Number(pricing.input_cache_read ?? 0),
    cacheWrite: Number(pricing.input_cache_write ?? 0),
  } satisfies ModelPricing;
}

async function writeRunMetrics(path: string, data: unknown) {
  await mkdir(join(process.cwd(), "runs"), { recursive: true });
  await writeFile(path, `${JSON.stringify(data, null, 2)}\n`);
}

async function readRunMetrics(path: string) {
  return JSON.parse(await readFile(path, "utf8")) as RunMetrics;
}

function withoutReportedUsage<T extends Record<string, unknown>>(metrics: T) {
  const rest = { ...metrics };
  delete rest.usage;
  delete rest.pricing;
  delete rest.usageTable;
  delete rest.usageByModel;
  delete rest.usageTables;
  delete rest.totalUsage;
  return rest;
}

async function pricingByModel(usages: AiGatewayUsage[]) {
  return Object.fromEntries(await Promise.all(usages.map(async (usage) => [
    usage.model ?? "",
    await modelPricing(usage.model ?? ""),
  ])));
}

export async function refreshUsage(metricsPath: string) {
  const metrics = JSON.parse(await readFile(metricsPath, "utf8")) as {
    sandbox: string;
    slug: string;
    model: string;
    status?: string;
    researchModel?: string;
    draftModel?: string;
    implementationModel?: string;
    aiGatewayKeyId?: string;
    aiGatewayKeyName: string;
    startedAt: string;
    endedAt: string;
    [key: string]: unknown;
  };
  if (!metrics.sandbox) throw new Error("Metrics file is missing sandbox");

  const sandbox = await Sandbox.get({ name: metrics.sandbox });
  const models = [metrics.researchModel, metrics.draftModel, metrics.implementationModel]
    .filter((model): model is string => typeof model === "string");
  if (models.length) {
    const usageByModel = await estimateOpenCodeUsage(sandbox, [...new Set(models)]);
    if (!usageByModel) throw new Error("OpenCode usage is not available");

    const pricing = await pricingByModel(usageByModel);
    const totalUsage = sumUsage(usageByModel);
    const nextMetrics = {
      ...withoutReportedUsage(metrics),
      estimatedUsageByModel: usageByModel,
      estimatedPricingByModel: pricing,
      estimatedTotalUsage: totalUsage,
    };
    await writeRunMetrics(metricsPath, nextMetrics);

    for (const usage of usageByModel) {
      console.log(`\nModel: ${usage.model}`);
      console.log(`Tokens: input ${usage.inputTokens.toLocaleString("en-US")}, output ${usage.outputTokens.toLocaleString("en-US")}, cache read ${usage.cachedInputTokens.toLocaleString("en-US")}, cache write ${usage.cacheCreationInputTokens.toLocaleString("en-US")}`);
      console.log(`OpenCode sessions: ${usage.requestCount}`);
      console.log(`Estimated total: ${money(usage.totalCost)}`);
    }
    console.log(`\nCombined OpenCode sessions: ${totalUsage.requestCount}`);
    console.log(`Combined estimated total: ${money(totalUsage.totalCost)}`);
    return nextMetrics;
  }

  const usage = (await estimateOpenCodeUsage(sandbox, [metrics.model]))?.[0];
  if (!usage) throw new Error("OpenCode usage is not available");

  const pricing = await modelPricing(metrics.model);
  const nextMetrics = {
    ...withoutReportedUsage(metrics),
    estimatedUsage: usage,
    estimatedPricing: pricing,
  };
  await writeRunMetrics(metricsPath, nextMetrics);

  console.log(`Tokens: input ${usage.inputTokens.toLocaleString("en-US")}, output ${usage.outputTokens.toLocaleString("en-US")}, cache read ${usage.cachedInputTokens.toLocaleString("en-US")}, cache write ${usage.cacheCreationInputTokens.toLocaleString("en-US")}`);
  console.log(`OpenCode sessions: ${usage.requestCount}`);
  console.log(`Estimated total: ${money(usage.totalCost)}`);
  return nextMetrics;
}

async function runVercel(args: string[]) {
  const token = process.env.VERCEL_TOKEN;
  if (!token) throw new Error("Missing VERCEL_TOKEN");

  const command = [...args, "--token", token];
  const teamId = process.env.VERCEL_TEAM_ID;
  if (teamId) command.push("--scope", teamId);

  await new Promise<void>((resolve, reject) => {
    const child = spawn("npx", ["vercel", ...command]);
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => { output += chunk; });
    child.stderr.on("data", (chunk: Buffer) => { output += chunk; });
    child.on("error", reject);
    child.on("close", (code: number | null) => {
      if (code === 0) resolve();
      else reject(new Error(`Vercel command failed\n${output.trim()}`));
    });
  });
}

async function aliasRedesignUrl(deploymentUrl: string | undefined, expectedRedesignUrl: string, slug: string) {
  const host = aliasHostForRedesignUrl(deploymentUrl, expectedRedesignUrl);
  if (!host || !deploymentUrl) {
    return expectedRedesignUrl;
  }

  await runVercel(["domains", "add", host, slug, "--force"]);
  await runVercel(["alias", "set", deploymentUrl, host]);

  return expectedRedesignUrl;
}

async function must(command: Awaited<ReturnType<Sandbox["runCommand"]>>, label: string) {
  if (command.exitCode === 0) return;
  throw new Error(`${label} failed\n${await command.output("both")}`);
}

async function createGithubRepo(slug: string) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("Missing GITHUB_TOKEN");

  const owner = process.env.GITHUB_OWNER ?? DEFAULT_GITHUB_OWNER;
  const existing = await fetch(`https://api.github.com/repos/${owner}/${slug}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (existing.ok) {
    const json = await existing.json() as { clone_url?: string; html_url?: string };
    if (json.clone_url && json.html_url) return { cloneUrl: json.clone_url, htmlUrl: json.html_url };
  }

  const orgEndpoint = `https://api.github.com/orgs/${owner}/repos`;
  const userEndpoint = "https://api.github.com/user/repos";
  const endpoint = owner ? orgEndpoint : userEndpoint;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: JSON.stringify({
      name: slug,
      private: false,
      auto_init: true,
      description: `Redesign of ${slug}`,
    }),
  });

  const json = await response.json() as { clone_url?: string; html_url?: string; message?: string };
  if (!response.ok) {
    throw new Error(`GitHub repo create failed: ${json.message ?? response.statusText}`);
  }
  if (!json.clone_url || !json.html_url) throw new Error("GitHub did not return repo URLs");

  return { cloneUrl: json.clone_url, htmlUrl: json.html_url };
}

async function createAiGatewayKey(slug: string, budgetOverride?: number) {
  const token = process.env.VERCEL_TOKEN;
  if (!token) throw new Error("Missing VERCEL_TOKEN");

  const teamId = process.env.VERCEL_TEAM_ID;
  const budget = budgetOverride ?? Number(process.env.AI_GATEWAY_JOB_BUDGET ?? DEFAULT_AI_GATEWAY_BUDGET);
  if (!Number.isFinite(budget) || budget < 1) throw new Error("AI_GATEWAY_JOB_BUDGET must be at least 1");

  const params = new URLSearchParams();
  if (teamId) params.set("teamId", teamId);
  const name = `redesign-${slug}-${Date.now().toString(36)}`;

  const response = await fetch(`https://api.vercel.com/v1/api-keys${params.size ? `?${params}` : ""}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      purpose: "ai-gateway",
      name,
      aiGatewayQuota: { limitAmount: budget, refreshPeriod: "none" },
    }),
  });

  const json = await response.json() as {
    apiKeyString?: string;
    apiKey?: { id?: string };
    id?: string;
    error?: { message?: string };
    message?: string;
  };
  if (!response.ok) {
    throw new Error(`AI Gateway key create failed: ${json.error?.message ?? json.message ?? response.statusText}`);
  }
  const id = json.id ?? json.apiKey?.id;
  if (!json.apiKeyString || !id) throw new Error("Vercel did not return an AI Gateway key");

  return { id, key: json.apiKeyString, name, budget };
}

async function deleteAiGatewayKey(id: string) {
  const token = process.env.VERCEL_TOKEN;
  if (!token) return;

  const params = new URLSearchParams();
  if (process.env.VERCEL_TEAM_ID) params.set("teamId", process.env.VERCEL_TEAM_ID);

  try {
    await fetch(`https://api.vercel.com/v1/api-keys/${id}${params.size ? `?${params}` : ""}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch {
    // Best-effort cleanup. The per-job budget is still the safety rail.
  }
}

async function localSkillCopies() {
  return Promise.all(skillFiles.map(async (name) => ({
    path: `${WORKDIR}/.opencode/skills/${name}/SKILL.md`,
    content: Buffer.from(await readFile(join(process.cwd(), "skills", name, "SKILL.md"), "utf8")),
  })));
}

export async function continueRedesign(previousMetricsPath: string): Promise<RedesignResult> {
  const previous = await readRunMetrics(previousMetricsPath);
  if (previous.status === "succeeded") {
    throw new Error(`Run already succeeded: ${previous.redesignUrl ?? previous.expectedRedesignUrl}`);
  }

  const model = modelForContinue(previous);
  const opencodeModel = opencodeModelForGatewayModel(model);
  const budget = Number(previous.aiGatewayBudget || DEFAULT_AI_GATEWAY_BUDGET);
  const relay = logRelayFromEnv(previous.slug);
  const startMs = Date.now();
  const metricsPath = join(process.cwd(), "runs", `${new Date(startMs).toISOString().replace(/[:.]/g, "-")}-${previous.slug}-continue.json`);
  const aiGatewayKey = previous.aiGatewayKeyDeletedAt ? await createAiGatewayKey(`${previous.slug}-continue`, budget) : undefined;
  const aiGatewayKeyId = aiGatewayKey?.id ?? previous.aiGatewayKeyId;
  const aiGatewayKeyName = aiGatewayKey?.name ?? previous.aiGatewayKeyName;

  const result: RedesignResult = {
    sandbox: previous.sandbox,
    command: "",
    slug: previous.slug,
    originalUrl: previous.originalUrl,
    repoUrl: previous.repoUrl,
    expectedRedesignUrl: previous.expectedRedesignUrl,
    model,
    aiGatewayBudget: budget,
    metricsPath,
    logRelayRunId: relay?.runId,
  };

  try {
    const sandbox = await Sandbox.get({ name: previous.sandbox });
    await sandbox.runCommand("bash", ["-lc", "pkill -f '[o]pencode' || true"]);
    if (relay) {
      await sandbox.writeFiles([{ path: LOG_RELAY_WRAPPER_PATH, content: Buffer.from(LOG_RELAY_WRAPPER) }]);
    }

    const command = await sandbox.runCommand(opencodeCommand(
      ["run", "continue", "--continue", "--auto", "--dir", WORKDIR, "--model", opencodeModel],
      relay,
      "continue",
      {
        ...(aiGatewayKey ? { AI_GATEWAY_API_KEY: aiGatewayKey.key } : {}),
        GITHUB_TOKEN: process.env.GITHUB_TOKEN ?? "",
        GIT_USERNAME: "x-access-token",
        GIT_PASSWORD: process.env.GITHUB_TOKEN ?? "",
        GH_TOKEN: process.env.GITHUB_TOKEN ?? "",
        VERCEL_TOKEN: process.env.VERCEL_TOKEN ?? "",
        VERCEL_TEAM_ID: process.env.VERCEL_TEAM_ID ?? "",
        OPENCODE_DISABLE_AUTOUPDATE: "true",
        OPENCODE_DISABLE_MODELS_FETCH: "true",
      },
    ));
    result.command = command.cmdId;

    await writeRunMetrics(metricsPath, {
      ...result,
      previousMetricsPath,
      previousCommand: previous.command,
      aiGatewayKeyId,
      aiGatewayKeyName,
      startedAt: new Date(startMs).toISOString(),
      status: "running",
    });

    console.log(JSON.stringify(result, null, 2));

    const { output, finished } = await streamUntilFinished(command, startMs, relay);
    const endMs = Date.now();
    const usage = (await estimateOpenCodeUsage(sandbox, [model]))?.[0];
    const pricing = usage ? await modelPricing(model) : undefined;
    const terminalMetrics = {
      ...result,
      previousMetricsPath,
      previousCommand: previous.command,
      aiGatewayKeyId,
      aiGatewayKeyName,
      startedAt: new Date(startMs).toISOString(),
      endedAt: new Date(endMs).toISOString(),
      wallTimeSeconds: Math.round((endMs - startMs) / 1000),
      status: finished.exitCode === 0 ? "succeeded" : "failed",
      exitCode: finished.exitCode,
      outputTail: finished.exitCode === 0 ? undefined : outputTail(output),
      estimatedUsage: usage,
      estimatedPricing: pricing,
      aiGatewayKeyDeletedAt: finished.exitCode === 0 && aiGatewayKey ? new Date().toISOString() : previous.aiGatewayKeyDeletedAt,
    };

    if (finished.exitCode === 0) {
      const redesignUrl = await aliasRedesignUrl(extractRedesignUrl(output), previous.expectedRedesignUrl, previous.slug);
      await writeRunMetrics(metricsPath, { ...terminalMetrics, redesignUrl });
      console.log(`\nOriginal URL: ${previous.originalUrl}`);
      console.log(`Redesign URL: ${redesignUrl}`);
      console.log(`GitHub repo: ${previous.repoUrl}`);
      console.log(`Slug: ${previous.slug}`);
    } else {
      await writeRunMetrics(metricsPath, terminalMetrics);
      process.exitCode = finished.exitCode ?? 1;
      console.error(`\nContinue failed with exit code ${finished.exitCode}. Sandbox left running for inspection: ${previous.sandbox}`);
      console.error(outputTail(output));
    }

    if (usage) {
      console.log(`Tokens: input ${usage.inputTokens.toLocaleString("en-US")}, output ${usage.outputTokens.toLocaleString("en-US")}, cache read ${usage.cachedInputTokens.toLocaleString("en-US")}, cache write ${usage.cacheCreationInputTokens.toLocaleString("en-US")}`);
      console.log(`OpenCode sessions: ${usage.requestCount}`);
      console.log(`Estimated total: ${money(usage.totalCost)}`);
    } else {
      console.log("Estimated usage: unavailable from OpenCode session data");
    }
    if (finished.exitCode === 0 && aiGatewayKey) await deleteAiGatewayKey(aiGatewayKey.id);
    console.log(`AI Gateway budget: $${budget}`);
    console.log(`Metrics: ${metricsPath}`);
    return result;
  } catch (error) {
    const endMs = Date.now();
    await writeRunMetrics(metricsPath, {
      ...result,
      previousMetricsPath,
      previousCommand: previous.command,
      aiGatewayKeyId,
      aiGatewayKeyName,
      startedAt: new Date(startMs).toISOString(),
      endedAt: new Date(endMs).toISOString(),
      wallTimeSeconds: Math.round((endMs - startMs) / 1000),
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

export async function runRedesign(options: RedesignOptions): Promise<RedesignResult> {
  const originalUrl = normalizeHttpUrl(options.site);
  const slug = normalizeSlug(options.slug ?? slugFromUrl(originalUrl));
  const researchModel = DEFAULT_RESEARCH_MODEL;
  const draftModel = DEFAULT_DRAFT_MODEL;
  const implementationModel = DEFAULT_IMPLEMENTATION_MODEL;
  const usageModels = [...new Set([researchModel, draftModel, implementationModel])];
  const baseDomain = process.env.REDESIGN_BASE_DOMAIN ?? DEFAULT_BASE_DOMAIN;
  const expectedRedesignUrl = `https://${slug}.${baseDomain}`;
  const relay = logRelayFromEnv(slug);
  const githubToken = process.env.GITHUB_TOKEN;
  const vercelToken = process.env.VERCEL_TOKEN ?? "";
  const startMs = Date.now();
  const metricsPath = join(process.cwd(), "runs", `${new Date(startMs).toISOString().replace(/[:.]/g, "-")}-${slug}.json`);

  if (!githubToken) throw new Error("Missing GITHUB_TOKEN");

  const aiGatewayKey = await createAiGatewayKey(slug);
  let sandbox: Sandbox | undefined;

  const result: RedesignResult = {
    sandbox: "",
    command: "",
    slug,
    originalUrl,
    repoUrl: "",
    expectedRedesignUrl,
    model: `${researchModel} + ${draftModel} + ${implementationModel}`,
    aiGatewayBudget: aiGatewayKey.budget,
    metricsPath,
    logRelayRunId: relay?.runId,
  };

  try {
    const repo = await createGithubRepo(slug);
    result.repoUrl = repo.htmlUrl;
    sandbox = await Sandbox.create({
      name: makeSandboxName(slug),
      runtime: "node24",
      source: { type: "git", url: repo.cloneUrl, username: "x-access-token", password: githubToken, depth: 1 },
      timeout: (options.timeoutMinutes ?? 90) * 60 * 1000,
      resources: { vcpus: 2 },
      env: {
        AI_GATEWAY_API_KEY: aiGatewayKey.key,
        GITHUB_TOKEN: githubToken,
        GIT_USERNAME: "x-access-token",
        GIT_PASSWORD: githubToken,
        GH_TOKEN: githubToken,
        VERCEL_TOKEN: vercelToken,
        VERCEL_TEAM_ID: process.env.VERCEL_TEAM_ID ?? "",
        OPENCODE_DISABLE_AUTOUPDATE: "true",
        OPENCODE_DISABLE_MODELS_FETCH: "true",
        ...(relay ? {
          LOG_RELAY_URL: relay.url,
          LOG_RELAY_TOKEN: relay.token,
          LOG_RELAY_RUN_ID: relay.runId,
        } : {}),
      },
      tags: { app: "redesign-hosted-2", slug },
    });
    result.sandbox = sandbox.name;

    await must(await sandbox.runCommand("npm", ["install", "--prefix", "/home/vercel-sandbox/.opencode", "opencode-ai@1.18.9"]), "OpenCode install");
    await must(await sandbox.runCommand({
      cmd: "bash",
      args: ["-lc", [
        "git config user.name redesign-hosted-2",
        "git config user.email redesign-hosted-2@users.noreply.github.com",
        "git config credential.helper '!f() { echo username=x-access-token; echo password=$GITHUB_TOKEN; }; f'",
        "git ls-remote origin HEAD >/dev/null",
      ].join(" && ")],
      env: { GITHUB_TOKEN: githubToken },
    }), "git setup");

    await must(await sandbox.runCommand("mkdir", [
      "-p",
      `${WORKDIR}/.opencode/skills/nextjs-site-building`,
      "/home/vercel-sandbox/.config/opencode",
    ]), "mkdir");

    await sandbox.writeFiles([
      ...(await localSkillCopies()),
      {
        path: "/home/vercel-sandbox/.config/opencode/opencode.json",
        content: Buffer.from(JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          enabled_providers: ["vercel"],
          model: opencodeModelForGatewayModel(researchModel),
          provider: {
            vercel: {
              npm: "@ai-sdk/gateway",
              env: ["AI_GATEWAY_API_KEY"],
              options: { apiKey: "{env:AI_GATEWAY_API_KEY}" },
              models: Object.fromEntries(usageModels.map((model) => [model, {}])),
            },
          },
        }, null, 2)),
      },
      ...(relay ? [{
        path: LOG_RELAY_WRAPPER_PATH,
        content: Buffer.from(LOG_RELAY_WRAPPER),
      }] : []),
      {
        path: "/tmp/research-prompt.md",
        content: Buffer.from(buildResearchPrompt({ site: originalUrl, slug, repoUrl: repo.htmlUrl })),
      },
      {
        path: "/tmp/draft-prompt.md",
        content: Buffer.from(buildDraftPrompt({ site: originalUrl, slug, repoUrl: repo.htmlUrl })),
      },
      {
        path: "/tmp/site-prompt.md",
        content: Buffer.from(buildSitePrompt({ site: originalUrl, slug, repoUrl: repo.htmlUrl, expectedRedesignUrl })),
      },
    ]);

    await writeRunMetrics(metricsPath, {
      ...result,
      aiGatewayKeyId: aiGatewayKey.id,
      aiGatewayKeyName: aiGatewayKey.name,
      startedAt: new Date(startMs).toISOString(),
      status: "running",
      phase: "research",
      researchModel,
      draftModel,
      implementationModel,
    });

    console.log(JSON.stringify(result, null, 2));

    const research = await sandbox.runCommand(opencodeCommand(
      ["run", "Follow the attached redesign prompt.", "--auto", "--dir", WORKDIR, "--title", `Research ${slug}`, "--model", opencodeModelForGatewayModel(researchModel), "--file", "/tmp/research-prompt.md"],
      relay,
      "research",
    ));
    result.command = research.cmdId;
    const researchRun = await streamUntilFinished(research, startMs, relay);
    if (researchRun.finished.exitCode !== 0) {
      throw new Error(`Research phase failed with exit code ${researchRun.finished.exitCode}\n${outputTail(researchRun.output)}`);
    }

    await writeRunMetrics(metricsPath, {
      ...result,
      aiGatewayKeyId: aiGatewayKey.id,
      aiGatewayKeyName: aiGatewayKey.name,
      startedAt: new Date(startMs).toISOString(),
      status: "running",
      phase: "draft",
      researchModel,
      draftModel,
      implementationModel,
      researchCommand: research.cmdId,
    });

    const draft = await sandbox.runCommand(opencodeCommand(
      ["run", "git pull --ff-only && follow the attached first-draft prompt.", "--auto", "--dir", WORKDIR, "--title", `Draft ${slug}`, "--model", opencodeModelForGatewayModel(draftModel), "--file", "/tmp/draft-prompt.md"],
      relay,
      "draft",
    ));
    result.command = draft.cmdId;
    const draftRun = await streamUntilFinished(draft, startMs, relay);
    if (draftRun.finished.exitCode !== 0) {
      throw new Error(`Draft phase failed with exit code ${draftRun.finished.exitCode}\n${outputTail(draftRun.output)}`);
    }

    await writeRunMetrics(metricsPath, {
      ...result,
      aiGatewayKeyId: aiGatewayKey.id,
      aiGatewayKeyName: aiGatewayKey.name,
      startedAt: new Date(startMs).toISOString(),
      status: "running",
      phase: "implementation",
      researchModel,
      draftModel,
      implementationModel,
      researchCommand: research.cmdId,
      draftCommand: draft.cmdId,
    });

    const build = await sandbox.runCommand(opencodeCommand(
      ["run", "git pull --ff-only && follow the attached implementation prompt.", "--auto", "--dir", WORKDIR, "--title", `Implement ${slug}`, "--model", opencodeModelForGatewayModel(implementationModel), "--file", "/tmp/site-prompt.md"],
      relay,
      "implementation",
    ));
    result.command = build.cmdId;
    const buildRun = await streamUntilFinished(build, startMs, relay);
    if (buildRun.finished.exitCode !== 0) {
      throw new Error(`Implementation phase failed with exit code ${buildRun.finished.exitCode}\n${outputTail(buildRun.output)}`);
    }

    const redesignUrl = await aliasRedesignUrl(extractRedesignUrl(buildRun.output), expectedRedesignUrl, slug);
    const endMs = Date.now();
    const wallTimeSeconds = Math.round((endMs - startMs) / 1000);
    const usageByModel = await estimateOpenCodeUsage(sandbox, usageModels);
    const pricing = usageByModel ? await pricingByModel(usageByModel) : undefined;
    const totalUsage = usageByModel ? sumUsage(usageByModel) : undefined;

    await writeRunMetrics(metricsPath, {
      ...result,
      aiGatewayKeyId: aiGatewayKey.id,
      aiGatewayKeyName: aiGatewayKey.name,
      startedAt: new Date(startMs).toISOString(),
      endedAt: new Date(endMs).toISOString(),
      wallTimeSeconds,
      status: "succeeded",
      redesignUrl,
      researchModel,
      draftModel,
      implementationModel,
      researchCommand: research.cmdId,
      draftCommand: draft.cmdId,
      implementationCommand: build.cmdId,
      estimatedUsageByModel: usageByModel,
      estimatedPricingByModel: pricing,
      estimatedTotalUsage: totalUsage,
      aiGatewayKeyDeletedAt: new Date().toISOString(),
    });

    if (options.keepSandbox) await sandbox.stop();
    else await sandbox.delete();

    console.log(`\nOriginal URL: ${originalUrl}`);
    console.log(`Redesign URL: ${redesignUrl}`);
    console.log(`GitHub repo: ${repo.htmlUrl}`);
    console.log(`Slug: ${slug}`);
    console.log(`Wall time: ${wallTimeSeconds}s`);
    if (usageByModel && totalUsage) {
      for (const usage of usageByModel) {
        console.log(`\nModel: ${usage.model}`);
        console.log(`Tokens: input ${usage.inputTokens.toLocaleString("en-US")}, output ${usage.outputTokens.toLocaleString("en-US")}, cache read ${usage.cachedInputTokens.toLocaleString("en-US")}, cache write ${usage.cacheCreationInputTokens.toLocaleString("en-US")}`);
        console.log(`OpenCode sessions: ${usage.requestCount}`);
        console.log(`Estimated total: ${money(usage.totalCost)}`);
      }
      console.log(`\nCombined OpenCode sessions: ${totalUsage.requestCount}`);
      console.log(`Combined estimated total: ${money(totalUsage.totalCost)}`);
    } else {
      console.log("Estimated usage: unavailable from OpenCode session data");
    }
    console.log(`AI Gateway budget: $${aiGatewayKey.budget}`);
    console.log(`Metrics: ${metricsPath}`);

    await deleteAiGatewayKey(aiGatewayKey.id);
    return result;
  } catch (error) {
    const endMs = Date.now();
    const usageByModel = sandbox ? await estimateOpenCodeUsage(sandbox, usageModels) : undefined;
    const pricing = usageByModel ? await pricingByModel(usageByModel) : undefined;
    await writeRunMetrics(metricsPath, {
      ...result,
      aiGatewayKeyId: aiGatewayKey.id,
      aiGatewayKeyName: aiGatewayKey.name,
      startedAt: new Date(startMs).toISOString(),
      endedAt: new Date(endMs).toISOString(),
      wallTimeSeconds: Math.round((endMs - startMs) / 1000),
      status: "failed",
      researchModel,
      draftModel,
      implementationModel,
      estimatedUsageByModel: usageByModel,
      estimatedPricingByModel: pricing,
      estimatedTotalUsage: usageByModel ? sumUsage(usageByModel) : undefined,
      error: error instanceof Error ? error.message : String(error),
    });
    if (!sandbox) await deleteAiGatewayKey(aiGatewayKey.id);
    if (sandbox) console.error(`Sandbox left running for inspection: ${sandbox.name}`);
    throw error;
  }
}

export async function commandOutput(sandboxName: string, commandId: string) {
  const sandbox = await Sandbox.get({ name: sandboxName });
  const command = await sandbox.getCommand(commandId);
  return command.output("both");
}

export async function cleanupSandbox(sandboxName: string) {
  const sandbox = await Sandbox.get({ name: sandboxName });
  await sandbox.stop();
  return sandbox.delete();
}
