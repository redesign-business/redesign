import { randomUUID } from "node:crypto";
import { neon, type NeonQueryFunction } from "@neondatabase/serverless";

type Row = Record<string, unknown>;

export type StartedRedesignRecord = {
  businessId: string;
  websiteId: string;
  runId: string;
};

export type BusinessSummary = {
  id: string;
  name: string;
  slug: string;
  websiteCount: number;
  runCount: number;
  latestRunAt: string | null;
};

export type BusinessSeed = {
  name: string;
  slug: string;
  website?: string | null;
  email?: string | null;
  contactFormUrl?: string | null;
  phone?: string | null;
  address?: string | null;
  rating?: number | null;
  reviewCount?: number | null;
};

export type WebsiteSeed = {
  businessSlug: string;
  name?: string;
  slug: string;
  sourceUrl: string;
  repoUrl?: string | null;
  expectedRedesignUrl?: string | null;
};

export type SessionSeed = {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  inputCost: number;
  outputCost: number;
  cacheReadCost: number;
  cacheWriteCost: number;
  totalCost: number;
};

let client: NeonQueryFunction<false, false> | undefined;
let schemaReady: Promise<void> | undefined;

function sql() {
  if (!process.env.DATABASE_URL) throw new Error("Missing DATABASE_URL");
  client ??= neon(process.env.DATABASE_URL);
  return client;
}

export async function ensureSchema() {
  schemaReady ??= (async () => {
    const db = sql();
    await db`
      create table if not exists businesses (
        id text primary key,
        name text not null,
        slug text not null unique,
        website text,
        email text,
        contact_form_url text,
        phone text,
        address text,
        rating numeric,
        review_count integer,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      )
    `;
    await db`alter table businesses add column if not exists email text`;
    await db`alter table businesses add column if not exists contact_form_url text`;
    await db`
      create table if not exists websites (
        id text primary key,
        business_id text not null references businesses(id) on delete cascade,
        slug text not null unique,
        repo_url text,
        url text,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      )
    `;
    await db`
      create table if not exists runs (
        id text primary key,
        website_id text not null references websites(id) on delete cascade,
        sandbox text not null unique,
        tmux_session text not null,
        status text not null,
        ai_gateway_budget numeric not null,
        ended_at timestamptz,
        wall_time_seconds integer,
        error text,
        total_tokens integer,
        total_cost numeric,
        data jsonb not null default '{}'::jsonb,
        started_at timestamptz not null,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      )
    `;
    await db`
      create index if not exists runs_website_started_idx
      on runs (website_id, started_at desc)
    `;
    await db`
      create table if not exists sessions (
        id text primary key,
        run_id text not null references runs(id) on delete cascade,
        model text not null,
        input_tokens integer not null default 0,
        output_tokens integer not null default 0,
        cache_read_tokens integer not null default 0,
        cache_write_tokens integer not null default 0,
        total_tokens integer not null default 0,
        input_cost numeric not null default 0,
        output_cost numeric not null default 0,
        cache_read_cost numeric not null default 0,
        cache_write_cost numeric not null default 0,
        total_cost numeric not null default 0,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        unique (run_id, model)
      )
    `;
    await db`create index if not exists sessions_run_idx on sessions (run_id)`;
  })();
  return schemaReady;
}

function id(prefix: string) {
  return `${prefix}_${randomUUID()}`;
}

export async function upsertBusiness(input: BusinessSeed): Promise<string> {
  await ensureSchema();
  const [business] = await sql()`
    insert into businesses (id, name, slug, website, email, contact_form_url, phone, address, rating, review_count)
    values (
      ${id("biz")},
      ${input.name},
      ${input.slug},
      ${input.website ?? null},
      ${input.email ?? null},
      ${input.contactFormUrl ?? null},
      ${input.phone ?? null},
      ${input.address ?? null},
      ${input.rating ?? null},
      ${input.reviewCount ?? null}
    )
    on conflict (slug) do update set
      name = excluded.name,
      website = coalesce(excluded.website, businesses.website),
      email = coalesce(excluded.email, businesses.email),
      contact_form_url = coalesce(excluded.contact_form_url, businesses.contact_form_url),
      phone = coalesce(excluded.phone, businesses.phone),
      address = coalesce(excluded.address, businesses.address),
      rating = coalesce(excluded.rating, businesses.rating),
      review_count = coalesce(excluded.review_count, businesses.review_count),
      updated_at = now()
    returning id
  ` as Row[];
  return String(business.id);
}

