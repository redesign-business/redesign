import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { replaceRunSessions, updateBusinessContactInfo, updateRunData } from "./db.js";
import { phaseComplete, redactSessionOutput } from "./phase.js";
import { installRelumeComponents, verifyRelumeComponents, type RelumeInstall } from "./relume.js";
import { collectResearch as collectResearchData, extractOutreachProof, invalidPageLinks } from "./research.js";

type Usage = {
  model?: string;
  totalCost: number;
  marketCost: number;
  inputCost: number;
  outputCost: number;
  cacheReadCost: number;
  cacheWriteCost: number;
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

const WORKDIR = "/vercel/sandbox";
const OPENCODE_BIN = "/home/vercel-sandbox/.opencode/node_modules/.bin/opencode";
const TEMPLATE_REPO = "https://github.com/redesign-business/template.git";
const RESEARCH_MODEL = "deepseek/deepseek-v4-flash-0731";
const BUILD_MODEL = "openai/gpt-5.6-sol";
const REPAIR_MODEL = "deepseek/deepseek-v4-flash-0731";
const RESEARCH_AGENT = "research";
const COMPOSE_AGENT = "compose";
const BUILD_AGENT = "build";
const REPAIR_AGENT = "repair";
const HOMEPAGE_SCREENSHOT = "/tmp/original-homepage.png";
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
const businessId = required("REDESIGN_BUSINESS_ID");
const runId = required("REDESIGN_RUN_ID");
const aiGatewayKeyId = required("AI_GATEWAY_KEY_ID");
const aiGatewayKeyName = required("AI_GATEWAY_KEY_NAME");
const aiGatewayKeyPooled = process.env.AI_GATEWAY_KEY_POOLED === "true";
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
    "raw.md already contains crawled same-domain pages from the original website converted from HTML to Markdown.",
    "public/images/manifest.json lists downloaded images with stable IDs, browser src values, source URL, page, and context.",
    "",
    "Begin proof.md with a section named `## Outreach` containing exactly three bullet points because deterministic outreach code stores those three lines. Each bullet must be one grounded, customer-facing sentence describing a distinct piece of proof worth showing in the redesign. State the proof directly; do not write instructions such as `feature`, `highlight`, `show`, or `emphasize`. End each sentence with a period.",
    "After that small contract, compactly preserve the strongest distinct proof from raw.md: completed work, testimonials, awards, statistics, guarantees, credentials, press, partnerships, and anything the business has or has done that makes a potential customer trust them. Remove repetition and do not invent proof.",
    "",
    "You are done when proof.md is created. Don't run commands, clone, commit, push, search, or read other files.",
  ].join("\n");
}

function buildCompositionPrompt(hasImageContactSheets: boolean, hasHomepageScreenshot: boolean) {
  return [
    "Choose the Relume composition for one finished homepage from the supplied evidence.",
    "",
    `Original URL: ${originalUrl}`,
    "",
    "Inputs:",
    "- proof.md is the complete factual and copy source.",
    "- .redesign/build-images.json is the complete allowed image set. Use its local `src` values.",
    hasImageContactSheets
      ? "- The attached contact sheets show those allowed images and their IDs."
      : "- No usable original images were available.",
    "- The authenticated Relume MCP provides the section library and its exact React source.",
    hasHomepageScreenshot
      ? "- The attached original screenshot is a brand reference, not a layout to copy."
      : "- The original screenshot was unavailable.",
    "",
    "Selection contract:",
    "- Search Relume with natural-language descriptions of each content role and composition. Do not guess category slugs. Call list_categories only if natural-language search fails or a tool requires a category.",
    "- Batch compatible searches when possible. Choose the complete section set from search results before retrieving source.",
    "- Choose 5-7 purposeful components including navigation and footer. Favor simple, static compositions that fit the available proof and images without layout changes.",
    "- Inspect every original-image contact sheet before choosing. Later sheets are equally important; never default to the earliest IDs.",
    "- Do not add carousels, video players, sticky scroll scenes, scroll-driven layouts, or large empty regions.",
    "- Do not call get_components and do not edit the website.",
    "- Write .redesign/relume-selection.json as exactly one JSON object with one key: `slugs`, containing the selected Relume slugs in page order.",
    "",
    "Do not create plans or notes, browse the web, retrieve source, install, build, commit, push, or deploy.",
    "You are done when .redesign/relume-selection.json exists.",
  ].join("\n");
}

