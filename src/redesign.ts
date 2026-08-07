import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { config as loadEnv } from "dotenv";
import { Sandbox } from "@vercel/sandbox";
import {
  deleteWebsiteRecord,
  getRunCompletion,
  getWebsite,
  listBusinessesForContactBackfill,
  listExistingRedesigns,
  listRedesignCandidates,
  recordStartedRedesign,
  updateBusinessContactInfo,
  type ExistingRedesignRecord,
  type RedesignCandidateRecord,
} from "./db.js";
import { collectContactInfo } from "./research.js";

loadEnv({ path: ".env.local", quiet: true });

export type RedesignOptions = {
  site: string;
  business?: string;
  businessSlug?: string;
  slug?: string;
  timeoutMinutes?: number;
  attach?: boolean;
};

export type RedesignResult = {
  sandbox: string;
  tmuxSession: string;
  businessId: string;
  websiteId: string;
  runId: string;
  businessName: string;
  businessSlug: string;
  slug: string;
  originalUrl: string;
  repoUrl: string;
  expectedRedesignUrl: string;
  model: string;
  aiGatewayBudget: number;
};

export type DeleteWebsiteResult = {
  slug: string;
  repo: string;
  vercelProject: string;
  deletedRecord: boolean;
};

export type SelectedRedesignCandidate = RedesignCandidateRecord & {
  redesignSlug: string;
};

export type RedesignBatchOptions = {
  limit?: number;
  concurrency?: number;
  launchIntervalMs?: number;
  timeoutMinutes?: number;
};

type AiGatewayKey = {
  id: string;
  key: string;
  name: string;
  budget: number;
};

const WORKDIR = "/vercel/sandbox";
const TMUX_SESSION = "redesign";
const DEFAULT_RESEARCH_MODEL = "deepseek/deepseek-v4-flash-0731";
const DEFAULT_DRAFT_MODEL = "openai/gpt-5.6-sol";
const DEFAULT_IMPLEMENTATION_MODEL = "deepseek/deepseek-v4-flash-0731";
const DEFAULT_GITHUB_OWNER = "redesign-business";
const DEFAULT_BASE_DOMAIN = "redesign.business";
const DEFAULT_POSTHOG_HOST = "https://us.i.posthog.com";
const DEFAULT_AI_GATEWAY_BUDGET = 1;
const DEFAULT_BATCH_CONCURRENCY = 30;
const DEFAULT_BATCH_LAUNCH_INTERVAL_MS = 1_000;
const AI_GATEWAY_KEY_POOL_FILE = process.env.AI_GATEWAY_KEY_POOL_FILE ?? join(process.cwd(), ".data", "ai-gateway-key-pool.json");
const SANDBOX_CLI_VERSION = "3.5.5";
const BLOCKED_MAILBOX = /^(?:privacy|legal|abuse|careers?|jobs?|employment|hr|billing|accounts?|accessibility|webmaster|no-?reply|do-?not-?reply|support|customer-?service|communications?|media|press|marketing|reservations?)$/i;

export function parseArgs(argv: string[]) {
  const args = new Map<string, string>();
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith("--")) {
      positional.push(key);
      continue;
    }

    const value = argv[i + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for ${key}`);
    }

    args.set(key.slice(2), value);
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

export function websiteHost(site: string) {
  return new URL(site).hostname.toLowerCase().replace(/^www\./, "");
}

export function selectRedesignCandidates(
  candidates: RedesignCandidateRecord[],
  existing: ExistingRedesignRecord[],
  limit: number,
): SelectedRedesignCandidate[] {
  const usedHosts = new Set(existing.map(({ sourceUrl }) => websiteHost(sourceUrl)));
  const usedEmails = new Set(existing.flatMap(({ email }) => email ? [email.toLowerCase()] : []));
  const usedSlugs = new Set(existing.map(({ slug }) => slug));
  const selected: SelectedRedesignCandidate[] = [];

  for (const candidate of candidates) {
    if (selected.length >= limit) break;
    const host = websiteHost(candidate.website);
    const email = candidate.email.toLowerCase();
    const [mailbox = "", emailDomain = ""] = email.split("@");
    const sameDomain = host === emailDomain || host.endsWith(`.${emailDomain}`) || emailDomain.endsWith(`.${host}`);
    const redesignSlug = slugFromUrl(candidate.website);
    if (!sameDomain || BLOCKED_MAILBOX.test(mailbox)) continue;
    if (usedHosts.has(host) || usedEmails.has(email) || usedSlugs.has(redesignSlug)) continue;
    usedHosts.add(host);
    usedEmails.add(email);
    usedSlugs.add(redesignSlug);
    selected.push({ ...candidate, redesignSlug });
  }

  return selected;
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

export function postHogPublicEnv(slug: string) {
  return {
    NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN: process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN ?? "",
    NEXT_PUBLIC_POSTHOG_HOST: process.env.NEXT_PUBLIC_POSTHOG_HOST ?? DEFAULT_POSTHOG_HOST,
    NEXT_PUBLIC_REDESIGN_SLUG: slug,
  };
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

  const response = await fetch(`https://api.github.com/orgs/${owner}/repos`, {
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
  if (!response.ok) throw new Error(`GitHub repo create failed: ${json.message ?? response.statusText}`);
  if (!json.clone_url || !json.html_url) throw new Error("GitHub did not return repo URLs");
  return { cloneUrl: json.clone_url, htmlUrl: json.html_url };
}

