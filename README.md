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

- `GITHUB_TOKEN`: token that can create repos under `redesign-business` and push to them.
- `VERCEL_TOKEN`: token the app uses to create a budgeted AI Gateway key for each job, and that OpenCode can use for the final intentional Vercel deploy.
- `VERCEL_TEAM_ID`: recommended when the Gateway and deployments live under a Vercel team.

Each job creates a fresh AI Gateway key with a default `$1` budget and deletes it when the job exits. The default OpenCode model is `vercel/deepseek-v4-pro`.

## Start a Redesign

```bash
npm run redesign https://example-business.com
```

The domain-derived slug is reused for:

- the GitHub repo under `redesign-business`
- the Vercel project
- the preferred redesign URL: `https://<slug>.redesign.business`

For `https://example.com`, the default slug is `example`.

Override the slug when the website entity should not use the source domain:

```bash
npm run redesign https://example-business.com -- --slug example-plumbing
```

The command streams OpenCode output until the redesign is finished, then prints the original URL, redesign URL, GitHub repo, and slug. On success it deletes the sandbox.

## Recovery

The start of each run prints the sandbox and command id. If the terminal closes, inspect or clean up with:

```bash
npm run logs -- --sandbox <sandbox> --command <command>
npm run stop -- --sandbox <sandbox>
```

Skipped: dashboard, queue, workflow, branch previews, automated tests. Add them when this pilot proves they are needed.
