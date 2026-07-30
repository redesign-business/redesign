import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { collectResearchFiles } from "./research.js";

type Usage = {
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

type Pricing = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};

type PermissionConfig = "allow" | Record<string, unknown>;

const WORKDIR = "/vercel/sandbox";
const OPENCODE_BIN = "/home/vercel-sandbox/.opencode/node_modules/.bin/opencode";
const TEMPLATE_REPO = "https://github.com/redesign-business/template.git";
const RESEARCH_MODEL = "deepseek/deepseek-v4-pro";
const DRAFT_MODEL = "openai/gpt-5.6-sol";
const REPAIR_MODEL = "deepseek/deepseek-v4-pro";
const RESEARCH_AGENT = "research";
const DRAFT_AGENT = "draft";
const MAX_PHASE_CONTINUES = Number(process.env.REDESIGN_MAX_PHASE_CONTINUES ?? 5);
const MAX_BUILD_REPAIRS = Number(process.env.REDESIGN_MAX_BUILD_REPAIRS ?? 5);

function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

const slug = required("REDESIGN_SLUG");
const originalUrl = required("REDESIGN_SITE");
const repoUrl = required("REDESIGN_REPO_URL");
const expectedRedesignUrl = required("REDESIGN_EXPECTED_URL");
const startedAt = required("REDESIGN_STARTED_AT");
const aiGatewayKeyId = required("AI_GATEWAY_KEY_ID");
const aiGatewayKeyName = required("AI_GATEWAY_KEY_NAME");
const aiGatewayBudget = Number(required("AI_GATEWAY_BUDGET"));

function opencodeModel(model: string) {
  return `vercel/${model}`;
}

function money(value: number) {
  return `$${value.toFixed(6)}`;
}

function outputTail(output: string, maxChars = 4000) {
  return output.slice(Math.max(0, output.length - maxChars));
}

function buildResearchPrompt() {
  return [
    "Read raw.md and public/images/manifest.json. Then create proof.md.",
    "",
    `Project slug: ${slug}`,
    `GitHub repo: ${repoUrl}`,
    `Original URL: ${originalUrl}`,
    "",
    "raw.md already contains a simple crawl of same-domain pages converted from HTML to Markdown.",
    "public/images/manifest.json lists downloaded images with page and section context.",
    "",
    "Make proof.md directly copy and organize all the business's demonstrated proof from raw.md. Examples of demonstrated proof are completed work, testimonials, awards, statistics, guarantees, credentials, press, partnerships, and anything the business has or has done that makes a potential customer trust them. Do not invent proof.",
    "",
    "You are done when proof.md is created. Don't run commands, clone, commit, push, search, or read other files.",
  ].join("\n");
}

function buildDraftPrompt() {
  return [
    "Read proof.md and public/images/manifest.json. Then create app/page.tsx.",
    "",
    `Project slug: ${slug}`,
    `GitHub repo: ${repoUrl}`,
    `Original URL: ${originalUrl}`,
    "",
    "Task:",
    "Build the site in app/page.tsx. Use the business's unique proof to inspire the design.",
    "Use image localPath values from public/images/manifest.json. Use the page title, nearest heading, surrounding context, filename, and source page to infer what each image was doing on the original site.",
    "Typical structure: nav, hero, several proof sections, FAQ, final CTA, footer.",
    "No text-only sections except nav, banners, the bar below hero, and footer. Do not repeat images or other media.",
    "There is one CTA; use it everywhere.",
    "",
    "You are done when app/page.tsx is created. Don't run commands, build, commit, push, search, or read other files.",
  ].join("\n");
}

function buildRepairPrompt(buildOutput: string) {
  return [
    "Fix the exact production build error below.",
    "",
    "Rules:",
    "Only change files required to make the build pass.",
    "Keep the current design intact.",
    "Do not commit, push, deploy, or redesign the page.",
    "",
    "Build output:",
    buildOutput,
  ].join("\n");
}