function buildImplementationPrompt() {
  return [
    "Now build the finished homepage using the exact Relume components installed by code.",
    "",
    "The selected component paths and immutable hashes are listed in .redesign/relume-install.json. Their compact prop API is in .redesign/relume-api.md.",
    ".redesign/valid-links.json is the complete set of verified destinations from the original site. Hash links are also allowed when their matching section ID exists in app/page.tsx.",
    "Use that API to compose them in app/page.tsx. Do not read, edit, copy, consolidate, or reimplement any installed component, primitive, hook, or utility.",
    "",
    "Implementation contract:",
    "- Edit only app/page.tsx, app/globals.css, and app/layout.tsx.",
    "- app/page.tsx supplies section order, typed props, concise grounded copy, original image paths, the original logo, links, and business metadata.",
    "- app/globals.css may set the existing theme variables and basic element defaults. Do not add named CSS classes; use Tailwind utilities in page.tsx when a page-level wrapper genuinely needs styling.",
    "- Follow the existing Relume semantic color roles exactly: background-primary is the main surface; background-secondary is the alternate surface; background-tertiary is the primary CTA/brand fill; background-alternative is the darkest surface; use the matching text, border, link, and scheme roles.",
    "- If the original logo has a clear saturated color, assign it to the existing background-tertiary theme variable and give scheme-button-text an accessible neutral contrast color. Otherwise choose one restrained background-tertiary color. Use one neutral palette for every other role.",
    "- Do not add parallel primary, accent, brand, or foreground tokens, and do not add raw colors outside the existing Relume theme variables.",
    "- Use the shared Button default variant for every primary CTA. Use one CTA label consistently and do not add CTA-specific styling.",
    "- Every link or button must use a destination from .redesign/valid-links.json or a real section ID in this page. Use an absolute original-site URL for an original subpage; never invent a local route. Omit the control if no verified destination fits.",
    "- Omit optional decorative props by default. Add a badge, tag, icon, secondary button, or social link only when it communicates unique useful information or performs a verified action.",
    "- Preserve a strong original color or font when present and always use the original logo.",
    "- Use the strongest proof from proof.md. Adapt copy length to the installed component props and do not invent claims.",
    "- Choose original images for visual fit. Use each once, avoid near-duplicates, and use the strongest distinct work for portfolio sections.",
    "- Do not use remote placeholders, stock, generated, repeated, or upscaled media.",
    "- Keep the selected layouts and interactions intact. If a component is imperfect, populate it faithfully rather than redesigning it.",
    "",
    "Make one implementation patch, then stop without rereading or auditing the result. Do not use Relume tools, create plans or notes, browse, install dependencies, build, commit, push, or deploy.",
    "You are done when app/page.tsx, app/globals.css, and app/layout.tsx form the finished site.",
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
  return /budget|quota|insufficient funds|payment required/i.test(output);
}

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
  await updateRunData(runId, fields);
}

async function resetRun(fields: Record<string, unknown>) {
  await updateRun(fields);
}

async function commitAll(message: string) {
  await sh([
    "git add -A",
    `git commit -m ${JSON.stringify(message)} || true`,
    "git push",
  ].join("\n"));
}

async function commitSessionLogs() {
  await sh([
    "git add .redesign/sessions",
    "git commit -m 'chore: save agent sessions' || true",
    "git push",
  ].join("\n"));
}

