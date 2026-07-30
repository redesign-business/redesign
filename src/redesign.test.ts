import assert from "node:assert/strict";
import {
  makeSandboxName,
  normalizeHttpUrl,
  normalizeSlug,
  parseArgs,
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
