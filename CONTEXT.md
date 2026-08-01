# Context

## Glossary

- **Redesign job**: one request to improve a small business website in a target GitHub repo.
- **Run**: one internal generation attempt for a website. Runs are production history, not customer-facing sales activity.
- **Session**: one model-level usage record for a run, using the same model identifier string as AI Gateway.
- **Sandbox**: the Vercel Sandbox microVM where OpenCode runs, so local machine resources are not used.
- **Agent command**: the detached OpenCode process running inside a sandbox.
- **Website slug**: the stable identifier for one website entity. The GitHub repo, Vercel project, and preferred redesign subdomain all use this slug. It usually comes from the source domain without its top-level domain, so `example.com` becomes `example`; it can differ when one business has multiple websites.
- **Generated repo**: the GitHub repo created under `redesign-business` for one website redesign.

## Current Decision

Use OpenCode in Vercel Sandbox with Vercel AI Gateway. The user provides a site URL; the app creates a GitHub repo under `redesign-business`, runs the redesign on `main`, deploys once with the Vercel CLI, prints the original/redesign URLs, and deletes the sandbox on success. Skip orchestration layers until a real need appears.
