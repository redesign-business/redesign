---
name: nextjs-site-building
description: One-shot complete Next.js websites from the standard create-next-app App Router starter, including landing pages, portfolios, dashboards, portals, trackers, hubs, and internal tools. Use for new Next.js site creation or existing Next.js site changes that should be designed, implemented, validated, previewed, and deployed to Vercel without asking the user to select a design unless the user requests collaboration or local-only work.
---

# Next.js site building

Build the complete requested site, validate it, then use `deploy-to-vercel`
unless the user explicitly asks to keep it local.

Apply the `nextjs` skill whenever implementation touches Next.js APIs or
conventions. Treat current official Next.js documentation as authoritative for
`create-next-app`, App Router, metadata, images, fonts, and build behavior.

## Communicate clearly

Assume the user is a nontechnical knowledge worker. Talk about their site,
choices, progress, and results. Keep tools, commands, files, runtimes, browser
software, permissions, dependencies, source control, credentials, IDs, builds,
and deployment internals out of user-facing messages unless the user asks or
must take action.

Use no more than one short update for each user-visible phase: choosing the
design direction, building the site, and publishing. If a phase takes longer
than 60 seconds, give one plain-language update. Keep recoverable technical
problems private; say only that you hit a problem and are trying another method.

## Choose the execution path

Use the **one-shot fast path** only when all of these are true:

- this is a new site in an empty or projectless workspace;
- one route can satisfy the request;
- the request does not require persistent data, uploads, app-owned
  authentication, external connectors, or browser UI QA; and
- the normal deliverable is a Vercel preview URL.

Use the **capability path** otherwise. This includes existing-site changes,
multi-route sites, persistent data, uploads, authentication, external data, and
requested browser testing.

## Use imagery purposefully

Avoid model-authored SVGs in finished sites, including inline SVG
illustrations. Prefer strong typography, color, layout, CSS shapes, and existing
icon components when imagery is unnecessary. When a site needs real imagery,
prefer suitable images found through web image search. Use `imagegen` if and
only if original imagery is important and a suitable existing image is
unavailable; generation adds latency, so keep it purposeful and limited.

## Start new projects immediately

For a new site in an empty or projectless workspace, make setup the first task
action. Run this skill's `scripts/init-site.sh` with `$PWD` as its target and
retain the session until installation completes. Do not run a second
initializer.

In a visible foreground thread, wait for setup to finish, then immediately start
`npm run dev` in a retained session. Use the exact Local URL printed by the
development server and call `open_in_codex` once. Complete these startup steps
before exploring the design direction. Do not ask discovery questions, call
`request_user_input`, or show a design picker during the one-shot flow. Infer
unspecified details from the brief and choose the strongest direction yourself.
The user should see the create-next-app starter page before implementation
begins; continue building the requested site through HMR and keep the
development server alive through build and deployment.

In a delegated, background, or invisible thread, initialize normally but do
not start a browser-only preview unless the task otherwise needs the server.

## One-shot design bypass

This flow is unrelated to the Codex Apps `$one-shot` UI-regression skill. Treat
invocation of this skill as the user's request to proceed without choosing an
option. Skip discovery questions, `request_user_input`, subagents, design
previews, and design pickers entirely. Infer the audience, purpose, content,
tone, desired feeling, and strongest visual direction from the user's brief and
project context, then build it directly. Ask only when a missing fact creates a
genuine blocker involving required content, access, or authority.

## One-shot build

After inferring the direction, build and deploy the complete site in one
focused pass.

1. Reuse the retained setup, development server, and browser tab started above.
   Start or open anything here only when the corresponding earlier step did not
   happen. Preserve the package manager and lockfile.
2. Start by inspecting `app/page.tsx`, `app/layout.tsx`, `app/globals.css`, and
   `package.json`. Read other files only when the implementation needs them.
   Avoid broad scans and speculative research.
3. Make one complete product patch. Prefer one page component and one
   stylesheet. Include all requested content, interactions, responsive
   behavior, keyboard and touch behavior when relevant, and accessible labels.
   The create-next-app page is temporary infrastructure, not product UI. Replace
   its content and styles completely, remove unused starter assets, replace the
   starter title and description, and update starter icons when appropriate
   before the final build unless the user explicitly asked to work on the
   starter itself. Complete **Metadata and social preview** below before the
   final build.
