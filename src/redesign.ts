import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
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
};

type AiGatewayUsage = {
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
const DEFAULT_GITHUB_OWNER = "redesign-business";
const DEFAULT_BASE_DOMAIN = "redesign.business";
const DEFAULT_AI_GATEWAY_BUDGET = 1;

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

async function streamUntilFinished(command: Command, startedAt: number) {
  const logsAbort = new AbortController();
  let output = "";
  let lastLogAt = Date.now();
  const waitPromise = command.wait();
  const heartbeat = setInterval(() => {
    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    const quietFor = Math.round((Date.now() - lastLogAt) / 1000);
    console.log(`\nStatus: still running (${elapsed}s elapsed, last output ${quietFor}s ago)`);
  }, 30_000);

  const logsPromise = (async () => {
    try {
      for await (const log of command.logs({ signal: logsAbort.signal })) {
        lastLogAt = Date.now();
        output += log.data;
        const stream = log.stream === "stderr" ? process.stderr : process.stdout;
        stream.write(log.data);
      }
    } catch (error) {
      if (!logsAbort.signal.aborted) {
        console.error(`\nLog stream failed; still waiting for OpenCode result. ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  })();

  let finished: CommandFinished;
  try {
    finished = await waitPromise;
  } finally {
    logsAbort.abort();
    clearInterval(heartbeat);
    await logsPromise;
  }

  return { output, finished };
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

function utcDate(ms: number) {
  return new Date(ms).toISOString().slice(0, 10);
}

async function queryAiGatewayUsage(apiKey: string, apiKeyName: string, startMs: number, endMs: number) {
  const params = new URLSearchParams({
    start_date: utcDate(startMs),
    end_date: utcDate(endMs),
    group_by: "api_key_name",
  });

  const response = await fetch(`https://ai-gateway.vercel.sh/v1/report?${params}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!response.ok) return undefined;

  const json = await response.json() as {
    results?: Array<{
      api_key_name?: string;
      total_cost?: number;
      market_cost?: number;
      input_tokens?: number;
      output_tokens?: number;
      cached_input_tokens?: number;
      cache_creation_input_tokens?: number;
      reasoning_tokens?: number;
      request_count?: number;
    }>;
  };
  const row = json.results?.find((result) => result.api_key_name === apiKeyName);
  if (!row) return undefined;

  return {
    totalCost: row.total_cost ?? 0,
    marketCost: row.market_cost ?? 0,
    inputTokens: row.input_tokens ?? 0,
    outputTokens: row.output_tokens ?? 0,
    cachedInputTokens: row.cached_input_tokens ?? 0,
    cacheCreationInputTokens: row.cache_creation_input_tokens ?? 0,
    reasoningTokens: row.reasoning_tokens ?? 0,
    requestCount: row.request_count ?? 0,
  } satisfies AiGatewayUsage;
}

async function waitForAiGatewayUsage(apiKey: string, apiKeyName: string, startMs: number, endMs: number) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const usage = await queryAiGatewayUsage(apiKey, apiKeyName, startMs, endMs);
    if (usage) return usage;
    console.log(`Waiting for AI Gateway usage (${attempt + 1}/20)...`);
    await new Promise((resolve) => setTimeout(resolve, 15_000));
  }
  return undefined;
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

export async function refreshUsage(metricsPath: string) {
  const metrics = JSON.parse(await readFile(metricsPath, "utf8")) as {
    slug: string;
    model: string;
    aiGatewayKeyId?: string;
    aiGatewayKeyName: string;
    startedAt: string;
    endedAt: string;
    [key: string]: unknown;
  };
  if (!metrics.aiGatewayKeyName) throw new Error("Metrics file is missing aiGatewayKeyName");
  if (!metrics.startedAt || !metrics.endedAt) throw new Error("Metrics file is missing start/end times");

  const key = await createAiGatewayKey(`usage-${metrics.slug}`);
  try {
    const usage = await waitForAiGatewayUsage(
      key.key,
      metrics.aiGatewayKeyName,
      Date.parse(metrics.startedAt),
      Date.parse(metrics.endedAt),
    );
    if (!usage) throw new Error("AI Gateway usage still is not available");

    const pricing = await modelPricing(metrics.model);
    const usageTable = usageCostRows(usage, pricing);
    if (metrics.aiGatewayKeyId) await deleteAiGatewayKey(metrics.aiGatewayKeyId);
    const nextMetrics = {
      ...metrics,
      usage,
      pricing,
      usageTable,
      aiGatewayKeyDeletedAt: metrics.aiGatewayKeyId ? new Date().toISOString() : metrics.aiGatewayKeyDeletedAt,
    };
    await writeRunMetrics(metricsPath, nextMetrics);

    console.log(formatUsageTable(usageTable));
    console.log(`Requests: ${usage.requestCount}`);
    console.log(`Vercel reported total: ${money(usage.totalCost)}`);
    return nextMetrics;
  } finally {
    await deleteAiGatewayKey(key.id);
  }
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
      const usage = await waitForAiGatewayUsage(aiGatewayKey.key, aiGatewayKey.name, startMs, endMs);
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
        usage,
        pricing,
        usageTable,
        aiGatewayKeyDeletedAt: usage ? new Date().toISOString() : undefined,
      });
      process.exitCode = finished.exitCode ?? 1;
      console.error(`\nRedesign failed with exit code ${finished.exitCode}. Sandbox left running for inspection: ${sandbox.name}`);
      console.error(outputTail(output));
      if (usage) await deleteAiGatewayKey(aiGatewayKey.id);
      return result;
    }

    const redesignUrl = await aliasRedesignUrl(extractRedesignUrl(output), expectedRedesignUrl, slug);
    const endMs = Date.now();
    const wallTimeSeconds = Math.round((endMs - startMs) / 1000);
    const usage = await waitForAiGatewayUsage(aiGatewayKey.key, aiGatewayKey.name, startMs, endMs);
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
      usage,
      pricing,
      usageTable,
      aiGatewayKeyDeletedAt: usage ? new Date().toISOString() : undefined,
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
      console.log(`Requests: ${usage.requestCount}`);
      console.log(`Vercel reported total: ${money(usage.totalCost)}`);
    } else {
      console.log("AI Gateway usage: unavailable after waiting 5 minutes");
      console.log("AI Gateway key kept for later usage refresh.");
    }
    console.log(`AI Gateway budget: $${aiGatewayKey.budget}`);
    console.log(`Metrics: ${metricsPath}`);

    if (usage) await deleteAiGatewayKey(aiGatewayKey.id);
    return result;
  } catch (error) {
    await deleteAiGatewayKey(aiGatewayKey.id);
    if (sandbox) console.error(`Sandbox left running for inspection: ${sandbox.name}`);
    throw error;
  }
}

