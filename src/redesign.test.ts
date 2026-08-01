import assert from "node:assert/strict";
import { businessSummaryFromRow } from "./db.js";
import {
  makeSandboxName,
  normalizeHttpUrl,
  normalizeSlug,
  parseArgs,
  postHogPublicEnv,
  readRequired,
  slugFromUrl,
} from "./redesign.js";
import { normalizeSameDomainUrl, parseSrcset } from "./research.js";

const parsed = parseArgs(["https://acme.test", "--slug", "Acme Plumbing"]);
assert.deepEqual(parsed.positional, ["https://acme.test"]);
assert.equal(parsed.args.get("slug"), "Acme Plumbing");
assert.throws(() => parseArgs(["--slug"]), /Missing value/);
assert.equal(readRequired(parsed.args, "slug"), "Acme Plumbing");
assert.throws(() => readRequired(parsed.args, "sandbox"), /Missing --sandbox/);

assert.equal(normalizeHttpUrl("acme.test"), "https://acme.test/");
assert.equal(slugFromUrl("https://www.Acme-Plumbing.com/services"), "acme-plumbing");
assert.equal(slugFromUrl("https://jobs.Acme-Plumbing.com/services"), "jobs-acme-plumbing");
assert.equal(normalizeSlug("Acme Plumbing"), "acme-plumbing");
assert.throws(() => normalizeSlug("-"), /Invalid slug/);
assert.match(makeSandboxName("acme"), /^redesign-acme-[a-f0-9]{8}$/);

const previousPostHogToken = process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN;
const previousPostHogHost = process.env.NEXT_PUBLIC_POSTHOG_HOST;
process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN = "phc_test";
delete process.env.NEXT_PUBLIC_POSTHOG_HOST;
assert.deepEqual(postHogPublicEnv("acme"), {
  NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN: "phc_test",
  NEXT_PUBLIC_POSTHOG_HOST: "https://us.i.posthog.com",
  NEXT_PUBLIC_REDESIGN_SLUG: "acme",
});
if (previousPostHogToken === undefined) delete process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN;
else process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN = previousPostHogToken;
if (previousPostHogHost === undefined) delete process.env.NEXT_PUBLIC_POSTHOG_HOST;
else process.env.NEXT_PUBLIC_POSTHOG_HOST = previousPostHogHost;

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

assert.deepEqual(businessSummaryFromRow({
  id: "biz_1",
  name: "Acme Fitness",
  slug: "acme-fitness",
  website_count: "2",
  run_count: "3",
  latest_run_at: "2026-07-31T01:00:00.000Z",
}), {
  id: "biz_1",
  name: "Acme Fitness",
  slug: "acme-fitness",
  websiteCount: 2,
  runCount: 3,
  latestRunAt: "2026-07-31T01:00:00.000Z",
});
