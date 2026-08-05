# redesign-hosted-2

This repo is a fresh implementation. Do not migrate code or architecture from `redesign`, `redesign-demos`, or `redesign-hosted`.

The product runs website redesign jobs in Vercel Sandbox using OpenCode and Vercel AI Gateway. Keep the core path boring: create a sandbox, run OpenCode, push a branch, let GitHub/Vercel do their normal work.

## Problem-driven development

Scope creep is using or building tools for problems we have not actually faced. Before changing the system, ask: **What is our exact problem?** Then reuse, buy, or build the smallest thing that solves that problem.

The small size of this codebase is deliberate. Do not add speculative abstractions, orchestration, or infrastructure for imagined future needs. Less is more; simplicity is robust.

## Outreach

The current cold-email experiment is documented in `docs/outreach.md`. Keep commodity sales infrastructure outside this product as recorded in `docs/adr/0001-keep-outreach-infrastructure-outside-the-product.md`.

## Agent skills

### Issue tracker

Issues and PRDs are tracked in GitHub Issues. See `docs/agents/issue-tracker.md`.

### Triage labels

The repo uses the default Matt Pocock triage label vocabulary. See `docs/agents/triage-labels.md`.

### Domain docs

This is a single-context repo. See `docs/agents/domain.md`.
