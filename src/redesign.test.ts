import assert from "node:assert/strict";
import { businessSummaryFromRow } from "./db.js";
import { phaseComplete, redactSessionOutput } from "./phase.js";
import { applyRelumeCompatibility, parseRelumeComponents, relumeComponentApi } from "./relume.js";
import {
  githubRepoFromUrl,
  makeSandboxName,
  normalizeHttpUrl,
  normalizeSlug,
  parseArgs,
  postHogPublicEnv,
  readRequired,
  refillAiGatewayKey,
  selectRedesignCandidates,
  slugFromUrl,
  websiteHost,
} from "./redesign.js";
import { extractContactInfo, extractOutreachProof, invalidPageLinks, isLikelyLogo, normalizeSameDomainUrl, parseSrcset, relumeButtonLabelsUseChildren, validLinkTargets } from "./research.js";

assert.equal(phaseComplete(0), true);
assert.equal(phaseComplete(0, false), false);
assert.equal(phaseComplete(1, true), true);
assert.equal(redactSessionOutput("used secret-token and ok", ["secret-token", "short"]), "used [REDACTED] and ok");
assert.deepEqual(parseRelumeComponents({ content: [{ type: "text", text: [
  "// File: Header1.tsx",
  "```tsx",
  "export const Header1 = () => null;",
  "```",
  "// File: components/ui/accordion.tsx",
  "```tsx",
  "export const Accordion = () => null;",
  "```",
  "npm i motion@^12.0.0 clsx",
].join("\n") }] }), {
  files: [
    { path: "components/relume/Header1.tsx", content: "export const Header1 = () => null;\n" },
    { path: "components/ui/accordion.tsx", content: "export const Accordion = () => null;\n" },
  ],
  dependencies: ["motion@^12.0.0", "clsx"],
});
assert.deepEqual(applyRelumeCompatibility([
  'import { motion } from "motion/react";',
  "<img src={logo.src} alt={logo.alt} />",
  '<img src={logo.src} alt={logo.alt} className="inline-block" />',
  "const lineVariants = { open: { transition: { ease: \"easeInOut\" } } };",
].join("\n")), {
  content: [
    'import { type Variants, motion } from "motion/react";',
    '<img className="h-6 w-auto max-w-[70vw] md:h-8" src={logo.src} alt={logo.alt} />',
    '<img src={logo.src} alt={logo.alt} className="inline-block h-6 w-auto max-w-[70vw] md:h-8" />',
    "const lineVariants: Variants = { open: { transition: { ease: \"easeInOut\" } } };",
  ].join("\n"),
  edits: 3,
});
assert.deepEqual(applyRelumeCompatibility('<img className="h-6 w-auto max-w-[70vw] md:h-8" src={logo.src} alt={logo.alt} />'), {
  content: '<img className="h-6 w-auto max-w-[70vw] md:h-8" src={logo.src} alt={logo.alt} />',
  edits: 0,
});
assert.deepEqual(validLinkTargets(["https://acme.test/", "https://acme.test/contact"], [
  { type: "email", value: "hello@acme.test" },
  { type: "phone", value: "+17755550100" },
]), ["/", "https://acme.test/", "https://acme.test/contact", "mailto:hello@acme.test", "tel:+17755550100"]);
assert.deepEqual(invalidPageLinks([
  '<section id="contact">',
  'const siteUrl = "https://acme.test";',
  'const nav = { url: "#contact" };',
  'const home = { url: "/" };',
  'const contact = { url: `${siteUrl}/contact` };',
  'const bad = { url: "/invented" };',
].join("\n"), ["/", "https://acme.test/contact"]), ["/invented"]);
assert.equal(relumeButtonLabelsUseChildren('buttons={[{ children: "Contact", href: "/contact" }]}'), true);
assert.equal(relumeButtonLabelsUseChildren('buttons={[{ title: "Contact", href: "/contact" }]}'), false);
assert.equal(relumeComponentApi("components/relume/Header1.tsx", [
  "type Props = { heading: string };",
  "export type Header1Props = Partial<Props>;",
  "export const Header1 = (props: Header1Props) => {",
  "  return null;",
  "};",
].join("\n")), [
  "## components/relume/Header1.tsx",
  "",
  "```tsx",
  "type Props = { heading: string };",
  "export type Header1Props = Partial<Props>;",
  "export const Header1 = (props: Header1Props) => {",
  "```",
  "",
].join("\n"));

const parsed = parseArgs(["https://acme.test", "--slug", "Acme Plumbing"]);
assert.deepEqual(parsed.positional, ["https://acme.test"]);
assert.equal(parsed.args.get("slug"), "Acme Plumbing");
assert.throws(() => parseArgs(["--slug"]), /Missing value/);
assert.equal(readRequired(parsed.args, "slug"), "Acme Plumbing");
assert.throws(() => readRequired(parsed.args, "sandbox"), /Missing --sandbox/);
assert.equal(normalizeHttpUrl("acme.test"), "https://acme.test/");
assert.equal(slugFromUrl("https://www.Acme-Plumbing.com/services"), "acme-plumbing");
assert.equal(slugFromUrl("https://jobs.Acme-Plumbing.com/services"), "jobs-acme-plumbing");
assert.equal(websiteHost("https://www.Acme-Plumbing.com/services"), "acme-plumbing.com");
assert.equal(normalizeSlug("Acme Plumbing"), "acme-plumbing");
assert.throws(() => normalizeSlug("-"), /Invalid slug/);
assert.match(makeSandboxName("acme"), /^redesign-acme-[a-f0-9]{8}$/);

