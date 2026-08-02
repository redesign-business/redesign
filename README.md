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
- `VERCEL_TOKEN`: token the app uses to create a budgeted AI Gateway key for each job, and that OpenCode can use for the final intentional Vercel deploy.
- `VERCEL_TEAM_ID`: recommended when the Gateway and deployments live under a Vercel team.
- `DATABASE_URL`: hosted Postgres URL for tracking businesses, websites, and runs.
- `NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN`: optional PostHog project token. When set, every generated landing page gets PostHog tracking.
- `NEXT_PUBLIC_POSTHOG_HOST`: optional PostHog host. Defaults to `https://us.i.posthog.com`.

Each job creates a fresh AI Gateway key with a default `$1` budget and deletes it when the job exits. The redesign flow is fixed: DeepSeek researches, Sol creates the page draft, then DeepSeek builds, commits, and deploys.

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

## Delete a Website

```bash
npm run delete -- --slug example-plumbing
```

This deletes the GitHub repo, the Vercel project, and the website row. Postgres cascades the website delete to its runs and sessions.

PostHog tracking is injected into the seeded Next.js template when `NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN` is set. Use one PostHog project for the redesign landing pages and filter by `host` or the `redesign_slug` property instead of creating a PostHog project per generated site.

When `REDESIGN_TEMPLATE_SNAPSHOT_ID` is present in `.env.local`, each run creates the job sandbox from that warmed snapshot instead of a cold runtime. The snapshot should contain tmux, OpenCode, runner dependencies, Playwright Chromium, and Chromium's Linux libraries. The job sandbox still clones the newly created GitHub repo into `/vercel/sandbox`; the template sandbox is never used for a redesign run.

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