function isBudgetFailure(output: string) {
  return /budget|quota|limit|insufficient funds|payment required/i.test(output);
}

const researchPermission = {
  read: {
    "*": "deny",
    "raw.md": "allow",
    "public/images/manifest.json": "allow",
  },
  edit: {
    "*": "deny",
    "proof.md": "allow",
  },
  glob: "deny",
  grep: "deny",
  list: "deny",
  bash: "deny",
  task: "deny",
  skill: "deny",
  webfetch: "deny",
  websearch: "deny",
  external_directory: "deny",
} satisfies PermissionConfig;

const draftPermission = {
  read: {
    "*": "deny",
    "proof.md": "allow",
    "public/images/manifest.json": "allow",
  },
  edit: {
    "*": "deny",
    "app/page.tsx": "allow",
  },
  glob: "deny",
  grep: "deny",
  list: "deny",
  bash: "deny",
  task: "deny",
  skill: "deny",
  webfetch: "deny",
  websearch: "deny",
  external_directory: "deny",
} satisfies PermissionConfig;

async function run(command: string, args: string[], options: { cwd?: string; env?: Record<string, string>; allowFailure?: boolean; interactive?: boolean } = {}) {
  return new Promise<{ output: string; exitCode: number | null }>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? WORKDIR,
      env: { ...process.env, ...options.env },
      stdio: [options.interactive ? "inherit" : "pipe", "pipe", "pipe"],
    });
    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk;
      process.stdout.write(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      output += chunk;
      process.stderr.write(chunk);
    });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      if (exitCode === 0 || options.allowFailure) resolve({ output, exitCode });
      else reject(new Error(`${command} failed\n${outputTail(output)}`));
    });
  });
}

async function sh(script: string, options?: { cwd?: string; env?: Record<string, string>; allowFailure?: boolean }) {
  return run("bash", ["-lc", script], options);
}

async function write(path: string, content: string | Buffer) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

async function updateRun(fields: Record<string, unknown>) {
  const path = join(WORKDIR, "redesign-run.json");
  let previous = {};
  try {
    previous = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  } catch {
    // First write.
  }
  const next = { ...previous, ...fields };
  await write(path, `${JSON.stringify(next, null, 2)}\n`);
  await sh([
    "git add redesign-run.json",
    "git commit -m 'chore: update redesign run status' || true",
    "git push",
  ].join("\n"));
}

async function resetRun(fields: Record<string, unknown>) {
  await write(join(WORKDIR, "redesign-run.json"), `${JSON.stringify(fields, null, 2)}\n`);
  await sh([
    "git add redesign-run.json",
    "git commit -m 'chore: update redesign run status' || true",
    "git push",
  ].join("\n"));
}

async function commitAll(message: string) {
  await sh([
    "git add -A",
    `git commit -m ${JSON.stringify(message)} || true`,
    "git push",
  ].join("\n"));
}

async function installOpenCode() {
  await run("npm", ["install", "--prefix", "/home/vercel-sandbox/.opencode", "opencode-ai@1.18.9"], { cwd: WORKDIR });
}

async function setupGit() {
  await sh([
    "git config user.name redesign-hosted-2",
    "git config user.email redesign-hosted-2@users.noreply.github.com",
    "git config credential.helper '!f() { echo username=x-access-token; echo password=$GITHUB_TOKEN; }; f'",
    "git ls-remote origin HEAD >/dev/null",
  ].join(" && "));
}

async function seedTemplate() {
  await sh([
    "tmp=$(mktemp -d)",
    `git clone --depth 1 ${TEMPLATE_REPO} "$tmp"`,
    "shopt -s dotglob",
    "for item in \"$tmp\"/*; do",
    "  [ \"$(basename \"$item\")\" = .git ] && continue",
    "  cp -a \"$item\" .",
    "done",
    "rm -rf \"$tmp\"",
  ].join("\n"));
  await commitAll("chore: seed nextjs template");
}

