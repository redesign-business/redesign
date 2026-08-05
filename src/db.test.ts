import assert from "node:assert/strict";
import { config as loadEnv } from "dotenv";
import { neon } from "@neondatabase/serverless";
import { deleteWebsiteRecord, listBusinesses, listDiscoveryFunnel, recordBusinessDiscovery, recordStartedRedesign, replaceRunSessions, updateBusinessContactInfo, updateBusinessDiscoveryContactInfo, updateRunData, upsertDiscoveredBusiness, upsertRun } from "./db.js";

loadEnv({ path: ".env.local", quiet: true });

if (!process.env.DATABASE_URL) {
  if (process.env.REQUIRE_DATABASE_URL) throw new Error("Missing DATABASE_URL");
  console.log("Skipping db.test.ts: missing DATABASE_URL");
} else {
  const db = neon(process.env.DATABASE_URL);
  const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const businessSlug = `test-business-${suffix}`;
  const websiteSlug = `test-website-${suffix}`;
  const secondWebsiteSlug = `test-website-2-${suffix}`;
  const sandbox = `test-sandbox-${suffix}`;
  const placeId = `test-place-${suffix}`;

  try {
    const discovered = await upsertDiscoveredBusiness({
      googlePlaceId: placeId,
      googleBusinessStatus: "OPERATIONAL",
      name: "Discovered Test Business",
      slug: `discovered-${suffix}`,
      website: "https://discovered.example.test/",
      address: "123 Test Street",
    });
    await updateBusinessDiscoveryContactInfo(discovered.id, {
      email: "hello@discovered.example.test",
      contactFormUrl: "https://discovered.example.test/contact",
      emailVerificationStatus: "verified",
      emailCatchAll: true,
    });
    const testCategory = `test-category-${suffix}`;
    const testArea = `test-area-${suffix}`;
    await recordBusinessDiscovery(discovered.id, testCategory, testArea);
    await recordBusinessDiscovery(discovered.id, testCategory, `${testArea}-overlap`);
    const [discoveredRow] = await db`
      select google_place_id, email_verification_status, email_catch_all
      from businesses
      where id = ${discovered.id}
    `;
    assert.deepEqual(discoveredRow, {
      google_place_id: placeId,
      email_verification_status: "verified",
      email_catch_all: true,
    });
    const funnel = await listDiscoveryFunnel();
    assert.deepEqual(funnel.find((row) => row.category === testCategory && row.area === testArea), {
      category: testCategory,
      area: testArea,
      total: 1,
      withWebsite: 1,
      verifiedEmail: 1,
      verifiedCatchAll: 1,
      contactForm: 1,
      contactable: 1,
      invalidEmail: 0,
      websitePercent: 100,
      verifiedEmailPercent: 100,
      contactFormPercent: 100,
      contactablePercent: 100,
    });

    const first = await recordStartedRedesign({
      businessName: "Test Business",
      businessSlug,
      websiteSlug,
      sourceUrl: "https://example.test/",
      repoUrl: "https://github.com/redesign-business/test-website",
      expectedRedesignUrl: "https://test-website.redesign.business",
      sandbox,
      tmuxSession: "redesign",
      model: "model-a",
      aiGatewayBudget: 1,
      startedAt: "2026-07-31T00:00:00.000Z",
    });
    const second = await recordStartedRedesign({
      businessName: "Test Business Renamed",
      businessSlug,
      websiteSlug: secondWebsiteSlug,
      sourceUrl: "https://second.example.test/",
      repoUrl: "https://github.com/redesign-business/test-website-2",
      expectedRedesignUrl: "https://test-website-2.redesign.business",
      sandbox: `${sandbox}-2`,
      tmuxSession: "redesign",
      model: "model-b",
      aiGatewayBudget: 2,
      startedAt: "2026-07-31T01:00:00.000Z",
    });

    assert.equal(first.businessId, second.businessId);
    assert.notEqual(first.websiteId, second.websiteId);
    assert.notEqual(first.runId, second.runId);
    await updateBusinessContactInfo(first.businessId, {
      email: "owner@example.test",
      contactFormUrl: "https://example.test/contact",
    });
    await updateRunData(first.runId, { status: "deploy", redesignUrl: "https://test-website.redesign.business", nested: { ok: true } });
    await replaceRunSessions(first.runId, [
      {
        model: "deepseek/deepseek-v4-pro",
        inputTokens: 10,
        outputTokens: 20,
        cacheReadTokens: 30,
        cacheWriteTokens: 40,
        totalTokens: 100,
        inputCost: 0.01,
        outputCost: 0.02,
        cacheReadCost: 0.03,
        cacheWriteCost: 0.04,
        totalCost: 0.10,
      },
      {
        model: "openai/gpt-5.6-sol",
        inputTokens: 1,
        outputTokens: 2,
        cacheReadTokens: 3,
        cacheWriteTokens: 4,
        totalTokens: 10,
        inputCost: 0.11,
        outputCost: 0.12,
        cacheReadCost: 0.13,
        cacheWriteCost: 0.14,
        totalCost: 0.50,
      },
    ]);
    await upsertRun({
      websiteId: first.websiteId,
      sandbox: `${sandbox}-seeded`,
      status: "succeeded",
      aiGatewayBudget: 3,
      startedAt: "2026-07-31T02:00:00.000Z",
      data: { status: "succeeded", wallTimeSeconds: 10 },
    });

    const [summary] = (await listBusinesses()).filter((business) => business.slug === businessSlug);
    assert.equal(summary.name, "Test Business Renamed");
    assert.equal(summary.websiteCount, 2);
    assert.equal(summary.runCount, 3);
    assert.equal(summary.latestRunAt, "2026-07-31T02:00:00.000Z");

    const rows = await db`
      select b.slug as business_slug, b.email, b.contact_form_url, w.slug as website_slug, w.url, r.sandbox, r.status, r.data, r.total_tokens, r.total_cost
      from businesses b
      join websites w on w.business_id = b.id
      join runs r on r.website_id = w.id
      where b.slug = ${businessSlug}
      order by r.sandbox
    `;
    assert.deepEqual(rows.map((row) => ({
      businessSlug: row.business_slug,
      email: row.email,
      contactFormUrl: row.contact_form_url,
      websiteSlug: row.website_slug,
      sandbox: row.sandbox,
      status: row.status,
      url: row.url,
      totalTokens: row.total_tokens,
      totalCost: row.total_cost === null ? null : Number(row.total_cost),
      nestedOk: row.data?.nested?.ok ?? null,
    })), [
      { businessSlug, email: "owner@example.test", contactFormUrl: "https://example.test/contact", websiteSlug, sandbox, status: "deploy", url: "https://test-website.redesign.business", totalTokens: 110, totalCost: 0.6, nestedOk: true },
      { businessSlug, email: "owner@example.test", contactFormUrl: "https://example.test/contact", websiteSlug: secondWebsiteSlug, sandbox: `${sandbox}-2`, status: "setup", url: "https://test-website-2.redesign.business", totalTokens: null, totalCost: null, nestedOk: null },
      { businessSlug, email: "owner@example.test", contactFormUrl: "https://example.test/contact", websiteSlug, sandbox: `${sandbox}-seeded`, status: "succeeded", url: "https://test-website.redesign.business", totalTokens: null, totalCost: null, nestedOk: null },
    ]);

    const sessions = await db`
      select model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, total_tokens, input_cost, output_cost, cache_read_cost, cache_write_cost, total_cost
      from sessions
      where run_id = ${first.runId}
      order by model
    `;
    assert.deepEqual(sessions.map((session) => ({
      model: session.model,
      inputTokens: session.input_tokens,
      outputTokens: session.output_tokens,
      cacheReadTokens: session.cache_read_tokens,
      cacheWriteTokens: session.cache_write_tokens,
      totalTokens: session.total_tokens,
      inputCost: Number(session.input_cost),
      outputCost: Number(session.output_cost),
      cacheReadCost: Number(session.cache_read_cost),
      cacheWriteCost: Number(session.cache_write_cost),
      totalCost: Number(session.total_cost),
    })), [
      { model: "deepseek/deepseek-v4-pro", inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 40, totalTokens: 100, inputCost: 0.01, outputCost: 0.02, cacheReadCost: 0.03, cacheWriteCost: 0.04, totalCost: 0.1 },
      { model: "openai/gpt-5.6-sol", inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4, totalTokens: 10, inputCost: 0.11, outputCost: 0.12, cacheReadCost: 0.13, cacheWriteCost: 0.14, totalCost: 0.5 },
    ]);

    assert.equal(await deleteWebsiteRecord(websiteSlug), true);
    const [counts] = await db`
      select
        (select count(*) from websites where slug = ${websiteSlug}) as websites,
        (
          select count(*) from runs
          where sandbox in (${sandbox}, ${`${sandbox}-seeded`})
        ) as runs,
        (select count(*) from sessions where run_id = ${first.runId}) as sessions
    `;
    assert.deepEqual({
      websites: Number(counts.websites),
      runs: Number(counts.runs),
      sessions: Number(counts.sessions),
    }, { websites: 0, runs: 0, sessions: 0 });

  } finally {
    await db`delete from businesses where google_place_id = ${placeId}`;
    await db`
      delete from runs
      where website_id in (
        select w.id from websites w
        join businesses b on b.id = w.business_id
        where b.slug = ${businessSlug}
      )
    `;
    await db`
      delete from websites
      where business_id in (select id from businesses where slug = ${businessSlug})
    `;
    await db`delete from businesses where slug = ${businessSlug}`;
  }
}