async function setupGit() {
  await sh([
    "git config user.name 'Xander Beaulac'",
    "git config user.email xbeaulac@gmail.com",
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

async function captureHomepageScreenshot() {
  const result = await sh([
    "npx playwright screenshot",
    "--browser chromium",
    "--viewport-size '1440,1000'",
    "--color-scheme light",
    "--block-service-workers",
    "--ignore-https-errors",
    "--wait-for-timeout 3000",
    "--timeout 20000",
    JSON.stringify(originalUrl),
    HOMEPAGE_SCREENSHOT,
  ].join(" "), { allowFailure: true });
  if (result.exitCode !== 0) console.warn("Original homepage screenshot unavailable; styling will continue without it.");
  return result.exitCode === 0 && (await sh(`test -s ${HOMEPAGE_SCREENSHOT}`, { allowFailure: true })).exitCode === 0;
}

async function collectResearch() {
  const { files, contactInfo } = await collectResearchData(originalUrl, WORKDIR);
  for (const file of files) {
    await write(file.path, file.content);
  }
  await updateBusinessContactInfo(businessId, contactInfo);
}

async function createBuildAssetPack() {
  await mkdir(`${WORKDIR}/.redesign`, { recursive: true });
  const manifest = JSON.parse(await readFile(`${WORKDIR}/public/images/manifest.json`, "utf8")) as {
    images?: Array<Record<string, unknown>>;
  };
  const images = (manifest.images ?? []).map((image) => ({
    id: image.id,
    src: image.src,
    localPath: image.localPath,
    contentType: image.contentType,
    role: image.role,
    alt: image.alt,
    pageTitle: image.pageTitle,
    nearestHeading: image.nearestHeading,
  }));
  await write(`${WORKDIR}/.redesign/build-images.json`, `${JSON.stringify({ images }, null, 2)}\n`);
  if (!images.length) return [];
  await run("node", ["scripts/make-contact-sheet.mjs", ".redesign/build-images.json", ".redesign/build-contact-sheet"], { cwd: WORKDIR });
  return (await readdir(`${WORKDIR}/.redesign`))
    .filter((name) => /^build-contact-sheet-\d+\.png$/.test(name))
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }))
    .map((name) => `${WORKDIR}/.redesign/${name}`);
}

async function readRelumeSelection() {
  const selection = JSON.parse(await readFile(`${WORKDIR}/.redesign/relume-selection.json`, "utf8")) as { slugs?: unknown };
  if (!Array.isArray(selection.slugs) || selection.slugs.length < 5 || selection.slugs.length > 7) {
    throw new Error("Relume selection must contain 5-7 slugs");
  }
  const slugs = selection.slugs.map(String);
  if (new Set(slugs).size !== slugs.length || slugs.some((slug) => !/^[a-z0-9_]+$/.test(slug))) {
    throw new Error("Relume selection contains invalid or duplicate slugs");
  }
  return slugs;
}

function dependencyName(spec: string) {
  if (!spec.startsWith("@")) return spec.split("@")[0];
  const versionAt = spec.indexOf("@", 1);
  return versionAt === -1 ? spec : spec.slice(0, versionAt);
}

