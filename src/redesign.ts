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
  model?: string;
  timeoutMinutes?: number;
  keepSandbox?: boolean;
  agentId?: string;
};

export type HybridRedesignOptions = Omit<RedesignOptions, "model"> & {
  researchModel?: string;
  buildModel?: string;
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
  agentId?: string;
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

type UsageCostRow = {
  type: string;
  tokens: number;
  cost: number;
};

type ModelPricing = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};

type RunMetrics = RedesignResult & {
  agentId?: string;
  aiGatewayKeyId?: string;
  aiGatewayKeyName: string;
  startedAt: string;
  endedAt?: string;
  status: "running" | "failed" | "succeeded";
  [key: string]: unknown;
};

const OPENCODE_BIN = "/home/vercel-sandbox/.opencode/node_modules/.bin/opencode";
const WORKDIR = "/vercel/sandbox";
const DEFAULT_MODEL = "deepseek/deepseek-v4-pro";
const DEFAULT_RESEARCH_MODEL = "deepseek/deepseek-v4-pro";
const DEFAULT_BUILD_MODEL = "openai/gpt-5.6-sol";
const DEFAULT_GITHUB_OWNER = "redesign-business";
const DEFAULT_BASE_DOMAIN = "redesign.business";
const DEFAULT_AI_GATEWAY_BUDGET = 1;
const LOG_STREAM_IDLE_MS = 10_000;

const skillFiles = [
  "nextjs-site-building",
  "refine-landing-page",
  "web-quality-audit",
] as const;

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

export function resolveAgentId(agentId: string | undefined) {
  return agentId === "current" ? process.env.CODEX_THREAD_ID : agentId;
}

function modelForContinue(previous: RunMetrics) {
  return gatewayModelFromInput(typeof previous.buildModel === "string" ? previous.buildModel : previous.model);
}

export function buildPrompt(options: {
  site: string;
  slug: string;
  repoUrl: string;
  expectedRedesignUrl: string;
}) {
  return [
    `redesign ${options.site}.`,
    "",
    "Use these local skill files in order:",
    "1. .opencode/skills/nextjs-site-building/SKILL.md",
    "2. .opencode/skills/refine-landing-page/SKILL.md",
    "3. .opencode/skills/web-quality-audit/SKILL.md",
    "",
    `Project slug: ${options.slug}`,
    `GitHub repo: ${options.repoUrl}`,
    `Original URL: ${options.site}`,
    `Preferred redesign URL: ${options.expectedRedesignUrl}`,
    "",
    "Task:",
    "1) Scrape the URL for copy and images. Put copy in raw.md and images in an images directory.",
    "2) Make a proof.md that directly copies and organizes all the business's demonstrated proof from raw.md. Examples of demonstrated proof are completed work, testimonials, awards, statistics, guarantees, credentials, press, partnerships, and anything the business has or has done that makes a potential customer trust them. Do not invent proof.",
    "3) Build the site. Use the business's unique data to inspire the design. Typical structure: nav, hero, several proof sections, FAQ, final CTA, footer. No text-only sections except nav, banners, the bar below hero, and footer. Do not repeat images or other media. There is one CTA; use it everywhere.",
    "4) Run the refine-landing-page pass.",
    "5) Run the web-quality-audit pass.",
    "6) Automated tests are out of scope for this pilot. Run only the basic production build needed to deploy.",
    "7) Commit and push to main after each major phase, using this history:",
    "   - after raw.md and images/: chore: capture source materials",
    "   - after proof.md: docs: organize proof",
    "   - after the first complete site: feat: build landing page",
    "   - after the refine pass: fix: refine landing page",
    "   - after the audit/build pass: chore: pass audit and build",
    "   If a push fails, stop and fix Git auth before continuing.",
    "8) Deploy intentionally exactly once with the Vercel CLI after the site is finished. Use the slug as the Vercel project name.",
    `9) Add ${new URL(options.expectedRedesignUrl).host} to the ${options.slug} Vercel project, then alias the final deployment to ${options.expectedRedesignUrl} with the Vercel CLI. The final Redesign URL must be ${options.expectedRedesignUrl}, not a vercel.app URL.`,
    "10) Never print secrets, tokens, full environment variables, credential helper output, or auth headers.",
    "",
    "You are done when you have a URL to the landing page.",
    "At the very end, print a short final block with Original URL, Redesign URL, GitHub repo, and slug.",
  ].join("\n");
}