export async function upsertWebsite(input: WebsiteSeed): Promise<string> {
  await ensureSchema();
  let [business] = await sql()`select id from businesses where slug = ${input.businessSlug} limit 1` as Row[];
  if (!business) {
    business = (await sql()`
      insert into businesses (id, name, slug)
      values (${id("biz")}, ${input.businessSlug}, ${input.businessSlug})
      returning id
    ` as Row[])[0];
  }

  const [website] = await sql()`
    insert into websites (id, business_id, slug, repo_url, url)
    values (${id("site")}, ${String(business.id)}, ${input.slug}, ${input.repoUrl ?? null}, ${input.expectedRedesignUrl ?? null})
    on conflict (slug) do update set
      business_id = excluded.business_id,
      repo_url = coalesce(excluded.repo_url, websites.repo_url),
      url = coalesce(excluded.url, websites.url),
      updated_at = now()
    returning id
  ` as Row[];
  return String(website.id);
}

export async function recordStartedRedesign(input: {
  businessName: string;
  businessSlug: string;
  websiteSlug: string;
  sourceUrl: string;
  repoUrl: string;
  expectedRedesignUrl: string;
  sandbox: string;
  tmuxSession: string;
  model: string;
  aiGatewayBudget: number;
  startedAt: string;
}): Promise<StartedRedesignRecord> {
  const businessId = await upsertBusiness({ name: input.businessName, slug: input.businessSlug, website: input.sourceUrl });
  const websiteId = await upsertWebsite({
    businessSlug: input.businessSlug,
    slug: input.websiteSlug,
    sourceUrl: input.sourceUrl,
    repoUrl: input.repoUrl,
    expectedRedesignUrl: input.expectedRedesignUrl,
  });
  const runId = id("run");

  await sql()`
    insert into runs (
      id, website_id, sandbox, tmux_session, status, ai_gateway_budget, started_at, data
    ) values (
      ${runId},
      ${websiteId},
      ${input.sandbox},
      ${input.tmuxSession},
      'setup',
      ${input.aiGatewayBudget},
      ${input.startedAt},
      ${JSON.stringify(input)}::jsonb
    )
  `;

  return { businessId, websiteId, runId };
}

export async function upsertRun(input: {
  id?: string;
  websiteId: string;
  sandbox: string;
  tmuxSession?: string;
  status?: string;
  aiGatewayBudget?: number;
  startedAt: string;
  data: Record<string, unknown>;
}): Promise<string> {
  await ensureSchema();
  const runId = input.id ?? id("run");
  const [run] = await sql()`
    insert into runs (
      id, website_id, sandbox, tmux_session, status, ai_gateway_budget, ended_at, wall_time_seconds, error, started_at, data
    ) values (
      ${runId},
      ${input.websiteId},
      ${input.sandbox},
      ${input.tmuxSession ?? "redesign"},
      ${input.status ?? String(input.data.status ?? input.data.phase ?? "unknown")},
      ${input.aiGatewayBudget ?? Number(input.data.aiGatewayBudget ?? 0)},
      ${typeof input.data.endedAt === "string" ? input.data.endedAt : null},
      ${typeof input.data.wallTimeSeconds === "number" ? input.data.wallTimeSeconds : null},
      ${typeof input.data.error === "string" ? input.data.error : null},
      ${input.startedAt},
      ${JSON.stringify(runData(input.data))}::jsonb
    )
    on conflict (sandbox) do update set
      website_id = excluded.website_id,
      tmux_session = excluded.tmux_session,
      status = excluded.status,
      ai_gateway_budget = excluded.ai_gateway_budget,
      ended_at = excluded.ended_at,
      wall_time_seconds = excluded.wall_time_seconds,
      error = excluded.error,
      started_at = excluded.started_at,
      data = runs.data || excluded.data,
      updated_at = now()
    returning id
  ` as Row[];
  if (typeof input.data.redesignUrl === "string") {
    await sql()`update websites set url = ${input.data.redesignUrl}, updated_at = now() where id = ${input.websiteId}`;
  }
  return String(run.id);
}

