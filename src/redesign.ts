import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { config as loadEnv } from "dotenv";
import { Sandbox } from "@vercel/sandbox";
import { recordStartedRedesign } from "./db.js";

loadEnv({ path: ".env.local", quiet: true });

export type RedesignOptions = {
  site: string;
  business?: string;
  businessSlug?: string;
  slug?: string;
  timeoutMinutes?: number;
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

const WORKDIR = "/vercel/sandbox";
const TMUX_SESSION = "redesign";
const DEFAULT_RESEARCH_MODEL = "deepseek/deepseek-v4-pro";
const DEFAULT_DRAFT_MODEL = "openai/gpt-5.6-sol";
const DEFAULT_IMPLEMENTATION_MODEL = "deepseek/deepseek-v4-pro";
const DEFAULT_GITHUB_OWNER = "redesign-business";
const DEFAULT_BASE_DOMAIN = "redesign.business";
const DEFAULT_POSTHOG_HOST = "https://us.i.posthog.com";
const DEFAULT_AI_GATEWAY_BUDGET = 1;
const SANDBOX_CLI_VERSION = "3.5.5";

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
  aiGatewayKey: Awaited<ReturnType<typeof createAiGatewayKey>>;
  githubToken: string;
  originalUrl: string;
  slug: string;
  repoUrl: string;
  expectedRedesignUrl: string;
  startedAt: string;
  sandboxName: string;
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
    REDESIGN_RUN_ID: options.runId,
    DATABASE_URL: process.env.DATABASE_URL ?? "",
    AI_GATEWAY_KEY_ID: options.aiGatewayKey.id,
    AI_GATEWAY_KEY_NAME: options.aiGatewayKey.name,
    AI_GATEWAY_BUDGET: String(options.aiGatewayKey.budget),
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

async function cloneJobRepo(sandbox: Sandbox, repoUrl: string) {
  await must(await sandbox.runCommand({
    cmd: "bash",
    args: ["-lc", [
      "set -euo pipefail",
      `find ${WORKDIR} -mindepth 1 -maxdepth 1 -exec rm -rf {} +`,
      `git clone --depth 1 ${JSON.stringify(repoUrl)} ${WORKDIR}`,
    ].join("\n")],
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
    await cloneJobRepo(sandbox, params.repoUrl);
    return sandbox;
  }
  if (process.env.REDESIGN_TEMPLATE_SANDBOX) {
    const sandbox = await Sandbox.fork({
      ...common,
      sourceSandbox: process.env.REDESIGN_TEMPLATE_SANDBOX,
    });
    await cloneJobRepo(sandbox, params.repoUrl);
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

export async function runRedesign(options: RedesignOptions): Promise<RedesignResult> {
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
  const aiGatewayKey = await createAiGatewayKey(slug);
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
      githubToken,
      originalUrl,
      slug,
      repoUrl: repo.htmlUrl,
      expectedRedesignUrl,
      startedAt,
      sandboxName: sandbox.name,
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
    console.log(`\nReattach later: npm run attach -- --sandbox ${sandbox.name}\n`);
    await attachToSandbox(sandbox.name);
    return result;
  } catch (error) {
    if (!runnerStarted) await deleteAiGatewayKey(aiGatewayKey.id);
    if (sandbox) console.error(`Sandbox left running for inspection: ${sandbox.name}`);
    throw error;
  }
}

export async function cleanupSandbox(sandboxName: string) {
  const sandbox = await Sandbox.get({ name: sandboxName });
  await sandbox.stop();
  return sandbox.delete();
}