export function buildResearchPrompt(options: {
  site: string;
  slug: string;
  repoUrl: string;
}) {
  return [
    `redesign ${options.site}.`,
    "",
    `Project slug: ${options.slug}`,
    `GitHub repo: ${options.repoUrl}`,
    `Original URL: ${options.site}`,
    "",
    "Task:",
    "1) Scrape the URL for copy and images. Put copy in raw.md and images in an images directory.",
    "2) Make a proof.md that directly copies and organizes all the business's demonstrated proof from raw.md. Examples of demonstrated proof are completed work, testimonials, awards, statistics, guarantees, credentials, press, partnerships, and anything the business has or has done that makes a potential customer trust them. Do not invent proof.",
    "Stop after step 2. Do not build the site. Do not deploy.",
    "Commit and push to main after raw.md/images, then again after proof.md.",
    "Never print secrets, tokens, full environment variables, credential helper output, or auth headers.",
    "",
    "You are done when raw.md, proof.md, and images/ exist and main is pushed to GitHub.",
  ].join("\n");
}

export function buildSitePrompt(options: {
  site: string;
  slug: string;
  repoUrl: string;
  expectedRedesignUrl: string;
}) {
  return [
    "Build the website from the existing handoff files: raw.md, proof.md, and images/.",
    "",
    "Use these local skill files in order:",
    "1. .opencode/skills/nextjs-site-building/SKILL.md",
    "2. .opencode/skills/refine-landing-page/SKILL.md",
    "3. .opencode/skills/web-quality-audit/SKILL.md",
    "",
    `Project slug: ${options.slug}`,
    `GitHub repo: ${options.repoUrl}`,
    `Original URL: ${options.site}`,
    `Preferred redesign URL: ${options.expectedRedesignUrl}`,
    "",
    "Task:",
    "Use raw.md, proof.md, and images/ as the handoff from steps 1-2.",
    "3) Build the site. Use the business's unique data to inspire the design. Typical structure: nav, hero, several proof sections, FAQ, final CTA, footer. No text-only sections except nav, banners, the bar below hero, and footer. Do not repeat images or other media. There is one CTA; use it everywhere.",
    "4) Run the refine-landing-page pass.",
    "5) Run the web-quality-audit pass.",
    "Automated tests are out of scope for this pilot. Run only the basic production build needed to deploy.",
    "Commit and push to main after each major phase, using this history:",
    "   - after the first complete site: feat: build landing page",
    "   - after the refine pass: fix: refine landing page",
    "   - after the audit/build pass: chore: pass audit and build",
    "   If a push fails, stop and fix Git auth before continuing.",
    "Deploy intentionally exactly once with the Vercel CLI after the site is finished. Use the slug as the Vercel project name.",
    `Add ${new URL(options.expectedRedesignUrl).host} to the ${options.slug} Vercel project, then alias the final deployment to ${options.expectedRedesignUrl} with the Vercel CLI. The final Redesign URL must be ${options.expectedRedesignUrl}, not a vercel.app URL.`,
    "Never print secrets, tokens, full environment variables, credential helper output, or auth headers.",
    "",
    "You are done when you have a URL to the landing page.",
    "At the very end, print a short final block with Original URL, Redesign URL, GitHub repo, and slug.",
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

async function streamUntilFinished(command: Command, _startedAt: number) {
  const logsAbort = new AbortController();
  let output = "";
  let finished = false;
  const waitPromise = waitForCommand(command).finally(() => {
    finished = true;
  });

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
          const fresh = appendWithoutReplay(output, log.data);
          if (!fresh) continue;
          output += fresh;
          const stream = log.stream === "stderr" ? process.stderr : process.stdout;
          stream.write(fresh);
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

export function usageCostRows(usage: AiGatewayUsage, pricing: ModelPricing) {
  const rows = [
    { type: "Input", tokens: usage.inputTokens, cost: usage.inputTokens * pricing.input },
    { type: "Output", tokens: usage.outputTokens, cost: usage.outputTokens * pricing.output },
    { type: "Cache read", tokens: usage.cachedInputTokens, cost: usage.cachedInputTokens * pricing.cacheRead },
    { type: "Cache write", tokens: usage.cacheCreationInputTokens, cost: usage.cacheCreationInputTokens * pricing.cacheWrite },
  ];
  return [
    ...rows,
    {
      type: "Total",
      tokens: rows.reduce((sum, row) => sum + row.tokens, 0),
      cost: rows.reduce((sum, row) => sum + row.cost, 0),
    },
  ] satisfies UsageCostRow[];
}

export function formatUsageTable(rows: UsageCostRow[]) {
  const lines = [
    "| Token type | Tokens | Cost |",
    "| --- | ---: | ---: |",
    ...rows.map((row) => `| ${row.type} | ${row.tokens.toLocaleString("en-US")} | ${money(row.cost)} |`),
  ];
  return lines.join("\n");
}

async function usageTablesByModel(usages: AiGatewayUsage[]) {
  return Promise.all(usages.map(async (usage) => {
    const pricing = await modelPricing(usage.model ?? "");
    return { usage, pricing, rows: usageCostRows(usage, pricing) };
  }));
}

async function estimateUsageForModel(usage: AiGatewayUsage) {
  const pricing = await modelPricing(usage.model ?? "");
  const rows = usageCostRows(usage, pricing);
  return {
    ...usage,
    totalCost: rows.at(-1)?.cost ?? 0,
    marketCost: rows.at(-1)?.cost ?? 0,
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

export async function refreshUsage(metricsPath: string) {
  const metrics = JSON.parse(await readFile(metricsPath, "utf8")) as {
    sandbox: string;
    slug: string;
    model: string;
    status?: string;
    researchModel?: string;
    buildModel?: string;
    aiGatewayKeyId?: string;
    aiGatewayKeyName: string;
    startedAt: string;
    endedAt: string;
    [key: string]: unknown;
  };
  if (!metrics.sandbox) throw new Error("Metrics file is missing sandbox");

  const sandbox = await Sandbox.get({ name: metrics.sandbox });
  if (metrics.researchModel && metrics.buildModel) {
    const usageByModel = await estimateOpenCodeUsage(sandbox, [metrics.researchModel, metrics.buildModel]);
    if (!usageByModel) throw new Error("OpenCode usage is not available");

    const usageTables = await usageTablesByModel(usageByModel);
    const totalUsage = sumUsage(usageByModel);
    const nextMetrics = {
      ...withoutReportedUsage(metrics),
      estimatedUsageByModel: usageByModel,
      estimatedUsageTables: usageTables,
      estimatedTotalUsage: totalUsage,
    };
    await writeRunMetrics(metricsPath, nextMetrics);

    for (const table of usageTables) {
      console.log(`\nModel: ${table.usage.model}`);
      console.log(formatUsageTable(table.rows));
      console.log(`OpenCode sessions: ${table.usage.requestCount}`);
      console.log(`Estimated total: ${money(table.usage.totalCost)}`);
    }
    console.log(`\nCombined OpenCode sessions: ${totalUsage.requestCount}`);
    console.log(`Combined estimated total: ${money(totalUsage.totalCost)}`);
    return nextMetrics;
  }

  const usage = (await estimateOpenCodeUsage(sandbox, [metrics.model]))?.[0];
  if (!usage) throw new Error("OpenCode usage is not available");

  const pricing = await modelPricing(metrics.model);
  const usageTable = usageCostRows(usage, pricing);
  const nextMetrics = {
    ...withoutReportedUsage(metrics),
    estimatedUsage: usage,
    estimatedPricing: pricing,
    estimatedUsageTable: usageTable,
  };
  await writeRunMetrics(metricsPath, nextMetrics);

  console.log(formatUsageTable(usageTable));
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

export async function runRedesign(options: RedesignOptions): Promise<RedesignResult> {
  const originalUrl = normalizeHttpUrl(options.site);
  const slug = normalizeSlug(options.slug ?? slugFromUrl(originalUrl));
  const model = gatewayModelFromInput(options.model ?? DEFAULT_MODEL);
  const opencodeModel = opencodeModelForGatewayModel(model);
  const baseDomain = process.env.REDESIGN_BASE_DOMAIN ?? DEFAULT_BASE_DOMAIN;
  const expectedRedesignUrl = `https://${slug}.${baseDomain}`;
  const githubToken = process.env.GITHUB_TOKEN;
  const vercelToken = process.env.VERCEL_TOKEN ?? "";
  const startMs = Date.now();
  const metricsPath = join(process.cwd(), "runs", `${new Date(startMs).toISOString().replace(/[:.]/g, "-")}-${slug}.json`);
  const agentId = resolveAgentId(options.agentId);

  if (!githubToken) throw new Error("Missing GITHUB_TOKEN");

  const aiGatewayKey = await createAiGatewayKey(slug);
  let sandbox: Sandbox | undefined;

  try {
    const repo = await createGithubRepo(slug);
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
      },
      tags: { app: "redesign-hosted-2", slug },
    });

    const prompt = buildPrompt({ site: originalUrl, slug, repoUrl: repo.htmlUrl, expectedRedesignUrl });

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
      `${WORKDIR}/.opencode/skills/refine-landing-page`,
      `${WORKDIR}/.opencode/skills/web-quality-audit`,
      "/home/vercel-sandbox/.config/opencode",
    ]), "mkdir");
    await sandbox.writeFiles([
      ...(await localSkillCopies()),
      {
        path: "/home/vercel-sandbox/.config/opencode/opencode.json",
        content: Buffer.from(JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          enabled_providers: ["vercel"],
          model: opencodeModel,
          provider: {
          vercel: {
            npm: "@ai-sdk/gateway",
            env: ["AI_GATEWAY_API_KEY"],
            options: { apiKey: "{env:AI_GATEWAY_API_KEY}" },
              models: { [model]: {} },
          },
          },
        }, null, 2)),
      },
      {
        path: "/tmp/redesign-prompt.md",
        content: Buffer.from(prompt),
      },
    ]);

    const command = await sandbox.runCommand({
      cmd: OPENCODE_BIN,
      args: ["run", "Follow the attached redesign prompt.", "--auto", "--dir", WORKDIR, "--title", `Redesign ${slug}`, "--model", opencodeModel, "--file", "/tmp/redesign-prompt.md"],
      detached: true,
    });

    const result: RedesignResult = {
      sandbox: sandbox.name,
      command: command.cmdId,
      slug,
      originalUrl,
      repoUrl: repo.htmlUrl,
      expectedRedesignUrl,
      model,
      aiGatewayBudget: aiGatewayKey.budget,
      metricsPath,
      agentId,
    };

    await writeRunMetrics(metricsPath, {
      ...result,
      aiGatewayKeyId: aiGatewayKey.id,
      aiGatewayKeyName: aiGatewayKey.name,
      startedAt: new Date(startMs).toISOString(),
      status: "running",
    });

    console.log(JSON.stringify(result, null, 2));

    const { output, finished } = await streamUntilFinished(command, startMs);
    if (finished.exitCode !== 0) {
      const endMs = Date.now();
      const usage = (await estimateOpenCodeUsage(sandbox, [model]))?.[0];
      const pricing = usage ? await modelPricing(model) : undefined;
      const usageTable = usage && pricing ? usageCostRows(usage, pricing) : undefined;
      await writeRunMetrics(metricsPath, {
        ...result,
        aiGatewayKeyId: aiGatewayKey.id,
        aiGatewayKeyName: aiGatewayKey.name,
        startedAt: new Date(startMs).toISOString(),
        endedAt: new Date(endMs).toISOString(),
        wallTimeSeconds: Math.round((endMs - startMs) / 1000),
        status: "failed",
        exitCode: finished.exitCode,
        outputTail: outputTail(output),
        estimatedUsage: usage,
        estimatedPricing: pricing,
        estimatedUsageTable: usageTable,
      });
      process.exitCode = finished.exitCode ?? 1;
      console.error(`\nRedesign failed with exit code ${finished.exitCode}. Sandbox left running for inspection: ${sandbox.name}`);
      console.error(outputTail(output));
      return result;
    }

    const redesignUrl = await aliasRedesignUrl(extractRedesignUrl(output), expectedRedesignUrl, slug);
    const endMs = Date.now();
    const wallTimeSeconds = Math.round((endMs - startMs) / 1000);
    const usage = (await estimateOpenCodeUsage(sandbox, [model]))?.[0];
    const pricing = usage ? await modelPricing(model) : undefined;
    const usageTable = usage && pricing ? usageCostRows(usage, pricing) : undefined;
    await writeRunMetrics(metricsPath, {
      ...result,
      aiGatewayKeyId: aiGatewayKey.id,
      aiGatewayKeyName: aiGatewayKey.name,
      startedAt: new Date(startMs).toISOString(),
      endedAt: new Date(endMs).toISOString(),
      wallTimeSeconds,
      status: "succeeded",
      redesignUrl,
      estimatedUsage: usage,
      estimatedPricing: pricing,
      estimatedUsageTable: usageTable,
      aiGatewayKeyDeletedAt: new Date().toISOString(),
    });

    if (options.keepSandbox) {
      await sandbox.stop();
    } else {
      await sandbox.delete();
    }

    console.log(`\nOriginal URL: ${originalUrl}`);
    console.log(`Redesign URL: ${redesignUrl}`);
    console.log(`GitHub repo: ${repo.htmlUrl}`);
    console.log(`Slug: ${slug}`);
    console.log(`Wall time: ${wallTimeSeconds}s`);
    if (usageTable && usage) {
      console.log(formatUsageTable(usageTable));
      console.log(`OpenCode sessions: ${usage.requestCount}`);
      console.log(`Estimated total: ${money(usage.totalCost)}`);
    } else {
      console.log("Estimated usage: unavailable from OpenCode session data");
    }
    console.log(`AI Gateway budget: $${aiGatewayKey.budget}`);
    console.log(`Metrics: ${metricsPath}`);

    await deleteAiGatewayKey(aiGatewayKey.id);
    return result;
  } catch (error) {
    if (!sandbox) await deleteAiGatewayKey(aiGatewayKey.id);
    if (sandbox) console.error(`Sandbox left running for inspection: ${sandbox.name}`);
    throw error;
  }
}