async function setupOpenCode() {
  await write("/home/vercel-sandbox/.config/opencode/opencode.json", JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    enabled_providers: ["vercel"],
    model: opencodeModel(RESEARCH_MODEL),
    agent: {
      [RESEARCH_AGENT]: {
        model: opencodeModel(RESEARCH_MODEL),
        mode: "primary",
        maxSteps: 8,
        permission: researchPermission,
      },
      [DRAFT_AGENT]: {
        model: opencodeModel(DRAFT_MODEL),
        mode: "primary",
        maxSteps: 4,
        permission: draftPermission,
      },
    },
    provider: {
      vercel: {
        npm: "@ai-sdk/gateway",
        env: ["AI_GATEWAY_API_KEY"],
        options: { apiKey: "{env:AI_GATEWAY_API_KEY}" },
        models: Object.fromEntries([...new Set([RESEARCH_MODEL, DRAFT_MODEL, REPAIR_MODEL])].map((model) => [model, {}])),
      },
    },
  }, null, 2));
}

async function collectResearch() {
  const files = await collectResearchFiles(originalUrl, WORKDIR);
  for (const file of files) {
    await write(file.path, file.content);
  }
  await commitAll("chore: add scraped research inputs");
}

async function runOpenCodePhase(phase: string, model: string, args: string[], options: { agent?: string } = {}) {
  const attempts: string[] = [];
  let output = "";
  let currentArgs = args;

  for (let retry = 0; retry <= MAX_PHASE_CONTINUES; retry += 1) {
    if (retry > 0) {
      console.error(`\n${phase} exited before completion; retrying with OpenCode continue (${retry}/${MAX_PHASE_CONTINUES}).`);
      currentArgs = ["run", "continue", "--continue", "--auto", "--dir", WORKDIR, options.agent ? "--agent" : "--model", options.agent ?? opencodeModel(model)];
    }
    const id = `${phase}-${randomUUID().slice(0, 8)}`;
    attempts.push(id);
    await updateRun({ phase, [`${phase}Attempts`]: attempts });

    const result = await run(OPENCODE_BIN, currentArgs, { cwd: WORKDIR, allowFailure: true, interactive: true });
    output += result.output;
    if (result.exitCode === 0) return { output, attempts };
    if (isBudgetFailure(result.output)) throw new Error(`${phase} failed with budget/quota error\n${outputTail(result.output)}`);
  }

  throw new Error(`${phase} failed after ${MAX_PHASE_CONTINUES} continue attempts\n${outputTail(output)}`);
}

async function buildWithRepairs() {
  await sh("corepack enable && pnpm install --frozen-lockfile");
  const builds: string[] = [];
  const repairs: string[] = [];
  for (let attempt = 0; attempt <= MAX_BUILD_REPAIRS; attempt += 1) {
    const build = await sh("pnpm build", { allowFailure: true });
    builds.push(`build-${attempt + 1}`);
    await updateRun({ phase: "build", buildCommands: builds, repairCommands: repairs });
    if (build.exitCode === 0) return { builds, repairs };
    if (attempt === MAX_BUILD_REPAIRS) throw new Error(`build failed after ${MAX_BUILD_REPAIRS} repairs\n${outputTail(build.output)}`);

    await write("/tmp/build-repair-prompt.md", buildRepairPrompt(outputTail(build.output, 12_000)));
    const repair = await runOpenCodePhase("build-repair", REPAIR_MODEL, ["run", "Follow the attached build repair prompt.", "--auto", "--dir", WORKDIR, "--title", "Build repair", "--model", opencodeModel(REPAIR_MODEL), "--file", "/tmp/build-repair-prompt.md"]);
    repairs.push(...repair.attempts);
  }
  return { builds, repairs };
}

function extractRedesignUrl(output: string) {
  const matches = [...output.matchAll(/Redesign URL:\s*(https?:\/\/[^\s]+)/gi)];
  return matches.at(-1)?.[1];
}