async function installMissingDependencies(dependencies: string[]) {
  const packageJson = JSON.parse(await readFile(`${WORKDIR}/package.json`, "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const present = { ...packageJson.dependencies, ...packageJson.devDependencies };
  const missing = dependencies.filter((dependency) => !present[dependencyName(dependency)]);
  if (missing.length) await run("pnpm", ["add", ...missing], { cwd: WORKDIR });
}

async function validateGlobalStyles() {
  const css = await readFile(`${WORKDIR}/app/globals.css`, "utf8");
  if (/(^|[,{}]\s*)\.[A-Za-z_-][\w-]*/m.test(css)) throw new Error("app/globals.css contains named CSS classes; use Tailwind utilities instead");
}

async function validatePageLinks() {
  const page = await readFile(`${WORKDIR}/app/page.tsx`, "utf8");
  const { targets } = JSON.parse(await readFile(`${WORKDIR}/.redesign/valid-links.json`, "utf8")) as { targets: string[] };
  const invalid = invalidPageLinks(page, targets);
  if (invalid.length) throw new Error(`app/page.tsx contains unverified destinations: ${invalid.join(", ")}`);
}

async function runOpenCodePhase(
  phase: string,
  model: string,
  args: string[],
  options: { agent?: string; deliverableDelivered?: () => Promise<boolean>; retryMessage?: string; maxContinues?: number } = {},
) {
  const attempts: string[] = [];
  let output = "";
  let currentArgs = args;

  const maxContinues = options.maxContinues ?? MAX_PHASE_CONTINUES;
  for (let retry = 0; retry <= maxContinues; retry += 1) {
    if (retry > 0) {
      console.error(`\n${phase} did not deliver; retrying with OpenCode continue (${retry}/${maxContinues}).`);
      currentArgs = ["run", options.retryMessage ?? "Finish the requested deliverable.", "--continue", "--auto", "--dir", WORKDIR, options.agent ? "--agent" : "--model", options.agent ?? opencodeModel(model)];
    }
    const id = `${phase}-${randomUUID().slice(0, 8)}`;
    attempts.push(id);
    await updateRun({ status: phase, [`${phase}Attempts`]: attempts });

    const result = await run(OPENCODE_BIN, currentArgs, { cwd: WORKDIR, allowFailure: true, interactive: true });
    const safeOutput = redactSessionOutput(result.output, [
      process.env.AI_GATEWAY_API_KEY,
      process.env.GITHUB_TOKEN,
      process.env.VERCEL_TOKEN,
      process.env.DATABASE_URL,
    ]);
    await write(`${WORKDIR}/.redesign/sessions/${id}.log`, [
      `Phase: ${phase}`,
      `Model: ${model}`,
      `Exit code: ${result.exitCode ?? "unknown"}`,
      "",
      safeOutput,
    ].join("\n"));
    output += result.output;
    await recordUsage();
    const delivered = options.deliverableDelivered ? await options.deliverableDelivered() : undefined;
    if (phaseComplete(result.exitCode, delivered)) return { output, attempts };
    if (isBudgetFailure(result.output)) throw new Error(`${phase} failed with budget/quota error\n${outputTail(result.output)}`);
  }

  throw new Error(`${phase} did not deliver after ${maxContinues} continue attempts\n${outputTail(output)}`);
}

async function implementationDelivered(globalsBefore: string) {
  try {
    const page = await readFile(`${WORKDIR}/app/page.tsx`, "utf8");
    const globals = await readFile(`${WORKDIR}/app/globals.css`, "utf8");
    const layout = await readFile(`${WORKDIR}/app/layout.tsx`, "utf8");
    return page.length > 1_000
      && globals !== globalsBefore
      && !/Create Next App|Generated by create next app/.test(layout);
  } catch {
    return false;
  }
}

async function buildWithRepairs() {
  await sh("corepack enable && pnpm install --frozen-lockfile");
  const builds: string[] = [];
  const repairs: string[] = [];
  for (let attempt = 0; attempt <= MAX_BUILD_REPAIRS; attempt += 1) {
    const build = await sh("pnpm build", { allowFailure: true });
    builds.push(`build-${attempt + 1}`);
    await updateRun({ status: "build", buildCommands: builds, repairCommands: repairs });
    if (build.exitCode === 0) return { builds, repairs };
    if (attempt === MAX_BUILD_REPAIRS) throw new Error(`build failed after ${MAX_BUILD_REPAIRS} repairs\n${outputTail(build.output)}`);

    await write("/tmp/build-repair-prompt.md", buildRepairPrompt(outputTail(build.output, 12_000)));
    const repair = await runOpenCodePhase("build-repair", REPAIR_MODEL, ["run", "Follow the attached build repair prompt.", "--auto", "--dir", WORKDIR, "--title", `Repair ${slug}`, "--agent", REPAIR_AGENT, "--file", "/tmp/build-repair-prompt.md"], {
      agent: REPAIR_AGENT,
      maxContinues: 0,
    });
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
    "build_env=()",
    "if [ -n \"${VERCEL_TEAM_ID:-}\" ]; then scope=(--scope \"$VERCEL_TEAM_ID\"); fi",
    "if [ -n \"${VERCEL_TEAM_ID:-}\" ]; then team=(--team \"$VERCEL_TEAM_ID\"); fi",
    "for name in NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN NEXT_PUBLIC_POSTHOG_HOST NEXT_PUBLIC_REDESIGN_SLUG; do",
    "  if [ -n \"${!name:-}\" ]; then build_env+=(--build-env \"$name=${!name}\"); fi",
    "done",
    "npx --yes vercel link --yes --project \"$REDESIGN_SLUG\" \"${team[@]}\"",
    "npx --yes vercel domains add \"$REDESIGN_HOST\" \"$REDESIGN_SLUG\" --force \"${scope[@]}\" || true",
    "npx --yes vercel deploy --prod --yes \"${scope[@]}\" \"${build_env[@]}\" | tee /tmp/vercel-deploy.out",
    "deployment_url=$(grep -Eo 'https://[^[:space:]]+\\.vercel\\.app[^[:space:]]*' /tmp/vercel-deploy.out | tail -n 1)",
    "[ -n \"$deployment_url\" ]",
    "echo \"Deployment URL: $deployment_url\"",
    "npx --yes vercel inspect \"$deployment_url\" --wait --timeout 5m \"${scope[@]}\" | tee /tmp/vercel-inspect.out",
    "curl --fail --silent --show-error --retry 30 --retry-delay 2 --retry-all-errors \"https://$REDESIGN_HOST\" >/dev/null",
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
    const inputCost = usage.inputTokens * pricing.input;
    const outputCost = usage.outputTokens * pricing.output;
    const cacheReadCost = usage.cachedInputTokens * pricing.cacheRead;
    const cacheWriteCost = usage.cacheCreationInputTokens * pricing.cacheWrite;
    const totalCost = inputCost + outputCost + cacheReadCost + cacheWriteCost;
    return { ...usage, inputCost, outputCost, cacheReadCost, cacheWriteCost, totalCost, marketCost: totalCost } satisfies Usage;
  }));
}