export async function continueRedesign(previousMetricsPath: string, options: { agentId?: string } = {}): Promise<RedesignResult> {
  const previous = await readRunMetrics(previousMetricsPath);
  if (previous.status === "succeeded") {
    throw new Error(`Run already succeeded: ${previous.redesignUrl ?? previous.expectedRedesignUrl}`);
  }

  const agentId = resolveAgentId(options.agentId) ?? previous.agentId;
  const model = modelForContinue(previous);
  const opencodeModel = opencodeModelForGatewayModel(model);
  const budget = Number(previous.aiGatewayBudget || DEFAULT_AI_GATEWAY_BUDGET);
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
    agentId,
  };

  try {
    const sandbox = await Sandbox.get({ name: previous.sandbox });
    await sandbox.runCommand("bash", ["-lc", "pkill -f '[o]pencode' || true"]);

    const command = await sandbox.runCommand({
      cmd: OPENCODE_BIN,
      args: ["run", "continue", "--continue", "--auto", "--dir", WORKDIR, "--model", opencodeModel],
      detached: true,
      env: {
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
    });
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

    const { output, finished } = await streamUntilFinished(command, startMs);
    const endMs = Date.now();
    const usage = (await estimateOpenCodeUsage(sandbox, [model]))?.[0];
    const pricing = usage ? await modelPricing(model) : undefined;
    const usageTable = usage && pricing ? usageCostRows(usage, pricing) : undefined;
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
      estimatedUsageTable: usageTable,
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

    if (usageTable && usage) {
      console.log(formatUsageTable(usageTable));
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

export async function runHybridRedesign(options: HybridRedesignOptions): Promise<RedesignResult> {
  const originalUrl = normalizeHttpUrl(options.site);
  const slug = normalizeSlug(options.slug ?? `${slugFromUrl(originalUrl)}-deepseek-sol`);
  const researchModel = gatewayModelFromInput(options.researchModel ?? DEFAULT_RESEARCH_MODEL);
  const buildModel = gatewayModelFromInput(options.buildModel ?? DEFAULT_BUILD_MODEL);
  const baseDomain = process.env.REDESIGN_BASE_DOMAIN ?? DEFAULT_BASE_DOMAIN;
  const expectedRedesignUrl = `https://${slug}.${baseDomain}`;
  const githubToken = process.env.GITHUB_TOKEN;
  const vercelToken = process.env.VERCEL_TOKEN ?? "";
  const startMs = Date.now();
  const metricsPath = join(process.cwd(), "runs", `${new Date(startMs).toISOString().replace(/[:.]/g, "-")}-${slug}.json`);
  const agentId = resolveAgentId(options.agentId);

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
    model: `${researchModel} + ${buildModel}`,
    aiGatewayBudget: aiGatewayKey.budget,
    metricsPath,
    agentId,
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
      `${WORKDIR}/.opencode/skills/refine-landing-page`,
      `${WORKDIR}/.opencode/skills/web-quality-audit`,
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
              models: { [researchModel]: {}, [buildModel]: {} },
            },
          },
        }, null, 2)),
      },
      {
        path: "/tmp/research-prompt.md",
        content: Buffer.from(buildResearchPrompt({ site: originalUrl, slug, repoUrl: repo.htmlUrl })),
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
      buildModel,
    });

    console.log(JSON.stringify(result, null, 2));

    const research = await sandbox.runCommand({
      cmd: OPENCODE_BIN,
      args: ["run", "Follow the attached redesign prompt.", "--auto", "--dir", WORKDIR, "--title", `Research ${slug}`, "--model", opencodeModelForGatewayModel(researchModel), "--file", "/tmp/research-prompt.md"],
      detached: true,
    });
    result.command = research.cmdId;
    const researchRun = await streamUntilFinished(research, startMs);
    if (researchRun.finished.exitCode !== 0) {
      throw new Error(`Research phase failed with exit code ${researchRun.finished.exitCode}\n${outputTail(researchRun.output)}`);
    }

    await writeRunMetrics(metricsPath, {
      ...result,
      aiGatewayKeyId: aiGatewayKey.id,
      aiGatewayKeyName: aiGatewayKey.name,
      startedAt: new Date(startMs).toISOString(),
      status: "running",
      phase: "build",
      researchModel,
      buildModel,
      researchCommand: research.cmdId,
    });

    const build = await sandbox.runCommand({
      cmd: OPENCODE_BIN,
      args: ["run", "Follow the attached redesign prompt.", "--auto", "--dir", WORKDIR, "--title", `Build ${slug}`, "--model", opencodeModelForGatewayModel(buildModel), "--file", "/tmp/site-prompt.md"],
      detached: true,
    });
    result.command = build.cmdId;
    const buildRun = await streamUntilFinished(build, startMs);
    if (buildRun.finished.exitCode !== 0) {
      throw new Error(`Build phase failed with exit code ${buildRun.finished.exitCode}\n${outputTail(buildRun.output)}`);
    }

    const redesignUrl = await aliasRedesignUrl(extractRedesignUrl(buildRun.output), expectedRedesignUrl, slug);
    const endMs = Date.now();
    const wallTimeSeconds = Math.round((endMs - startMs) / 1000);
    const usageByModel = await estimateOpenCodeUsage(sandbox, [researchModel, buildModel]);
    const usageTables = usageByModel ? await usageTablesByModel(usageByModel) : undefined;
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
      buildModel,
      researchCommand: research.cmdId,
      buildCommand: build.cmdId,
      estimatedUsageByModel: usageByModel,
      estimatedUsageTables: usageTables,
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
    if (usageTables && totalUsage) {
      for (const table of usageTables) {
        console.log(`\nModel: ${table.usage.model}`);
        console.log(formatUsageTable(table.rows));
        console.log(`OpenCode sessions: ${table.usage.requestCount}`);
        console.log(`Estimated total: ${money(table.usage.totalCost)}`);
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
    const usageByModel = sandbox ? await estimateOpenCodeUsage(sandbox, [researchModel, buildModel]) : undefined;
    await writeRunMetrics(metricsPath, {
      ...result,
      aiGatewayKeyId: aiGatewayKey.id,
      aiGatewayKeyName: aiGatewayKey.name,
      startedAt: new Date(startMs).toISOString(),
      endedAt: new Date(endMs).toISOString(),
      wallTimeSeconds: Math.round((endMs - startMs) / 1000),
      status: "failed",
      researchModel,
      buildModel,
      estimatedUsageByModel: usageByModel,
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