async function deploy() {
  const host = new URL(expectedRedesignUrl).host;
  const result = await sh([
    "set -euo pipefail",
    "scope=()",
    "team=()",
    "if [ -n \"${VERCEL_TEAM_ID:-}\" ]; then scope=(--scope \"$VERCEL_TEAM_ID\"); fi",
    "if [ -n \"${VERCEL_TEAM_ID:-}\" ]; then team=(--team \"$VERCEL_TEAM_ID\"); fi",
    "npx --yes vercel link --yes --project \"$REDESIGN_SLUG\" \"${team[@]}\"",
    "npx --yes vercel deploy --yes --no-wait \"${scope[@]}\" | tee /tmp/vercel-deploy.out",
    "deployment_url=$(grep -Eo 'https://[^[:space:]]+\\.vercel\\.app[^[:space:]]*' /tmp/vercel-deploy.out | tail -n 1)",
    "[ -n \"$deployment_url\" ]",
    "echo \"Deployment URL: $deployment_url\"",
    "npx --yes vercel inspect \"$deployment_url\" --wait --timeout 5m \"${scope[@]}\" | tee /tmp/vercel-inspect.out",
    "npx --yes vercel domains add \"$REDESIGN_HOST\" \"$REDESIGN_SLUG\" --force \"${scope[@]}\" || true",
    "npx --yes vercel alias set \"$deployment_url\" \"$REDESIGN_HOST\" \"${scope[@]}\"",
    "echo \"Redesign URL: https://$REDESIGN_HOST\"",
  ].join("\n"), {
    env: {
      REDESIGN_SLUG: slug,
      REDESIGN_HOST: host,
    },
  });
  return extractRedesignUrl(result.output) ?? expectedRedesignUrl;
}

async function capture(command: string, args: string[], cwd = WORKDIR) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, { cwd });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk; });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr.trim()));
    });
  });
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
  } satisfies Pricing;
}

async function estimateUsage() {
  await sh("command -v sqlite3 >/dev/null || sudo dnf install -y sqlite");
  const dbPath = "/home/vercel-sandbox/.local/share/opencode/opencode.db";
  const json = await capture("sqlite3", ["-json", dbPath, [
    "select json_extract(model,'$.id') as model,",
    "sum(tokens_input) as input_tokens,",
    "sum(tokens_output) as output_tokens,",
    "sum(tokens_reasoning) as reasoning_tokens,",
    "sum(tokens_cache_read) as cached_input_tokens,",
    "sum(tokens_cache_write) as cache_creation_input_tokens,",
    "count(*) as request_count",
    "from session where model is not null group by 1",
  ].join(" ")]);
  const rows = JSON.parse(json) as Array<{
    model?: string;
    input_tokens?: number;
    output_tokens?: number;
    reasoning_tokens?: number;
    cached_input_tokens?: number;
    cache_creation_input_tokens?: number;
    request_count?: number;
  }>;
  return Promise.all(rows.map(async (row) => {
    const pricing = await modelPricing(row.model ?? "");
    const usage = {
      model: row.model,
      inputTokens: row.input_tokens ?? 0,
      outputTokens: row.output_tokens ?? 0,
      cachedInputTokens: row.cached_input_tokens ?? 0,
      cacheCreationInputTokens: row.cache_creation_input_tokens ?? 0,
      reasoningTokens: row.reasoning_tokens ?? 0,
      requestCount: row.request_count ?? 0,
    };
    const totalCost =
      usage.inputTokens * pricing.input +
      usage.outputTokens * pricing.output +
      usage.cachedInputTokens * pricing.cacheRead +
      usage.cacheCreationInputTokens * pricing.cacheWrite;
    return { ...usage, totalCost, marketCost: totalCost } satisfies Usage;
  }));
}

function sumUsage(usages: Usage[]) {
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
  } satisfies Usage);
}