export async function continueRedesign(previousMetricsPath: string): Promise<RedesignResult> {
  const previous = await readRunMetrics(previousMetricsPath);
  if (previous.status === "succeeded") {
    throw new Error(`Run already succeeded: ${previous.redesignUrl ?? previous.expectedRedesignUrl}`);
  }

  const model = gatewayModelFromInput(previous.model);
  const opencodeModel = opencodeModelForGatewayModel(model);
  const budget = Number(previous.aiGatewayBudget || DEFAULT_AI_GATEWAY_BUDGET);
  const startMs = Date.now();
  const metricsPath = join(process.cwd(), "runs", `${new Date(startMs).toISOString().replace(/[:.]/g, "-")}-${previous.slug}-continue.json`);
  const aiGatewayKey = await createAiGatewayKey(`${previous.slug}-continue`, budget);

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
  };

  try {
    const sandbox = await Sandbox.get({ name: previous.sandbox });
    await sandbox.runCommand("bash", ["-lc", "pkill -f '[o]pencode' || true"]);

    const command = await sandbox.runCommand({
      cmd: OPENCODE_BIN,
      args: ["run", "continue", "--continue", "--auto", "--dir", WORKDIR, "--model", opencodeModel],
      detached: true,
      env: {
        AI_GATEWAY_API_KEY: aiGatewayKey.key,
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
      aiGatewayKeyId: aiGatewayKey.id,
      aiGatewayKeyName: aiGatewayKey.name,
      startedAt: new Date(startMs).toISOString(),
      status: "running",
    });

    console.log(JSON.stringify(result, null, 2));

    const { output, finished } = await streamUntilFinished(command, startMs);
    const endMs = Date.now();
    const usage = await waitForAiGatewayUsage(aiGatewayKey.key, aiGatewayKey.name, startMs, endMs);
    const pricing = usage ? await modelPricing(model) : undefined;
    const usageTable = usage && pricing ? usageCostRows(usage, pricing) : undefined;
    const terminalMetrics = {
      ...result,
      previousMetricsPath,
      previousCommand: previous.command,
      aiGatewayKeyId: aiGatewayKey.id,
      aiGatewayKeyName: aiGatewayKey.name,
      startedAt: new Date(startMs).toISOString(),
      endedAt: new Date(endMs).toISOString(),
      wallTimeSeconds: Math.round((endMs - startMs) / 1000),
      status: finished.exitCode === 0 ? "succeeded" : "failed",
      exitCode: finished.exitCode,
      outputTail: finished.exitCode === 0 ? undefined : outputTail(output),
      usage,
      pricing,
      usageTable,
      aiGatewayKeyDeletedAt: usage ? new Date().toISOString() : undefined,
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
      console.log(`Requests: ${usage.requestCount}`);
      console.log(`Vercel reported total: ${money(usage.totalCost)}`);
      await deleteAiGatewayKey(aiGatewayKey.id);
    } else {
      console.log("AI Gateway usage: unavailable after waiting 5 minutes");
      console.log("AI Gateway key kept for later usage refresh.");
    }
    console.log(`AI Gateway budget: $${budget}`);
    console.log(`Metrics: ${metricsPath}`);
    return result;
  } catch (error) {
    const endMs = Date.now();
    await writeRunMetrics(metricsPath, {
      ...result,
      previousMetricsPath,
      previousCommand: previous.command,
      aiGatewayKeyId: aiGatewayKey.id,
      aiGatewayKeyName: aiGatewayKey.name,
      startedAt: new Date(startMs).toISOString(),
      endedAt: new Date(endMs).toISOString(),
      wallTimeSeconds: Math.round((endMs - startMs) / 1000),
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    });
    await deleteAiGatewayKey(aiGatewayKey.id);
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
