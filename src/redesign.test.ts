import assert from "node:assert/strict";
import {
  aliasHostForRedesignUrl,
  appendWithoutReplay,
  buildDraftPrompt,
  buildResearchPrompt,
  buildSitePrompt,
  extractRedesignUrl,
  gatewayModelFromInput,
  isBudgetFailureOutput,
  normalizeHttpUrl,
  normalizeSlug,
  opencodeModelForGatewayModel,
  parseArgs,
  slugFromUrl,
} from "./redesign.js";
import { normalizeSameDomainUrl, parseSrcset } from "./research.js";

const parsed = parseArgs(["https://acme.test", "--slug", "Acme Plumbing", "--keep-sandbox"]);
assert.deepEqual(parsed.positional, ["https://acme.test"]);
assert.equal(parsed.args.get("slug"), "Acme Plumbing");
assert.equal(parsed.args.get("keep-sandbox"), "true");
assert.throws(() => parseArgs(["--slug"]), /Missing value/);

assert.equal(normalizeHttpUrl("acme.test"), "https://acme.test/");
assert.equal(slugFromUrl("https://www.Acme-Plumbing.com/services"), "acme-plumbing");
assert.equal(slugFromUrl("https://jobs.Acme-Plumbing.com/services"), "jobs-acme-plumbing");
assert.equal(normalizeSlug("Acme Plumbing"), "acme-plumbing");
assert.throws(() => normalizeSlug("-"), /Invalid slug/);
assert.equal(gatewayModelFromInput("deepseek/deepseek-v4-pro"), "deepseek/deepseek-v4-pro");
assert.equal(gatewayModelFromInput("vercel/deepseek/deepseek-v4-pro"), "deepseek/deepseek-v4-pro");
assert.equal(opencodeModelForGatewayModel("deepseek/deepseek-v4-pro"), "vercel/deepseek/deepseek-v4-pro");
assert.equal(isBudgetFailureOutput("AI Gateway quota limit exceeded"), true);
assert.equal(isBudgetFailureOutput("process exited before running build"), false);

const researchPrompt = buildResearchPrompt({
  site: "https://acme.test/",
  slug: "acme",
  repoUrl: "https://github.com/redesign-business/acme",
});
assert.match(researchPrompt, /raw\.md already contains/);
assert.match(researchPrompt, /public\/images\/manifest\.json/);
assert.match(researchPrompt, /Commit and push proof\.md/);
assert.doesNotMatch(researchPrompt, /Build the site/);

const draftPrompt = buildDraftPrompt({
  site: "https://acme.test/",
  slug: "acme",
  repoUrl: "https://github.com/redesign-business/acme",
});
assert.match(draftPrompt, /Build the first draft/);
assert.match(draftPrompt, /\.opencode\/skills\/nextjs-site-building\/SKILL\.md/);
assert.match(draftPrompt, /public\/images\/manifest\.json/);
assert.match(draftPrompt, /Build the site in page\.tsx/);
assert.match(draftPrompt, /Don't build, commit, or push/);

const sitePrompt = buildSitePrompt({
  site: "https://acme.test/",
  slug: "acme",
  repoUrl: "https://github.com/redesign-business/acme",
  expectedRedesignUrl: "https://acme.redesign.business",
});
assert.match(sitePrompt, /Deploy the existing first-draft website/);
assert.match(sitePrompt, /Run production build/);
assert.match(sitePrompt, /feat: build landing page/);
assert.doesNotMatch(sitePrompt, /nextjs-site-building/);
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

assert.equal(
  normalizeSameDomainUrl("/about#team", "https://acme.test/", "https://acme.test"),
  "https://acme.test/about",
);
assert.equal(
  normalizeSameDomainUrl("https://other.test/about", "https://acme.test/", "https://acme.test"),
  undefined,
);
assert.equal(
  normalizeSameDomainUrl("/logo.png", "https://acme.test/", "https://acme.test"),
  undefined,
);
assert.deepEqual(
  parseSrcset("/small.jpg 400w, https://acme.test/large.jpg 1200w", "https://acme.test/work/"),
  ["https://acme.test/small.jpg", "https://acme.test/large.jpg"],
);
