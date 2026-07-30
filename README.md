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

The command creates the GitHub repo, AI Gateway key, and Vercel Sandbox, uploads the cloud runner, starts it in a sandbox tmux session, then attaches your terminal to that session.

## Recovery

The start of each run prints the sandbox name. If the terminal closes, reconnect to the same tmux session:

```bash
npm run attach -- --sandbox <sandbox>
```

Delete a sandbox explicitly when you are done:

```bash
npm run stop -- --sandbox <sandbox>
```

The final run state lives in the generated repo's `redesign-run.json`.

Skipped: dashboard, queue, workflow, branch previews, automated tests. Add them when this pilot proves they are needed.
