import assert from "node:assert/strict";
import {
  aliasHostForRedesignUrl,
  appendWithoutReplay,
  buildDesignPrompt,
  buildPrompt,
  buildResearchPrompt,
  buildSitePrompt,
  extractRedesignUrl,
  formatUsageTable,
  gatewayModelFromInput,
  normalizeHttpUrl,
  normalizeSlug,
  opencodeModelForGatewayModel,
  parseArgs,
  slugFromUrl,
  usageCostRows,
} from "./redesign.js";

const parsed = parseArgs(["https://acme.test", "--slug", "Acme Plumbing", "--keep-sandbox"]);
assert.deepEqual(parsed.positional, ["https://acme.test"]);
assert.equal(parsed.args.get("slug"), "Acme Plumbing");
assert.equal(parsed.args.get("keep-sandbox"), "true");
assert.throws(() => parseArgs(["--slug"]), /Missing value/);

const parsedAgent = parseArgs(["https://acme.test", "--agent-id", "thread-123"]);
assert.equal(parsedAgent.args.get("agent-id"), "thread-123");

assert.equal(normalizeHttpUrl("acme.test"), "https://acme.test/");
assert.equal(slugFromUrl("https://www.Acme-Plumbing.com/services"), "acme-plumbing");
assert.equal(slugFromUrl("https://jobs.Acme-Plumbing.com/services"), "jobs-acme-plumbing");
assert.equal(normalizeSlug("Acme Plumbing"), "acme-plumbing");
assert.throws(() => normalizeSlug("-"), /Invalid slug/);
assert.equal(gatewayModelFromInput("deepseek/deepseek-v4-pro"), "deepseek/deepseek-v4-pro");
assert.equal(gatewayModelFromInput("vercel/deepseek/deepseek-v4-pro"), "deepseek/deepseek-v4-pro");
assert.equal(opencodeModelForGatewayModel("deepseek/deepseek-v4-pro"), "vercel/deepseek/deepseek-v4-pro");

const prompt = buildPrompt({
  site: "https://acme.test/",
  slug: "acme",
  repoUrl: "https://github.com/redesign-business/acme",
  expectedRedesignUrl: "https://acme.redesign.business",
});

assert.match(prompt, /Scrape the URL for copy and images/);
assert.match(prompt, /raw\.md/);
assert.match(prompt, /proof\.md/);
assert.match(prompt, /\.opencode\/skills\/nextjs-site-building\/SKILL\.md/);
assert.match(prompt, /\.opencode\/skills\/refine-landing-page\/SKILL\.md/);
assert.match(prompt, /\.opencode\/skills\/web-quality-audit\/SKILL\.md/);
assert.match(prompt, /Automated tests are out of scope/);
assert.match(prompt, /Deploy intentionally exactly once/);
assert.match(prompt, /Commit and push to main after each major phase/);
assert.match(prompt, /chore: capture source materials/);
assert.match(prompt, /feat: build landing page/);
assert.match(prompt, /Add acme\.redesign\.business to the acme Vercel project/);
assert.match(prompt, /final Redesign URL must be https:\/\/acme\.redesign\.business/);
assert.match(prompt, /Never print secrets/);

const researchPrompt = buildResearchPrompt({
  site: "https://acme.test/",
  slug: "acme",
  repoUrl: "https://github.com/redesign-business/acme",
});
assert.match(researchPrompt, /1\) Scrape the URL for copy and images/);
assert.match(researchPrompt, /2\) Make a proof\.md/);
assert.match(researchPrompt, /Stop after step 2/);
assert.doesNotMatch(researchPrompt, /Build the site/);

const designPrompt = buildDesignPrompt({
  site: "https://acme.test/",
  slug: "acme",
  repoUrl: "https://github.com/redesign-business/acme",
});
assert.match(designPrompt, /Use proof\.md as the handoff context/);
assert.match(designPrompt, /Create design\.md/);
assert.match(designPrompt, /Design system must include/);
assert.match(designPrompt, /Composition must include/);
assert.match(designPrompt, /Do not build the site/);

const sitePrompt = buildSitePrompt({
  site: "https://acme.test/",
  slug: "acme",
  repoUrl: "https://github.com/redesign-business/acme",
  expectedRedesignUrl: "https://acme.redesign.business",
});
assert.match(sitePrompt, /Build the website from the existing handoff files: design\.md, proof\.md, raw\.md, and images\//);
assert.match(sitePrompt, /Use design\.md as the design handoff/);
assert.match(sitePrompt, /3\) Build the site/);
assert.match(sitePrompt, /4\) Run the refine-landing-page pass/);
assert.match(sitePrompt, /5\) Run the web-quality-audit pass/);
assert.match(sitePrompt, /You are done when you have a URL to the landing page/);

assert.equal(extractRedesignUrl("Original URL: https://old.test\nRedesign URL: https://new.test"), "https://new.test");
assert.equal(extractRedesignUrl("nothing here"), undefined);

assert.equal(
  aliasHostForRedesignUrl("https://acme.vercel.app", "https://acme.redesign.business"),
  "acme.redesign.business",
);
assert.equal(
  aliasHostForRedesignUrl("https://acme.redesign.business", "https://acme.redesign.business"),
  undefined,
);

assert.equal(appendWithoutReplay("hello world", "world again"), " again");
assert.equal(appendWithoutReplay("hello world", "hello world"), "");
assert.equal(appendWithoutReplay("hello world", "fresh"), "fresh");

const usageRows = usageCostRows({
  inputTokens: 1000,
  outputTokens: 500,
  cachedInputTokens: 200,
  cacheCreationInputTokens: 100,
  reasoningTokens: 0,
  requestCount: 2,
  totalCost: 0,
  marketCost: 0,
}, {
  input: 0.000001,
  output: 0.000002,
  cacheRead: 0.0000001,
  cacheWrite: 0.0000015,
});
assert.deepEqual(usageRows.at(-1), { type: "Total", tokens: 1800, cost: 0.00217 });
assert.match(formatUsageTable(usageRows), /\| Token type \| Tokens \| Cost \|/);
assert.match(formatUsageTable(usageRows), /\| Total \| 1,800 \| \$0\.002170 \|/);