async function deleteAiGatewayKey() {
  const token = process.env.VERCEL_TOKEN;
  if (!token) return;
  const params = new URLSearchParams();
  if (process.env.VERCEL_TEAM_ID) params.set("teamId", process.env.VERCEL_TEAM_ID);
  await fetch(`https://api.vercel.com/v1/api-keys/${aiGatewayKeyId}${params.size ? `?${params}` : ""}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  }).catch(() => {});
}

async function main() {
  await setupGit();
  await resetRun({
    slug,
    originalUrl,
    repoUrl,
    expectedRedesignUrl,
    sandbox: process.env.REDESIGN_SANDBOX,
    aiGatewayKeyId,
    aiGatewayKeyName,
    aiGatewayBudget,
    startedAt,
    status: "running",
    phase: "setup",
    researchModel: RESEARCH_MODEL,
    draftModel: DRAFT_MODEL,
    implementationModel: REPAIR_MODEL,
  });

  await installOpenCode();
  await seedTemplate();
  await setupOpenCode();

  await updateRun({ phase: "precollect" });
  await collectResearch();
  await write("/tmp/research-prompt.md", buildResearchPrompt());
  await write("/tmp/draft-prompt.md", buildDraftPrompt());

  await updateRun({ phase: "research" });
  const research = await runOpenCodePhase("research", RESEARCH_MODEL, ["run", "Follow the attached redesign prompt.", "--auto", "--dir", WORKDIR, "--title", `Research ${slug}`, "--agent", RESEARCH_AGENT, "--file", "/tmp/research-prompt.md"], { agent: RESEARCH_AGENT });
  await commitAll("chore: add proof");

  await updateRun({ phase: "draft", researchAttempts: research.attempts });
  const draft = await runOpenCodePhase("draft", DRAFT_MODEL, ["run", "Follow the attached first-draft prompt.", "--auto", "--dir", WORKDIR, "--title", `Draft ${slug}`, "--agent", DRAFT_AGENT, "--file", "/tmp/draft-prompt.md"], { agent: DRAFT_AGENT });

  await updateRun({ phase: "build", draftAttempts: draft.attempts });
  const build = await buildWithRepairs();

  await updateRun({ phase: "commit", buildCommands: build.builds, repairCommands: build.repairs });
  await commitAll("feat: build landing page");

  await updateRun({ phase: "deploy" });
  const redesignUrl = await deploy();

  const endedAt = new Date().toISOString();
  const wallTimeSeconds = Math.round((Date.parse(endedAt) - Date.parse(startedAt)) / 1000);
  let usageByModel: Usage[] | undefined;
  let totalUsage: Usage | undefined;
  try {
    usageByModel = await estimateUsage();
    totalUsage = sumUsage(usageByModel);
  } catch {
    // Usage is best-effort; OpenCode's DB or sqlite may be unavailable.
  }

  await updateRun({
    status: "succeeded",
    phase: "done",
    endedAt,
    wallTimeSeconds,
    redesignUrl,
    estimatedUsageByModel: usageByModel,
    estimatedTotalUsage: totalUsage,
    aiGatewayKeyDeletedAt: new Date().toISOString(),
  });
  await deleteAiGatewayKey();

  console.log(`\nOriginal URL: ${originalUrl}`);
  console.log(`Redesign URL: ${redesignUrl}`);
  console.log(`GitHub repo: ${repoUrl}`);
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
  console.log(`AI Gateway budget: $${aiGatewayBudget}`);
}

main().catch(async (error: unknown) => {
  const endedAt = new Date().toISOString();
  await deleteAiGatewayKey();
  await updateRun({
    status: "failed",
    endedAt,
    wallTimeSeconds: Math.round((Date.parse(endedAt) - Date.parse(startedAt)) / 1000),
    aiGatewayKeyDeletedAt: new Date().toISOString(),
    error: error instanceof Error ? error.message : String(error),
  }).catch(() => {});
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
