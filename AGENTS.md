# redesign-hosted-2

This repo is a fresh implementation. Do not migrate code or architecture from `redesign`, `redesign-demos`, or `redesign-hosted`.

The product runs website redesign jobs in Vercel Sandbox using OpenCode and Vercel AI Gateway. Keep the core path boring: create a sandbox, run OpenCode, push a branch, let GitHub/Vercel do their normal work.

## Agent skills

### Issue tracker

Issues and PRDs are tracked in GitHub Issues. See `docs/agents/issue-tracker.md`.

### Triage labels

The repo uses the default Matt Pocock triage label vocabulary. See `docs/agents/triage-labels.md`.

### Domain docs

This is a single-context repo. See `docs/agents/domain.md`.