export function githubRepoFromUrl(repoUrl: string | null | undefined, fallbackSlug: string) {
  const owner = process.env.GITHUB_OWNER ?? DEFAULT_GITHUB_OWNER;
  if (!repoUrl) return { owner, repo: fallbackSlug };

  const ssh = repoUrl.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/);
  if (ssh) return { owner: ssh[1], repo: ssh[2] };

  const url = new URL(repoUrl);
  if (url.hostname !== "github.com") throw new Error(`Expected GitHub repo URL: ${repoUrl}`);
  const [urlOwner, rawRepo] = url.pathname.replace(/^\/|\/$/g, "").split("/");
  if (!urlOwner || !rawRepo) throw new Error(`Expected GitHub repo URL: ${repoUrl}`);
  return { owner: urlOwner, repo: rawRepo.replace(/\.git$/, "") };
}

async function deleteGithubRepo(repoUrl: string | null | undefined, slug: string) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("Missing GITHUB_TOKEN");
  const repo = githubRepoFromUrl(repoUrl, slug);
  const response = await fetch(`https://api.github.com/repos/${repo.owner}/${repo.repo}`, {
    method: "DELETE",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (response.ok || response.status === 404) return `${repo.owner}/${repo.repo}`;
  const json = await response.json().catch(() => ({})) as { message?: string };
  throw new Error(`GitHub repo delete failed: ${json.message ?? response.statusText}`);
}

async function deleteVercelProject(slug: string) {
  const token = process.env.VERCEL_TOKEN;
  if (!token) throw new Error("Missing VERCEL_TOKEN");

  const params = new URLSearchParams();
  if (process.env.VERCEL_TEAM_ID) params.set("teamId", process.env.VERCEL_TEAM_ID);
  const response = await fetch(`https://api.vercel.com/v9/projects/${encodeURIComponent(slug)}${params.size ? `?${params}` : ""}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (response.ok || response.status === 404) return slug;
  const json = await response.json().catch(() => ({})) as { error?: { message?: string }; message?: string };
  throw new Error(`Vercel project delete failed: ${json.error?.message ?? json.message ?? response.statusText}`);
}

async function createAiGatewayKey(slug: string) {
  const token = process.env.VERCEL_TOKEN;
  if (!token) throw new Error("Missing VERCEL_TOKEN");

  const teamId = process.env.VERCEL_TEAM_ID;
  const budget = Number(process.env.AI_GATEWAY_JOB_BUDGET ?? DEFAULT_AI_GATEWAY_BUDGET);
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
  if (!response.ok) throw new Error(`AI Gateway key create failed: ${json.error?.message ?? json.message ?? response.statusText}`);
  const id = json.id ?? json.apiKey?.id;
  if (!json.apiKeyString || !id) throw new Error("Vercel did not return an AI Gateway key");
  return { id, key: json.apiKeyString, name, budget };
}

function aiGatewayQuotaUrl(id: string) {
  const params = new URLSearchParams({ quotaEntityId: `api_key_id_${id}` });
  return `https://ai-gateway.vercel.sh/v1/quotas?${params}`;
}

type AiGatewayQuota = { active?: boolean; currentSpend?: number; limitAmount?: number };

async function getAiGatewayQuota(aiGatewayKey: AiGatewayKey) {
  const response = await fetch(aiGatewayQuotaUrl(aiGatewayKey.id), {
    headers: { Authorization: `Bearer ${aiGatewayKey.key}` },
  });
  if (response.ok) return response.json() as Promise<AiGatewayQuota>;
  const json = await response.json().catch(() => ({})) as { error?: string | { message?: string }; message?: string };
  const message = typeof json.error === "string" ? json.error : json.error?.message;
  throw new Error(`AI Gateway quota check failed: ${message ?? json.message ?? response.statusText}`);
}

async function waitForAiGatewayKey(aiGatewayKey: AiGatewayKey, limitAmount = aiGatewayKey.budget, currentSpend?: number) {
  const deadline = Date.now() + 5 * 60_000;
  while (Date.now() < deadline) {
    const quota = await getAiGatewayQuota(aiGatewayKey).catch((error) => {
      if (error instanceof Error && /not found/i.test(error.message)) return undefined;
      throw error;
    });
    if (quota?.active && quota.limitAmount === limitAmount && (currentSpend === undefined || quota.currentSpend === currentSpend)) return;
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  throw new Error(`AI Gateway quota did not become active for ${aiGatewayKey.name}`);
}

async function aiGatewayKeyIsAvailable(aiGatewayKey: AiGatewayKey) {
  const quota = await getAiGatewayQuota(aiGatewayKey);
  return quota.active === true
    && typeof quota.currentSpend === "number"
    && typeof quota.limitAmount === "number"
    && quota.limitAmount > quota.currentSpend;
}

export async function refillAiGatewayKey(aiGatewayKey: AiGatewayKey) {
  const url = aiGatewayQuotaUrl(aiGatewayKey.id);
  const headers = {
    Authorization: `Bearer ${aiGatewayKey.key}`,
    "Content-Type": "application/json",
  };
  const quota = await getAiGatewayQuota(aiGatewayKey);
  if (typeof quota.currentSpend !== "number") throw new Error(`AI Gateway did not report spend for ${aiGatewayKey.name}`);
  const limitAmount = quota.currentSpend + aiGatewayKey.budget;
  const updated = await fetch(url, {
    method: "PATCH",
    headers,
    body: JSON.stringify({
      active: true,
      limitAmount,
      refreshPeriod: "none",
    }),
  });
  if (!updated.ok) {
    const json = await updated.json().catch(() => ({})) as { error?: string | { message?: string }; message?: string };
    const message = typeof json.error === "string" ? json.error : json.error?.message;
    throw new Error(`AI Gateway quota refill failed: ${message ?? json.message ?? updated.statusText}`);
  }
  await waitForAiGatewayKey(aiGatewayKey, limitAmount);
}

async function createAiGatewayKeyPool(size: number) {
  const keys = await readAiGatewayKeyPool();
  for (let index = keys.length; index < size; index += 1) {
    try {
      keys.push(await createAiGatewayKey(`pool-${index + 1}`));
      await writeAiGatewayKeyPool(keys);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (keys.length && /rate limit|too many requests/i.test(message)) {
        console.warn(`AI Gateway pool has ${keys.length}/${size} keys; key creation is currently rate-limited`);
        break;
      }
      throw error;
    }
  }
  const selected = keys.slice(0, size);
  await Promise.all(selected.map(async (key) => {
    if (!await aiGatewayKeyIsAvailable(key)) await refillAiGatewayKey(key);
  }));
  return selected;
}

async function readAiGatewayKeyPool(): Promise<AiGatewayKey[]> {
  try {
    const value = JSON.parse(await readFile(AI_GATEWAY_KEY_POOL_FILE, "utf8"));
    if (!Array.isArray(value)) throw new Error("expected an array");
    return value as AiGatewayKey[];
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw new Error(`Invalid AI Gateway key pool: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function writeAiGatewayKeyPool(keys: AiGatewayKey[]) {
  await mkdir(dirname(AI_GATEWAY_KEY_POOL_FILE), { recursive: true });
  const temporaryFile = `${AI_GATEWAY_KEY_POOL_FILE}.tmp`;
  await writeFile(temporaryFile, `${JSON.stringify(keys, null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryFile, AI_GATEWAY_KEY_POOL_FILE);
}

async function deleteAiGatewayKey(id: string) {
  const token = process.env.VERCEL_TOKEN;
  if (!token) return;

  const params = new URLSearchParams();
  if (process.env.VERCEL_TEAM_ID) params.set("teamId", process.env.VERCEL_TEAM_ID);
  await fetch(`https://api.vercel.com/v1/api-keys/${id}${params.size ? `?${params}` : ""}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  }).catch(() => {});
}

function runnerEnv(options: {
  aiGatewayKey: AiGatewayKey;
  pooledAiGatewayKey?: boolean;
  githubToken: string;
  originalUrl: string;
  slug: string;
  repoUrl: string;
  expectedRedesignUrl: string;
  startedAt: string;
  sandboxName: string;
  businessId: string;
  runId: string;
}) {
  return {
    AI_GATEWAY_API_KEY: options.aiGatewayKey.key,
    GITHUB_TOKEN: options.githubToken,
    GIT_USERNAME: "x-access-token",
    GIT_PASSWORD: options.githubToken,
    GH_TOKEN: options.githubToken,
    VERCEL_TOKEN: process.env.VERCEL_TOKEN ?? "",
    VERCEL_TEAM_ID: process.env.VERCEL_TEAM_ID ?? "",
    OPENCODE_DISABLE_AUTOUPDATE: "true",
    OPENCODE_DISABLE_MODELS_FETCH: "true",
    REDESIGN_SITE: options.originalUrl,
    REDESIGN_SLUG: options.slug,
    REDESIGN_REPO_URL: options.repoUrl,
    REDESIGN_EXPECTED_URL: options.expectedRedesignUrl,
    REDESIGN_STARTED_AT: options.startedAt,
    REDESIGN_SANDBOX: options.sandboxName,
    REDESIGN_BUSINESS_ID: options.businessId,
    REDESIGN_RUN_ID: options.runId,
    DATABASE_URL: process.env.DATABASE_URL ?? "",
    AI_GATEWAY_KEY_ID: options.aiGatewayKey.id,
    AI_GATEWAY_KEY_NAME: options.aiGatewayKey.name,
    AI_GATEWAY_BUDGET: String(options.aiGatewayKey.budget),
    AI_GATEWAY_KEY_POOLED: String(options.pooledAiGatewayKey === true),
    ...postHogPublicEnv(options.slug),
  };
}

async function uploadRunner(sandbox: Sandbox) {
  await must(await sandbox.runCommand("mkdir", ["-p", "/tmp/redesign-runner/src"]), "runner mkdir");
  await sandbox.writeFiles([
    {
      path: "/tmp/redesign-runner/package.json",
      content: Buffer.from(JSON.stringify({
        type: "module",
        dependencies: {
          "@neondatabase/serverless": "^1.1.0",
          cheerio: "^1.2.0",
          playwright: "1.62.1",
          turndown: "^7.2.4",
          tsx: "^4.20.6",
        },
      }, null, 2)),
    },
    {
      path: "/tmp/redesign-runner/src/cloud-runner.ts",
      content: Buffer.from(await readFile(join(process.cwd(), "src", "cloud-runner.ts"), "utf8")),
    },
    {
      path: "/tmp/redesign-runner/src/db.ts",
      content: Buffer.from(await readFile(join(process.cwd(), "src", "db.ts"), "utf8")),
    },
    {
      path: "/tmp/redesign-runner/src/phase.ts",
      content: Buffer.from(await readFile(join(process.cwd(), "src", "phase.ts"), "utf8")),
    },
    {
      path: "/tmp/redesign-runner/src/research.ts",
      content: Buffer.from(await readFile(join(process.cwd(), "src", "research.ts"), "utf8")),
    },
  ]);
}

async function startTmuxRunner(sandbox: Sandbox, env: Record<string, string>) {
  await must(await sandbox.runCommand({
    cmd: "bash",
    args: ["-lc", [
      "set -euo pipefail",
      "command -v tmux >/dev/null || sudo dnf install -y tmux",
      `tmux kill-session -t ${TMUX_SESSION} 2>/dev/null || true`,
      `tmux new-session -d -s ${TMUX_SESSION} 'cd /tmp/redesign-runner && npm install && npx tsx src/cloud-runner.ts; status=$?; echo; echo "redesign runner exited with status $status"; exit $status'`,
      `tmux set-option -t ${TMUX_SESSION} status off`,
    ].join("\n")],
    env,
  }), "tmux start");
}

async function cloneJobRepo(sandbox: Sandbox, repoUrl: string, githubToken: string) {
  await must(await sandbox.runCommand({
    cmd: "bash",
    args: ["-lc", [
      "set -euo pipefail",
      `find ${WORKDIR} -mindepth 1 -maxdepth 1 -exec rm -rf {} +`,
      "auth=$(printf 'x-access-token:%s' \"$GITHUB_TOKEN\" | base64 | tr -d '\\n')",
      `git -c "http.extraHeader=Authorization: Basic $auth" clone --depth 1 ${JSON.stringify(repoUrl)} ${WORKDIR}`,
    ].join("\n")],
    env: { GITHUB_TOKEN: githubToken },
  }), "job repo clone");
}

async function createJobSandbox(params: { name: string; repoUrl: string; githubToken: string; timeout: number; slug: string }) {
  const common = {
    name: params.name,
    timeout: params.timeout,
    persistent: false,
    resources: { vcpus: 2 },
    tags: { app: "redesign-hosted-2", slug: params.slug },
  };
  if (process.env.REDESIGN_TEMPLATE_SNAPSHOT_ID) {
    const sandbox = await Sandbox.create({
      ...common,
      source: { type: "snapshot", snapshotId: process.env.REDESIGN_TEMPLATE_SNAPSHOT_ID },
    });
    await cloneJobRepo(sandbox, params.repoUrl, params.githubToken);
    return sandbox;
  }
  if (process.env.REDESIGN_TEMPLATE_SANDBOX) {
    const sandbox = await Sandbox.fork({
      ...common,
      sourceSandbox: process.env.REDESIGN_TEMPLATE_SANDBOX,
    });
    await cloneJobRepo(sandbox, params.repoUrl, params.githubToken);
    return sandbox;
  }
  return Sandbox.create({
    ...common,
    runtime: "node24",
    source: { type: "git", url: params.repoUrl, username: "x-access-token", password: params.githubToken, depth: 1 },
  });
}

function sandboxExecArgs(sandboxName: string) {
  const scoped = ["--yes", `sandbox@${SANDBOX_CLI_VERSION}`, "exec"];
  const teamId = process.env.VERCEL_TEAM_ID;
  if (teamId) scoped.push("--scope", teamId);
  scoped.push(
    "--interactive",
    "--tty",
    "--workdir",
    WORKDIR,
    sandboxName,
    "bash",
    "-lc",
    `tmux attach -t ${TMUX_SESSION}`,
  );
  return scoped;
}

export async function attachToSandbox(sandboxName: string) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("npx", sandboxExecArgs(sandboxName), {
      stdio: "inherit",
      env: {
        ...process.env,
        VERCEL_AUTH_TOKEN: process.env.VERCEL_AUTH_TOKEN ?? process.env.VERCEL_TOKEN,
      },
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`attach failed with exit code ${code}`));
    });
  });
}

async function runRedesignWithKey(options: RedesignOptions, pooledAiGatewayKey?: AiGatewayKey): Promise<RedesignResult> {
  const originalUrl = normalizeHttpUrl(options.site);
  const slug = normalizeSlug(options.slug ?? slugFromUrl(originalUrl));
  const businessSlug = normalizeSlug(options.businessSlug ?? slug);
  const businessName = options.business ?? businessSlug;
  const researchModel = DEFAULT_RESEARCH_MODEL;
  const draftModel = DEFAULT_DRAFT_MODEL;
  const implementationModel = DEFAULT_IMPLEMENTATION_MODEL;
  const expectedRedesignUrl = `https://${slug}.${process.env.REDESIGN_BASE_DOMAIN ?? DEFAULT_BASE_DOMAIN}`;
  const githubToken = process.env.GITHUB_TOKEN;
  const startedAt = new Date().toISOString();

  if (!githubToken) throw new Error("Missing GITHUB_TOKEN");
  if (!process.env.DATABASE_URL) throw new Error("Missing DATABASE_URL");

  const repo = await createGithubRepo(slug);
  const aiGatewayKey = pooledAiGatewayKey ?? await createAiGatewayKey(slug);
  let sandbox: Sandbox | undefined;
  let runnerStarted = false;

  try {
    sandbox = await createJobSandbox({
      name: makeSandboxName(slug),
      timeout: (options.timeoutMinutes ?? 90) * 60 * 1000,
      repoUrl: repo.cloneUrl,
      githubToken,
      slug,
    });

    const dbRecord = await recordStartedRedesign({
      businessName,
      businessSlug,
      websiteSlug: slug,
      sourceUrl: originalUrl,
      repoUrl: repo.htmlUrl,
      expectedRedesignUrl,
      sandbox: sandbox.name,
      tmuxSession: TMUX_SESSION,
      model: `${researchModel} + ${draftModel} + ${implementationModel}`,
      aiGatewayBudget: aiGatewayKey.budget,
      startedAt,
    });

    const env = runnerEnv({
      aiGatewayKey,
      pooledAiGatewayKey: Boolean(pooledAiGatewayKey),
      githubToken,
      originalUrl,
      slug,
      repoUrl: repo.htmlUrl,
      expectedRedesignUrl,
      startedAt,
      sandboxName: sandbox.name,
      businessId: dbRecord.businessId,
      runId: dbRecord.runId,
    });
    await uploadRunner(sandbox);
    await startTmuxRunner(sandbox, env);
    runnerStarted = true;

    const result = {
      sandbox: sandbox.name,
      tmuxSession: TMUX_SESSION,
      ...dbRecord,
      businessName,
      businessSlug,
      slug,
      originalUrl,
      repoUrl: repo.htmlUrl,
      expectedRedesignUrl,
      model: `${researchModel} + ${draftModel} + ${implementationModel}`,
      aiGatewayBudget: aiGatewayKey.budget,
    };

    console.log(JSON.stringify(result, null, 2));
    if (options.attach !== false) {
      console.log(`\nReattach later: npm run attach -- --sandbox ${sandbox.name}\n`);
      await attachToSandbox(sandbox.name);
    }
    return result;
  } catch (error) {
    if (!runnerStarted && !pooledAiGatewayKey) await deleteAiGatewayKey(aiGatewayKey.id);
    if (sandbox) console.error(`Sandbox left running for inspection: ${sandbox.name}`);
    throw error;
  }
}

export async function runRedesign(options: RedesignOptions): Promise<RedesignResult> {
  return runRedesignWithKey(options);
}

async function waitForRunCompletion(runId: string, timeoutMinutes: number) {
  const deadline = Date.now() + timeoutMinutes * 60_000;
  while (Date.now() < deadline) {
    const run = await getRunCompletion(runId);
    if (run?.endedAt) return run;
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  throw new Error(`Run ${runId} did not finish within ${timeoutMinutes} minutes`);
}

export async function runRedesignBatch(options: RedesignBatchOptions = {}) {
  const limit = options.limit ?? 100;
  const concurrency = options.concurrency ?? DEFAULT_BATCH_CONCURRENCY;
  const launchIntervalMs = options.launchIntervalMs ?? DEFAULT_BATCH_LAUNCH_INTERVAL_MS;
  const timeoutMinutes = options.timeoutMinutes ?? 90;
  if (!Number.isInteger(limit) || limit < 1) throw new Error("Batch limit must be a positive integer");
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error("Batch concurrency must be a positive integer");
  if (concurrency > DEFAULT_BATCH_CONCURRENCY) throw new Error(`Batch concurrency cannot exceed ${DEFAULT_BATCH_CONCURRENCY}`);
  if (!Number.isFinite(launchIntervalMs) || launchIntervalMs < 0) throw new Error("Launch interval must be zero or greater");

  const selected = selectRedesignCandidates(
    await listRedesignCandidates(),
    await listExistingRedesigns(),
    limit,
  );
  if (selected.length < limit) console.warn(`Selected ${selected.length}/${limit} eligible businesses`);

  const aiGatewayKeys = await createAiGatewayKeyPool(Math.min(concurrency, selected.length));

  let nextLaunchAt = Date.now();
  let nextCandidate = 0;
  const results: Array<{
    business: string;
    email: string;
    sourceUrl: string;
    redesignUrl?: string;
    proofSentences?: string[];
    status: string;
    totalCost?: number;
    error?: string;
  }> = [];
  let completed = 0;

  const workers = await Promise.allSettled(aiGatewayKeys.map(async (aiGatewayKey) => {
      while (true) {
        const candidate = selected[nextCandidate];
        nextCandidate += 1;
        if (!candidate) return;

        const launchAt = Math.max(nextLaunchAt, Date.now());
        nextLaunchAt = launchAt + launchIntervalMs;
        if (launchAt > Date.now()) await new Promise((resolve) => setTimeout(resolve, launchAt - Date.now()));
        let sandbox: string | undefined;
        try {
          const job = await runRedesignWithKey({
            site: candidate.website,
            business: candidate.name,
            businessSlug: candidate.slug,
            slug: candidate.redesignSlug,
            timeoutMinutes,
            attach: false,
          }, aiGatewayKey);
          sandbox = job.sandbox;
          const run = await waitForRunCompletion(job.runId, timeoutMinutes + 5);
          results.push({
            business: candidate.name,
            email: candidate.email,
            sourceUrl: candidate.website,
            redesignUrl: run.redesignUrl ?? job.expectedRedesignUrl,
            proofSentences: run.proofSentences,
            status: run.status,
            totalCost: run.totalCost ?? undefined,
            error: run.error ?? undefined,
          });
        } catch (error) {
          results.push({
            business: candidate.name,
            email: candidate.email,
            sourceUrl: candidate.website,
            status: "failed",
            error: error instanceof Error ? error.message : String(error),
          });
        } finally {
          if (sandbox) await cleanupSandbox(sandbox).catch(() => {});
          completed += 1;
          console.log(`Batch completed ${completed}/${selected.length}`);
        }
        await refillAiGatewayKey(aiGatewayKey);
      }
  }));
  const failedWorker = workers.find((worker) => worker.status === "rejected");
  if (failedWorker?.status === "rejected") throw failedWorker.reason;

  return {
    requested: limit,
    selected: selected.length,
    concurrency: aiGatewayKeys.length,
    succeeded: results.filter(({ status }) => status === "succeeded").length,
    failed: results.filter(({ status }) => status !== "succeeded").length,
    totalCost: results.reduce((sum, result) => sum + (result.totalCost ?? 0), 0),
    results,
  };
}

export async function deleteWebsite(slugInput: string): Promise<DeleteWebsiteResult> {
  const slug = normalizeSlug(slugInput);
  const website = await getWebsite(slug);
  if (!website) throw new Error(`Website not found: ${slug}`);

  const repo = await deleteGithubRepo(website.repoUrl, slug);
  const vercelProject = await deleteVercelProject(slug);
  const deletedRecord = await deleteWebsiteRecord(slug);
  return { slug, repo, vercelProject, deletedRecord };
}

export async function backfillBusinessContacts() {
  const businesses = await listBusinessesForContactBackfill();
  const results: Array<{ slug: string; email?: string; contactFormUrl?: string; error?: string }> = [];

  for (let offset = 0; offset < businesses.length; offset += 5) {
    const batch = businesses.slice(offset, offset + 5);
    results.push(...await Promise.all(batch.map(async (business) => {
      try {
        const found = await collectContactInfo(business.website);
        const contactInfo = {
          email: business.email ? undefined : found.email,
          contactFormUrl: business.contactFormUrl ? undefined : found.contactFormUrl,
          phone: found.phone,
          contactMethods: found.contactMethods,
        };
        await updateBusinessContactInfo(business.id, contactInfo);
        console.log(`${business.slug}: ${contactInfo.email ?? "no email"}; ${contactInfo.contactFormUrl ?? "no contact form"}`);
        return { slug: business.slug, ...contactInfo };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`${business.slug}: ${message}`);
        return { slug: business.slug, error: message };
      }
    })));
  }

  return results;
}

export async function cleanupSandbox(sandboxName: string) {
  const sandbox = await Sandbox.get({ name: sandboxName });
  await sandbox.stop();
  return sandbox.delete();
}
