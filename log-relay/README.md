# redesign-log-relay

Cloudflare Worker for streaming redesign job logs over WebSockets.

## Routes

- `GET /health`
- `GET /runs/:runId?role=reader&token=...&after=0`
- `GET /runs/:runId?role=writer&token=...`

Writers send plain text or JSON:

```json
{ "phase": "draft", "stream": "stdout", "data": "OpenCode output..." }
```

Readers receive JSON:

```json
{
  "seq": 1,
  "phase": "draft",
  "stream": "stdout",
  "data": "OpenCode output...",
  "at": "2026-07-30T00:00:00.000Z"
}
```

Reconnect readers with `after=<last seq seen>` to replay buffered messages.

## Local

```bash
cp .dev.vars.example .dev.vars
npm install
npm run dev
```

## Deploy

```bash
npm run deploy
wrangler secret put LOG_RELAY_TOKEN
```

Point `logs.redesign.business` at this Worker in Cloudflare after deploy.