function sumUsage(usages: Usage[]) {
  return usages.reduce((sum, usage) => ({
    totalCost: sum.totalCost + usage.totalCost,
    marketCost: sum.marketCost + usage.marketCost,
    inputCost: sum.inputCost + usage.inputCost,
    outputCost: sum.outputCost + usage.outputCost,
    cacheReadCost: sum.cacheReadCost + usage.cacheReadCost,
    cacheWriteCost: sum.cacheWriteCost + usage.cacheWriteCost,
    inputTokens: sum.inputTokens + usage.inputTokens,
    outputTokens: sum.outputTokens + usage.outputTokens,
    cachedInputTokens: sum.cachedInputTokens + usage.cachedInputTokens,
    cacheCreationInputTokens: sum.cacheCreationInputTokens + usage.cacheCreationInputTokens,
    reasoningTokens: sum.reasoningTokens + usage.reasoningTokens,
    requestCount: sum.requestCount + usage.requestCount,
  }), {
    totalCost: 0,
    marketCost: 0,
    inputCost: 0,
    outputCost: 0,
    cacheReadCost: 0,
    cacheWriteCost: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    cacheCreationInputTokens: 0,
    reasoningTokens: 0,
    requestCount: 0,
  } satisfies Usage);
}

async function recordUsage() {
  const usageByModel = await estimateUsage();
  await replaceRunSessions(runId, usageByModel.filter((usage) => usage.model).map((usage) => ({
    model: usage.model ?? "",
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cachedInputTokens,
    cacheWriteTokens: usage.cacheCreationInputTokens,
    totalTokens: usage.inputTokens + usage.outputTokens + usage.cachedInputTokens + usage.cacheCreationInputTokens,
    inputCost: usage.inputCost,
    outputCost: usage.outputCost,
    cacheReadCost: usage.cacheReadCost,
    cacheWriteCost: usage.cacheWriteCost,
    totalCost: usage.totalCost,
  })));
  return { usageByModel, totalUsage: sumUsage(usageByModel) };
}

