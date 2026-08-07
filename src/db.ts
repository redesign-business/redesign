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

export type ContactMethodSeed = {
  type: "email" | "contact_form" | "phone";
  value: string;
  verificationStatus?: string | null;
  catchAll?: boolean | null;
};

export type DiscoveredBusinessSeed = {
  googlePlaceId: string;
  googleBusinessStatus?: string | null;
  name: string;
  slug: string;
  website?: string | null;
  address?: string | null;
};

export type DiscoveredBusinessRecord = {
  id: string;
  name: string;
  website: string | null;
  googleBusinessStatus: string | null;
  email: string | null;
  emailVerificationStatus: string | null;
  emailCatchAll: boolean | null;
  contactFormUrl: string | null;
  contactCheckedAt: string | null;
};

export type DiscoveryFunnelRow = {
  category: string | null;
  area: string | null;
  total: number;
  withWebsite: number;
  verifiedEmail: number;
  verifiedCatchAll: number;
  contactForm: number;
  contactable: number;
  invalidEmail: number;
  websitePercent: number;
  verifiedEmailPercent: number;
  contactFormPercent: number;
  contactablePercent: number;
};

export type BusinessContactRecord = {
  id: string;
  name: string;
  slug: string;
  website: string;
  email: string | null;
  contactFormUrl: string | null;
};

export type RedesignCandidateRecord = {
  id: string;
  name: string;
  slug: string;
  website: string;
  email: string;
};

export type ExistingRedesignRecord = {
  sourceUrl: string;
  slug: string;
  email: string | null;
};

export type RunCompletionRecord = {
  status: string;
  endedAt: string | null;
  error: string | null;
  totalCost: number | null;
  redesignUrl: string | null;
  proofSentences: string[];
};

export type WebsiteSeed = {
  businessSlug: string;
  name?: string;
  slug: string;
  sourceUrl: string;
  repoUrl?: string | null;
  expectedRedesignUrl?: string | null;
};

