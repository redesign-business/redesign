# redesign-hosted-2

Run small-business website redesign jobs in Vercel Sandbox with OpenCode and Vercel AI Gateway.

## Setup

```bash
npm install
vercel link
vercel env pull
cp .env.example .env.local
```

Fill in:

- `GITHUB_TOKEN`: token that can create repos under `redesign-business`, push to them, and delete them.
- `VERCEL_TOKEN`: token the app uses to create the batch's pool of budgeted AI Gateway keys, and that OpenCode can use for the final intentional Vercel deploy.
- `VERCEL_TEAM_ID`: recommended when the Gateway and deployments live under a Vercel team.
- `DATABASE_URL`: hosted Postgres URL for tracking businesses, websites, and runs.
- `GOOGLE_MAPS_API_KEY`: key with Places API (New) and Geocoding API enabled.
- `INSTANTLY_API_KEY`: Instantly API v2 key used only to verify discovered email addresses.
- `NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN`: optional PostHog project token. When set, every generated landing page gets PostHog tracking.
- `NEXT_PUBLIC_POSTHOG_HOST`: optional PostHog host. Defaults to `https://us.i.posthog.com`.

Single jobs create a fresh AI Gateway key with a default `$1` budget. Batches keep up to 30 keys in the gitignored `.data/ai-gateway-key-pool.json`, add another `$1` allowance after each run, and reuse the keys across batches. Batch keys are never deleted automatically.

After every OpenCode invocation, the runner replaces the run's cumulative model-session rows and totals from OpenCode's usage database. Failed and budget-exhausted runs therefore retain the cost already incurred before their Gateway key is deleted.

## Redesign Pipeline

1. **(Code) Capture the original website**

   Input: website URL

   Output: `raw.md`, original screenshot, downloaded images, `image-manifest.json`, and ID-labeled image contact sheets

2. **(DeepSeek V4 Flash) Research the business**

   Input: `raw.md`

   Output: `proof.md`, freeform except for the three outreach lines consumed by deterministic storage

3. **(GPT-5.6 Sol) Build the finished page**

   Input: `proof.md`, every captured image and its contact sheets, the original screenshot, the Relume MCP, and the starter project files

   Output: the finished page and its selected Relume components

   Sol uses the Relume MCP normally to search, choose, retrieve, and install sections and primitives. It adapts the business's content to those layouts instead of inventing the composition.

4. **(Code) Verify and deploy**

   Input: completed project

   Output: deployed preview URL, duration, and recorded cost

If the deterministic build fails, a narrowly permissioned DeepSeek V4 Flash session receives only the concrete error and the three website files, with up to five repair attempts. Repair is an error path, not another pipeline stage. Model usage is recorded immediately after every invocation, whether the run eventually succeeds or fails. Each invocation's terminal output is saved under `.redesign/sessions/` in the generated repo, including failed attempts; runner secrets are redacted before writing.

## Start a Redesign

```bash
npm run redesign -- https://example-business.com
```

The domain-derived slug is reused for:

- the GitHub repo under `redesign-business`
- the Vercel project
- the preferred redesign URL: `https://<slug>.redesign.business`

For `https://example.com`, the default slug is `example`.

Override the slug when the website entity should not use the source domain:

```bash
npm run redesign -- https://example-business.com --slug example-plumbing
```

If one business has multiple websites, keep the business slug stable and give each website its own slug:

```bash
npm run redesign -- https://example-business.com --business "Example Plumbing" --business-slug example-plumbing --slug example-plumbing-main
```

The command creates the GitHub repo, AI Gateway key, and Vercel Sandbox, uploads the cloud runner, starts it in a sandbox tmux session, then attaches your terminal to that session.

Started redesigns are tracked in Postgres. The first run creates the `businesses`, `websites`, and `runs` tables if they do not exist.

## Discover Businesses

```bash
npm run discover -- --category "custom home builders" --area "Reno, Nevada"
```

The command searches the area's Google Places results, subdividing dense areas that hit Google's 60-result limit. It stores every returned business by Google place ID, checks business websites for a public email or contact form, and asks Instantly to verify emails. Verified catch-all addresses remain eligible; invalid addresses do not.

Discovery stops after qualification. It does not start a redesign or add anyone to the live Instantly campaign.

Run the agreed 19-category by 9-area discovery matrix:

```bash
npm run discover-matrix
```

The matrix stores each unique business once and records every category/area search in which it appeared. It qualifies overlapping businesses only once, then reports the overall funnel and the funnel grouped by category, area, and exact combination: total businesses, websites, verified emails, catch-all emails, contact forms, invalid emails, and businesses contactable by either email or form.

If qualification is interrupted after discovery completes, resume it without repeating Google searches:

```bash
npm run qualify-discovered
```

Generate the next 100 high-confidence redesigns in parallel:

```bash
npm run redesign-batch -- --limit 100 --concurrency 30
```

The batch groups Google listings by normalized website, keeps one verified same-domain recipient per website, excludes previously redesigned websites, and staggers job launches by one second. Each active job gets one key from the batch's reusable `$1` key pool and releases its sandbox when it finishes.

## Delete a Website

```bash
npm run delete -- --slug example-plumbing
```

This deletes the GitHub repo, the Vercel project, and the website row. Postgres cascades the website delete to its runs and sessions.

PostHog tracking is injected into the seeded Next.js template when `NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN` is set. Use one PostHog project for the redesign landing pages and filter by `host` or the `redesign_slug` property instead of creating a PostHog project per generated site.

When `REDESIGN_TEMPLATE_SNAPSHOT_ID` is present in `.env.local`, each run creates the job sandbox from that warmed snapshot instead of a cold runtime. The snapshot must contain tmux, OpenCode, authenticated Relume MCP state, Playwright Chromium, and Chromium's Linux libraries. The job sandbox still clones the newly created GitHub repo into `/vercel/sandbox`; the template sandbox is never used for a redesign run.

## Recovery

The start of each run prints the sandbox name. If the terminal closes, reconnect to the same tmux session:

```bash
npm run attach -- --sandbox <sandbox>
```

Delete a sandbox explicitly when you are done:

```bash
npm run stop -- --sandbox <sandbox>
```

Run state lives in Postgres.

Skipped: dashboard, queue, workflow, branch previews. Add them when this pilot proves they are needed.