4. As soon as implementation is complete, run `npm run build` while the
   retained `npm run dev` process stays alive. Fix actual build failures, then
   rerun it. Run lint separately because Next.js 16 builds do not run lint, but
   only when the project defines a lint script or the user asks.
5. Follow the shared preview rules below.
6. Continue to `deploy-to-vercel`. Avoid an unnecessary polish pass after the
   build succeeds.

## Metadata and social preview

- Always replace create-next-app's starter metadata with finished,
  site-specific metadata. Keep `app/layout.tsx` a Server Component and use the
  App Router Metadata API for the title, description, Open Graph fields, and X
  card fields. File-based metadata conventions are equally valid when they are
  the simpler fit. Replace starter icons when appropriate.
- Once the site's visual direction, primary headline, and supporting copy are
  stable, freeze a compact social-preview brief and launch exactly one
  `imagegen` request in parallel with the remaining site implementation and
  validation. Ask imagegen to create the complete social card, including its
  typography, as one cohesive 1200x630 landscape image. The card must represent
  the actual finished site by reusing its content, brand palette, typography
  treatment, and distinctive visual motifs; optimize it for visual impact and
  legibility in X, Slack, iMessage, and other link unfurls.
- Inspect the returned image for incorrect, missing, or invented text. Retry
  once only when the card is unusable; do not generate multiple candidates in
  parallel. If validation succeeds, save the image as `public/og.png` and wire
  it through the App Router Metadata API, or use Next.js's
  `app/opengraph-image.png` file convention. One Open Graph image may serve as
  the X image too. Run the final build after wiring the asset. Never ship a
  generic or starter fallback image; if no bespoke card passes validation,
  omit `og:image` instead.
- Use `next/og` and `ImageResponse` only when the site genuinely needs dynamic
  or per-route social images. Do not add `@vercel/og` or an Edge runtime for a
  static card.

## Capability path

### Project setup

- For a new site, use the setup flow in **Start new projects immediately** and
  preserve the standard create-next-app App Router structure.
- For an existing site, preserve its package manager, lockfile, scripts, and
  architecture. Install only when dependencies are absent. Do not replace a
  working structure merely to use the starter.
- Keep site code within the selected project surface.

### Shape the product

- Build the first viewport around the requested product, not generic dashboard
  chrome.
- For a new site, replace the create-next-app page and styles completely,
  remove unused starter assets, update `app/layout.tsx` with the finished site's
  title and description, and replace any other starter metadata before final
  validation. Preserve the starter only when the user explicitly asked to work
  on it.
- Use concrete, product-specific copy and realistic data.
- Complete **Metadata and social preview** before final validation.
- Avoid speculative features and unnecessary client state.
- Use App Router and Server Components by default. Add `"use client"` only
  where interaction requires it. Prefer `next/image` and `next/font` over
  custom image and font loading.

### Add only requested capabilities

- Add persistence, uploads, authentication, or external services only when the
  request requires them. Prefer platform-native integrations and already
  installed dependencies over custom infrastructure.
- Use browser storage only for device-local preferences or explicitly local
  state.
- Keep local `.env` and `.env.example` keys aligned. Manage hosted runtime
  values with `vercel env` when deploying to Vercel.

### Validate capability work

- Run the deployment build once after the complete implementation. If a
  database schema changed, generate and inspect its migration. Fix real
  failures before deployment.

## Preview

- In a visible foreground thread, reuse the tab opened during startup. If no tab
  was opened, call `open_in_codex` once with the exact Local URL printed by the
  healthy development server. If it fails, report it and continue.
- For an existing site, preserve its normal package and development flow.
- In a delegated, background, or invisible thread, skip `open_in_codex` and say
  why.
- Perform no screenshots, DOM inspection, clicking, resizing, or visual QA
  unless the user explicitly requests browser testing.
- Do not scan ports or repeatedly open the browser.

## Hosting handoff

Use `deploy-to-vercel` after validation. Do not finish with only a local build
unless the user requested local-only work. Default to a preview deployment;
deploy to production only when the user explicitly asks. Return the deployed
URL as the primary deliverable. Do not include file paths, commands, or
validation jargon unless the user asks. Keep the development server running
until deployment finishes, then stop it during final teardown.