export type WebsiteRecord = {
  id: string;
  slug: string;
  repoUrl: string | null;
  url: string | null;
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
        google_place_id text,
        google_business_status text,
        email_verification_status text,
        email_catch_all boolean,
        contact_checked_at timestamptz,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      )
    `;
    await db`alter table businesses add column if not exists email text`;
    await db`alter table businesses add column if not exists contact_form_url text`;
    await db`alter table businesses add column if not exists phone text`;
    await db`alter table businesses add column if not exists google_place_id text`;
    await db`alter table businesses add column if not exists google_business_status text`;
    await db`alter table businesses add column if not exists email_verification_status text`;
    await db`alter table businesses add column if not exists email_catch_all boolean`;
    await db`alter table businesses add column if not exists contact_checked_at timestamptz`;
    await db`
      create unique index if not exists businesses_google_place_id_idx
      on businesses (google_place_id)
      where google_place_id is not null
    `;
    await db`
      create table if not exists contact_methods (
        id text primary key,
        business_id text not null references businesses(id) on delete cascade,
        type text not null check (type in ('email', 'contact_form', 'phone')),
        value text not null,
        verification_status text,
        catch_all boolean,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        unique (business_id, type, value)
      )
    `;
    await db`alter table contact_methods add column if not exists id text`;
    await db`alter table contact_methods add column if not exists verification_status text`;
    await db`alter table contact_methods add column if not exists catch_all boolean`;
    await db`alter table contact_methods add column if not exists created_at timestamptz not null default now()`;
    await db`alter table contact_methods add column if not exists updated_at timestamptz not null default now()`;
    await db`update contact_methods set id = 'cm_' || gen_random_uuid() where id is null`;
    await db`alter table contact_methods alter column id set not null`;
    await db`
      do $$
      begin
        if not exists (
          select 1 from pg_constraint
          where conrelid = 'contact_methods'::regclass
            and contype = 'p'
            and conkey = array[(select attnum from pg_attribute where attrelid = 'contact_methods'::regclass and attname = 'id')]::smallint[]
        ) then
          alter table contact_methods drop constraint if exists contact_methods_pkey;
          alter table contact_methods add primary key (id);
        end if;
      end $$
    `;
    await db`create unique index if not exists contact_methods_business_type_value_idx on contact_methods (business_id, type, value)`;
    await db`
      insert into contact_methods (id, business_id, type, value, verification_status, catch_all)
      select 'cm_' || gen_random_uuid(), id, 'email', lower(email), email_verification_status, email_catch_all
      from businesses where email is not null
      union all
      select 'cm_' || gen_random_uuid(), id, 'contact_form', contact_form_url, null, null
      from businesses where contact_form_url is not null
      union all
      select 'cm_' || gen_random_uuid(), id, 'phone', phone, null, null
      from businesses where phone is not null
      on conflict (business_id, type, value) do update set
        verification_status = coalesce(excluded.verification_status, contact_methods.verification_status),
        catch_all = coalesce(excluded.catch_all, contact_methods.catch_all),
        updated_at = now()
    `;
    await db`
      create table if not exists business_discoveries (
        id text primary key,
        business_id text not null references businesses(id) on delete cascade,
        category text not null,
        area text not null,
        discovered_at timestamptz not null default now(),
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        unique (business_id, category, area)
      )
    `;
    await db`alter table business_discoveries add column if not exists id text`;
    await db`alter table business_discoveries add column if not exists created_at timestamptz not null default now()`;
    await db`alter table business_discoveries add column if not exists updated_at timestamptz not null default now()`;
    await db`update business_discoveries set id = 'dis_' || gen_random_uuid() where id is null`;
    await db`alter table business_discoveries alter column id set not null`;
    await db`
      do $$
      begin
        if not exists (
          select 1 from pg_constraint
          where conrelid = 'business_discoveries'::regclass
            and contype = 'p'
            and conkey = array[(select attnum from pg_attribute where attrelid = 'business_discoveries'::regclass and attname = 'id')]::smallint[]
        ) then
          alter table business_discoveries drop constraint if exists business_discoveries_pkey;
          alter table business_discoveries add primary key (id);
        end if;
      end $$
    `;
    await db`create unique index if not exists business_discoveries_business_category_area_idx on business_discoveries (business_id, category, area)`;
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

export async function upsertDiscoveredBusiness(input: DiscoveredBusinessSeed): Promise<DiscoveredBusinessRecord> {
  await ensureSchema();
  const [business] = await sql()`
    insert into businesses (id, name, slug, website, address, google_place_id, google_business_status)
    values (
      ${id("biz")},
      ${input.name},
      ${input.slug},
      ${input.website ?? null},
      ${input.address ?? null},
      ${input.googlePlaceId},
      ${input.googleBusinessStatus ?? null}
    )
    on conflict (google_place_id) where google_place_id is not null do update set
      name = excluded.name,
      website = coalesce(excluded.website, businesses.website),
      address = coalesce(excluded.address, businesses.address),
      google_business_status = excluded.google_business_status,
      updated_at = now()
    returning id, name, website, google_business_status, email, email_verification_status, email_catch_all, contact_form_url, contact_checked_at
  ` as Row[];
  return {
    id: String(business.id),
    name: String(business.name),
    website: business.website === null ? null : String(business.website),
    googleBusinessStatus: business.google_business_status === null ? null : String(business.google_business_status),
    email: business.email === null ? null : String(business.email),
    emailVerificationStatus: business.email_verification_status === null ? null : String(business.email_verification_status),
    emailCatchAll: business.email_catch_all === null ? null : Boolean(business.email_catch_all),
    contactFormUrl: business.contact_form_url === null ? null : String(business.contact_form_url),
    contactCheckedAt: business.contact_checked_at === null ? null : new Date(String(business.contact_checked_at)).toISOString(),
  };
}

export async function listBusinessesForDiscoveryQualification(): Promise<DiscoveredBusinessRecord[]> {
  await ensureSchema();
  const rows = await sql()`
    select distinct b.id, b.name, b.website, b.google_business_status, b.email,
      b.email_verification_status, b.email_catch_all, b.contact_form_url, b.contact_checked_at
    from businesses b
    join business_discoveries d on d.business_id = b.id
    where b.website is not null
      and b.google_business_status is distinct from 'CLOSED_PERMANENTLY'
      and (b.contact_checked_at is null or b.email_verification_status = 'pending')
    order by b.name
  ` as Row[];
  return rows.map((business) => ({
    id: String(business.id),
    name: String(business.name),
    website: String(business.website),
    googleBusinessStatus: business.google_business_status === null ? null : String(business.google_business_status),
    email: business.email === null ? null : String(business.email),
    emailVerificationStatus: business.email_verification_status === null ? null : String(business.email_verification_status),
    emailCatchAll: business.email_catch_all === null ? null : Boolean(business.email_catch_all),
    contactFormUrl: business.contact_form_url === null ? null : String(business.contact_form_url),
    contactCheckedAt: business.contact_checked_at === null ? null : new Date(String(business.contact_checked_at)).toISOString(),
  }));
}

export async function recordBusinessDiscovery(businessId: string, category: string, area: string): Promise<void> {
  await ensureSchema();
  await sql()`
    insert into business_discoveries (id, business_id, category, area)
    values (${id("dis")}, ${businessId}, ${category}, ${area})
    on conflict (business_id, category, area) do update set updated_at = now()
  `;
}

export async function listDiscoveryFunnel(): Promise<DiscoveryFunnelRow[]> {
  await ensureSchema();
  const rows = await sql()`
    select
      case when grouping(d.category) = 0 then d.category end as category,
      case when grouping(d.area) = 0 then d.area end as area,
      count(distinct b.id) as total,
      count(distinct b.id) filter (where b.website is not null) as with_website,
      count(distinct b.id) filter (where b.email_verification_status = 'verified') as verified_email,
      count(distinct b.id) filter (where b.email_verification_status = 'verified' and b.email_catch_all is true) as verified_catch_all,
      count(distinct b.id) filter (where exists (
        select 1 from contact_methods cm where cm.business_id = b.id and cm.type = 'contact_form'
      )) as contact_form,
      count(distinct b.id) filter (
        where b.email_verification_status = 'verified' or exists (
          select 1 from contact_methods cm where cm.business_id = b.id and cm.type = 'contact_form'
        )
      ) as contactable,
      count(distinct b.id) filter (where b.email_verification_status = 'invalid') as invalid_email
    from business_discoveries d
    join businesses b on b.id = d.business_id
    group by grouping sets ((), (d.category), (d.area), (d.category, d.area))
    order by category nulls first, area nulls first
  ` as Row[];
  return rows.map((row) => {
    const total = Number(row.total);
    const contactable = Number(row.contactable);
    const percent = (count: number) => total === 0 ? 0 : Math.round((count / total) * 1_000) / 10;
    const withWebsite = Number(row.with_website);
    const verifiedEmail = Number(row.verified_email);
    const contactForm = Number(row.contact_form);
    return {
      category: row.category === null ? null : String(row.category),
      area: row.area === null ? null : String(row.area),
      total,
      withWebsite,
      verifiedEmail,
      verifiedCatchAll: Number(row.verified_catch_all),
      contactForm,
      contactable,
      invalidEmail: Number(row.invalid_email),
      websitePercent: percent(withWebsite),
      verifiedEmailPercent: percent(verifiedEmail),
      contactFormPercent: percent(contactForm),
      contactablePercent: percent(contactable),
    };
  });
}

export async function updateBusinessDiscoveryContactInfo(
  businessId: string,
  input: {
    email?: string;
    contactFormUrl?: string;
    phone?: string;
    contactMethods?: ContactMethodSeed[];
    emailVerificationStatus?: string;
    emailCatchAll?: boolean | null;
  },
): Promise<void> {
  await ensureSchema();
  await sql()`
    update businesses set
      email = coalesce(${input.email ?? null}, email),
      contact_form_url = coalesce(${input.contactFormUrl ?? null}, contact_form_url),
      phone = coalesce(${input.phone ?? null}, phone),
      email_verification_status = case
        when ${input.email !== undefined} then ${input.emailVerificationStatus ?? null}
        else email_verification_status
      end,
      email_catch_all = case
        when ${input.email !== undefined} then ${input.emailCatchAll ?? null}
        else email_catch_all
      end,
      contact_checked_at = now(),
      updated_at = now()
    where id = ${businessId}
  `;
  const methods = input.contactMethods ?? [];
  await upsertContactMethods(businessId, input.email ? [
    ...methods,
    {
      type: "email",
      value: input.email.toLowerCase(),
      verificationStatus: input.emailVerificationStatus,
      catchAll: input.emailCatchAll,
    },
  ] : methods);
}

export async function updateBusinessContactInfo(
  businessId: string,
  input: Pick<BusinessSeed, "email" | "contactFormUrl" | "phone"> & { contactMethods?: ContactMethodSeed[] },
): Promise<void> {
  if (!input.email && !input.contactFormUrl && !input.phone && !input.contactMethods?.length) return;
  await ensureSchema();
  await sql()`
    update businesses set
      email = coalesce(email, ${input.email ?? null}),
      contact_form_url = coalesce(contact_form_url, ${input.contactFormUrl ?? null}),
      phone = coalesce(phone, ${input.phone ?? null}),
      updated_at = now()
    where id = ${businessId}
  `;
  await upsertContactMethods(businessId, input.contactMethods ?? []);
}

export async function upsertContactMethods(businessId: string, methods: ContactMethodSeed[]): Promise<void> {
  const unique = [...new Map(methods
    .filter(({ value }) => value.trim())
    .map((method) => [`${method.type}\0${method.value}`, method])).values()];
  if (!unique.length) return;
  await ensureSchema();
  await sql()`
    insert into contact_methods (id, business_id, type, value, verification_status, catch_all)
    select
      'cm_' || gen_random_uuid(),
      ${businessId},
      item->>'type',
      item->>'value',
      item->>'verificationStatus',
      (item->>'catchAll')::boolean
    from jsonb_array_elements(${JSON.stringify(unique)}::jsonb) as item
    on conflict (business_id, type, value) do update set
      verification_status = coalesce(excluded.verification_status, contact_methods.verification_status),
      catch_all = coalesce(excluded.catch_all, contact_methods.catch_all),
      updated_at = now()
  `;
}

export async function listBusinessesForContactBackfill(): Promise<BusinessContactRecord[]> {
  await ensureSchema();
  const rows = await sql()`
    select id, name, slug, website, email, contact_form_url
    from businesses
    where website is not null
      and (email is null or contact_form_url is null)
    order by created_at
  ` as Row[];
  return rows.map((row) => ({
    id: String(row.id),
    name: String(row.name),
    slug: String(row.slug),
    website: String(row.website),
    email: row.email === null ? null : String(row.email),
    contactFormUrl: row.contact_form_url === null ? null : String(row.contact_form_url),
  }));
}

export async function listRedesignCandidates(): Promise<RedesignCandidateRecord[]> {
  await ensureSchema();
  const rows = await sql()`
    select b.id, b.name, b.slug, b.website, b.email
    from businesses b
    where b.website is not null
      and b.email is not null
      and b.email_verification_status = 'verified'
      and b.google_business_status is distinct from 'CLOSED_PERMANENTLY'
      and exists (select 1 from business_discoveries d where d.business_id = b.id)
      and not exists (
        select 1
        from websites failed_website
        join runs failed_run on failed_run.website_id = failed_website.id
        where failed_website.business_id = b.id
          and failed_run.status = 'failed'
        group by failed_website.business_id
        having count(*) >= 2
      )
    order by md5(b.id)
  ` as Row[];
  return rows.map((row) => ({
    id: String(row.id),
    name: String(row.name),
    slug: String(row.slug),
    website: String(row.website),
    email: String(row.email),
  }));
}

export async function listExistingRedesigns(): Promise<ExistingRedesignRecord[]> {
  await ensureSchema();
  const rows = await sql()`
    select distinct b.website as source_url, w.slug, b.email
    from websites w
    join businesses b on b.id = w.business_id
    where b.website is not null
      and exists (
        select 1 from runs r
        where r.website_id = w.id and r.status <> 'failed'
      )
  ` as Row[];
  return rows.map((row) => ({
    sourceUrl: String(row.source_url),
    slug: String(row.slug),
    email: row.email === null ? null : String(row.email),
  }));
}

export async function getRunCompletion(runId: string): Promise<RunCompletionRecord | undefined> {
  await ensureSchema();
  const [row] = await sql()`
    select r.status, r.ended_at, r.error, r.total_cost, r.data->'proofSentences' as proof_sentences, w.url as redesign_url
    from runs r
    join websites w on w.id = r.website_id
    where r.id = ${runId}
    limit 1
  ` as Row[];
  if (!row) return undefined;
  return {
    status: String(row.status),
    endedAt: row.ended_at === null ? null : new Date(String(row.ended_at)).toISOString(),
    error: row.error === null ? null : String(row.error),
    totalCost: row.total_cost === null ? null : Number(row.total_cost),
    redesignUrl: row.redesign_url === null ? null : String(row.redesign_url),
    proofSentences: Array.isArray(row.proof_sentences) ? row.proof_sentences.map(String) : [],
  };
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

export async function getWebsite(slug: string): Promise<WebsiteRecord | undefined> {
  await ensureSchema();
  const [website] = await sql()`
    select id, slug, repo_url, url
    from websites
    where slug = ${slug}
    limit 1
  ` as Row[];
  if (!website) return undefined;
  return {
    id: String(website.id),
    slug: String(website.slug),
    repoUrl: website.repo_url === null ? null : String(website.repo_url),
    url: website.url === null ? null : String(website.url),
  };
}

export async function deleteWebsiteRecord(slug: string): Promise<boolean> {
  await ensureSchema();
  const rows = await sql()`delete from websites where slug = ${slug} returning id` as Row[];
  return rows.length > 0;
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