function runData(fields: Record<string, unknown>) {
  const copy = { ...fields };
  delete copy.sessions;
  delete copy.estimatedUsageByModel;
  delete copy.estimatedTotalUsage;
  delete copy.usageByModel;
  delete copy.totalUsage;
  return copy;
}

export async function updateRunData(runId: string, fields: Record<string, unknown>): Promise<void> {
  await ensureSchema();
  await sql()`
    update runs set
      status = coalesce(${typeof fields.status === "string" ? fields.status : typeof fields.phase === "string" ? fields.phase : null}, status),
      ended_at = coalesce(${typeof fields.endedAt === "string" ? fields.endedAt : null}, ended_at),
      wall_time_seconds = coalesce(${typeof fields.wallTimeSeconds === "number" ? fields.wallTimeSeconds : null}, wall_time_seconds),
      error = coalesce(${typeof fields.error === "string" ? fields.error : null}, error),
      data = data || ${JSON.stringify(runData(fields))}::jsonb,
      updated_at = now()
    where id = ${runId}
  `;
  if (typeof fields.redesignUrl === "string") {
    await sql()`
      update websites
      set url = ${fields.redesignUrl}, updated_at = now()
      where id = (select website_id from runs where id = ${runId})
    `;
  }
}

export async function replaceRunSessions(runId: string, sessions: SessionSeed[]): Promise<void> {
  await ensureSchema();
  await sql()`begin`;
  try {
    await sql()`delete from sessions where run_id = ${runId}`;
    for (const session of sessions) {
      await sql()`
        insert into sessions (
          id, run_id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, total_tokens,
          input_cost, output_cost, cache_read_cost, cache_write_cost, total_cost
        ) values (
          ${id("sess")},
          ${runId},
          ${session.model},
          ${session.inputTokens},
          ${session.outputTokens},
          ${session.cacheReadTokens},
          ${session.cacheWriteTokens},
          ${session.totalTokens},
          ${session.inputCost},
          ${session.outputCost},
          ${session.cacheReadCost},
          ${session.cacheWriteCost},
          ${session.totalCost}
        )
      `;
    }
    await sql()`
      update runs set
        total_tokens = totals.total_tokens,
        total_cost = totals.total_cost,
        updated_at = now()
      from (
        select coalesce(sum(total_tokens), 0)::integer as total_tokens, coalesce(sum(total_cost), 0) as total_cost
        from sessions
        where run_id = ${runId}
      ) totals
      where runs.id = ${runId}
    `;
    await sql()`commit`;
  } catch (error) {
    await sql()`rollback`;
    throw error;
  }
}

export function businessSummaryFromRow(row: Row): BusinessSummary {
  return {
    id: String(row.id),
    name: String(row.name),
    slug: String(row.slug),
    websiteCount: Number(row.website_count),
    runCount: Number(row.run_count),
    latestRunAt: row.latest_run_at ? new Date(String(row.latest_run_at)).toISOString() : null,
  };
}

export async function listBusinesses(): Promise<BusinessSummary[]> {
  await ensureSchema();
  const rows = await sql()`
    select
      b.id,
      b.name,
      b.slug,
      count(distinct w.id) as website_count,
      count(r.id) as run_count,
      max(r.started_at) as latest_run_at
    from businesses b
    left join websites w on w.business_id = b.id
    left join runs r on r.website_id = w.id
    group by b.id
    order by latest_run_at desc nulls last, b.name asc
  ` as Row[];
  return rows.map(businessSummaryFromRow);
}
