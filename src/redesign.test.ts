import assert from "node:assert/strict";
import {
  aliasHostForRedesignUrl,
  appendWithoutReplay,
  buildDraftPrompt,
  buildResearchPrompt,
  buildSitePrompt,
  extractRedesignUrl,
  gatewayModelFromInput,
  normalizeHttpUrl,
  normalizeSlug,
  opencodeModelForGatewayModel,
  parseArgs,
  slugFromUrl,
} from "./redesign.js";

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

const researchPrompt = buildResearchPrompt({
  site: "https://acme.test/",
  slug: "acme",
  repoUrl: "https://github.com/redesign-business/acme",
});
assert.match(researchPrompt, /1\) Scrape the URL for copy and images/);
assert.match(researchPrompt, /2\) Make a proof\.md/);
assert.match(researchPrompt, /raw\.md, proof\.md, and images\/ are pushed/);
assert.doesNotMatch(researchPrompt, /Build the site/);

const draftPrompt = buildDraftPrompt({
  site: "https://acme.test/",
  slug: "acme",
  repoUrl: "https://github.com/redesign-business/acme",
});
assert.match(draftPrompt, /Build the first draft/);
assert.match(draftPrompt, /\.opencode\/skills\/nextjs-site-building\/SKILL\.md/);
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