async function deleteAiGatewayKey() {
  if (aiGatewayKeyPooled) return;
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
    status: "setup",
    researchModel: RESEARCH_MODEL,
    buildModel: BUILD_MODEL,
    repairModel: REPAIR_MODEL,
  });

  await seedTemplate();

  await updateRun({ status: "precollect" });
  await collectResearch();
  await commitAll("chore: add scraped research inputs");
  await write("/tmp/research-prompt.md", buildResearchPrompt());

  await updateRun({ status: "research" });
  const [research, imageContactSheets, hasHomepageScreenshot] = await Promise.all([
    runOpenCodePhase("research", RESEARCH_MODEL, ["run", "Follow the attached redesign prompt.", "--auto", "--dir", WORKDIR, "--title", `Research ${slug}`, "--agent", RESEARCH_AGENT, "--file", "/tmp/research-prompt.md"], {
      agent: RESEARCH_AGENT,
      deliverableDelivered: async () => {
        try {
          const proof = await readFile(`${WORKDIR}/proof.md`, "utf8");
          extractOutreachProof(proof);
          return true;
        } catch {
          return false;
        }
      },
      retryMessage: "Finish proof.md with exactly three Outreach bullets and the complete grounded proof.",
    }),
    createBuildAssetPack(),
    captureHomepageScreenshot(),
  ]);
  await commitAll("chore: add proof");

  const proofSentences = extractOutreachProof(await readFile(`${WORKDIR}/proof.md`, "utf8"));
  await write("/tmp/composition-prompt.md", buildCompositionPrompt(imageContactSheets.length > 0, hasHomepageScreenshot));
  const compositionArgs = ["run", "Follow the attached composition prompt.", "--auto", "--dir", WORKDIR, "--title", `Compose ${slug}`, "--agent", COMPOSE_AGENT, "--file", "/tmp/composition-prompt.md"];
  for (const sheet of imageContactSheets) compositionArgs.push("--file", sheet);
  if (hasHomepageScreenshot) compositionArgs.push("--file", HOMEPAGE_SCREENSHOT);
  await updateRun({ status: "composition", researchAttempts: research.attempts, proofSentences });
  const composition = await runOpenCodePhase("composition", BUILD_MODEL, compositionArgs, {
    agent: COMPOSE_AGENT,
    deliverableDelivered: async () => {
      try {
        await readRelumeSelection();
        return true;
      } catch {
        return false;
      }
    },
    maxContinues: 0,
  });

  const relumeSlugs = await readRelumeSelection();
  await run(OPENCODE_BIN, ["mcp", "list"], { cwd: WORKDIR });
  const relumeInstall: RelumeInstall = await installRelumeComponents(WORKDIR, relumeSlugs);
  await installMissingDependencies(relumeInstall.dependencies);
  await commitAll("chore: install selected relume components");

  await write("/tmp/implementation-prompt.md", buildImplementationPrompt());
  const globalsBeforeImplementation = await readFile(`${WORKDIR}/app/globals.css`, "utf8");
  const implementationArgs = ["run", "Continue with the attached implementation prompt.", "--continue", "--auto", "--dir", WORKDIR, "--agent", BUILD_AGENT, "--file", "/tmp/implementation-prompt.md"];
  await updateRun({ status: "implementation", compositionAttempts: composition.attempts, relumeComponents: relumeSlugs });
  const implementation = await runOpenCodePhase("implementation", BUILD_MODEL, implementationArgs, {
    agent: BUILD_AGENT,
    deliverableDelivered: () => implementationDelivered(globalsBeforeImplementation),
    maxContinues: 0,
  });
  await verifyRelumeComponents(WORKDIR, relumeInstall);
  await validateGlobalStyles();
  await validatePageLinks();

  await updateRun({ status: "build", implementationAttempts: implementation.attempts });
  const build = await buildWithRepairs();
  await verifyRelumeComponents(WORKDIR, relumeInstall);
  await validateGlobalStyles();
  await validatePageLinks();

  await updateRun({ status: "commit", buildCommands: build.builds, repairCommands: build.repairs });
  await commitAll("feat: build landing page");

  await updateRun({ status: "deploy" });
  const redesignUrl = await deploy();

  const endedAt = new Date().toISOString();
  const wallTimeSeconds = Math.round((Date.parse(endedAt) - Date.parse(startedAt)) / 1000);
  const { usageByModel, totalUsage } = await recordUsage();

  await updateRun({
    status: "succeeded",
    endedAt,
    wallTimeSeconds,
    redesignUrl,
    aiGatewayKeyDeletedAt: aiGatewayKeyPooled ? undefined : new Date().toISOString(),
  });
  await deleteAiGatewayKey();

  console.log(`\nOriginal URL: ${originalUrl}`);
  console.log(`Redesign URL: ${redesignUrl}`);
  console.log(`GitHub repo: ${repoUrl}`);
  console.log(`Slug: ${slug}`);
  console.log(`Wall time: ${wallTimeSeconds}s`);
  for (const usage of usageByModel) {
    console.log(`\nModel: ${usage.model}`);
    console.log(`Tokens: input ${usage.inputTokens.toLocaleString("en-US")}, output ${usage.outputTokens.toLocaleString("en-US")}, cache read ${usage.cachedInputTokens.toLocaleString("en-US")}, cache write ${usage.cacheCreationInputTokens.toLocaleString("en-US")}`);
    console.log(`OpenCode sessions: ${usage.requestCount}`);
    console.log(`Estimated total: ${money(usage.totalCost)}`);
  }
  console.log(`\nCombined OpenCode sessions: ${totalUsage.requestCount}`);
  console.log(`Combined estimated total: ${money(totalUsage.totalCost)}`);
  console.log(`AI Gateway budget: $${aiGatewayBudget}`);
}

main().catch(async (error: unknown) => {
  const endedAt = new Date().toISOString();
  await commitSessionLogs().catch(() => {});
  await recordUsage().catch((usageError: unknown) => {
    console.error(`Usage recording failed: ${usageError instanceof Error ? usageError.message : String(usageError)}`);
  });
  await deleteAiGatewayKey();
  await updateRun({
    status: "failed",
    endedAt,
    wallTimeSeconds: Math.round((Date.parse(endedAt) - Date.parse(startedAt)) / 1000),
    aiGatewayKeyDeletedAt: aiGatewayKeyPooled ? undefined : new Date().toISOString(),
    error: error instanceof Error ? error.message : String(error),
  }).catch(() => {});
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