const selectedCandidates = selectRedesignCandidates([
  { id: "1", name: "Acme", slug: "acme", website: "https://www.acme.test/", email: "hello@acme.test" },
  { id: "2", name: "Acme Location", slug: "acme-location", website: "https://acme.test/location", email: "office@acme.test" },
  { id: "3", name: "Beta", slug: "beta", website: "https://beta.test/", email: "privacy@beta.test" },
  { id: "4", name: "Gamma", slug: "gamma", website: "https://gamma.test/", email: "hello@gamma.test" },
  { id: "5", name: "Delta", slug: "delta", website: "https://delta.test/", email: "info@delta.test" },
  { id: "6", name: "Other", slug: "other", website: "https://other.test/", email: "info@unrelated.test" },
], [{ sourceUrl: "https://gamma.test/", slug: "gamma", email: "hello@gamma.test" }], 100);
assert.deepEqual(selectedCandidates.map(({ name, redesignSlug }) => ({ name, redesignSlug })), [
  { name: "Acme", redesignSlug: "acme" },
  { name: "Delta", redesignSlug: "delta" },
]);
assert.deepEqual(githubRepoFromUrl("https://github.com/redesign-business/acme", "fallback"), {
  owner: "redesign-business",
  repo: "acme",
});
assert.deepEqual(githubRepoFromUrl("git@github.com:redesign-business/acme.git", "fallback"), {
  owner: "redesign-business",
  repo: "acme",
});

const originalFetch = globalThis.fetch;
const quotaRequests: Array<{ method: string; url: string; authorization: string | null; body?: unknown }> = [];
globalThis.fetch = (async (input, init) => {
  const request = new Request(input, init);
  quotaRequests.push({
    method: request.method,
    url: request.url,
    authorization: request.headers.get("authorization"),
    body: request.method === "PATCH" ? await request.json() : undefined,
  });
  if (request.method === "PATCH") return Response.json({ active: true });
  return Response.json({ active: true, currentSpend: 0.4, limitAmount: 1.4 });
}) as typeof fetch;
try {
  await refillAiGatewayKey({ id: "key_1", key: "secret", name: "pool-1", budget: 1 });
} finally {
  globalThis.fetch = originalFetch;
}
assert.deepEqual(quotaRequests, [
  { method: "GET", url: "https://ai-gateway.vercel.sh/v1/quotas?quotaEntityId=api_key_id_key_1", authorization: "Bearer secret", body: undefined },
  { method: "PATCH", url: "https://ai-gateway.vercel.sh/v1/quotas?quotaEntityId=api_key_id_key_1", authorization: "Bearer secret", body: { active: true, limitAmount: 1.4, refreshPeriod: "none" } },
  { method: "GET", url: "https://ai-gateway.vercel.sh/v1/quotas?quotaEntityId=api_key_id_key_1", authorization: "Bearer secret", body: undefined },
]);

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
assert.equal(isLikelyLogo({ sourceUrl: "https://acme.test/images/logo.svg" }), true);
assert.equal(isLikelyLogo({ sourceUrl: "https://acme.test/images/house.jpg", alt: "Completed home" }), false);
assert.deepEqual(
  extractContactInfo('<a href="mailto:hello@acme.test?subject=Hi">Email us</a><a href="/contact">Get a quote</a>', "https://acme.test/"),
  { email: "hello@acme.test", contactFormUrl: undefined, phone: undefined, contactMethods: [{ type: "email", value: "hello@acme.test" }] },
);
assert.deepEqual(
  extractContactInfo('<form><input name="name"><input type="email"><textarea name="message"></textarea></form>', "https://acme.test/contact"),
  { email: undefined, contactFormUrl: "https://acme.test/contact", phone: undefined, contactMethods: [{ type: "contact_form", value: "https://acme.test/contact" }] },
);
assert.deepEqual(
  extractContactInfo('<a href="mailto:owner@gmail.com">Owner</a><a href="mailto:hello@acme.test">Office</a><a href="tel:(775) 555-0100">Call</a>', "https://acme.test/"),
  {
    email: "hello@acme.test",
    contactFormUrl: undefined,
    phone: "+17755550100",
    contactMethods: [
      { type: "email", value: "owner@gmail.com" },
      { type: "email", value: "hello@acme.test" },
      { type: "phone", value: "+17755550100" },
    ],
  },
);
assert.equal(
  extractContactInfo('<a href="mailto:hello@acme.com828-555-0100">Email us</a>', "https://acme.test/").email,
  "hello@acme.com",
);
assert.equal(extractContactInfo("<p>example@email.com</p>", "https://acme.test/").email, undefined);
assert.deepEqual(extractOutreachProof("## Outreach\n- Built 500 homes.\n- Rated 4.9 stars.\n- Serving Tahoe since 1982.\n\n## Evidence\nMore"), [
  "Built 500 homes.",
  "Rated 4.9 stars.",
  "Serving Tahoe since 1982.",
]);
assert.deepEqual(extractOutreachProof("## Outreach\n- Built 500 homes\n- Rated 4.9 stars\n- Serving Tahoe since 1982"), [
  "Built 500 homes.",
  "Rated 4.9 stars.",
  "Serving Tahoe since 1982.",
]);
assert.deepEqual(extractOutreachProof("## Outreach\n1. Built 500 homes.\n2. Rated 4.9 stars.\n3. Serving Tahoe since 1982."), [
  "Built 500 homes.",
  "Rated 4.9 stars.",
  "Serving Tahoe since 1982.",
]);
assert.throws(() => extractOutreachProof("## Outreach\n- Only one."), /exactly three/);
assert.equal(
  extractContactInfo('<form><input name="student"><input type="email"><button>Register</button></form>', "https://acme.test/classes").contactFormUrl,
  undefined,
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
