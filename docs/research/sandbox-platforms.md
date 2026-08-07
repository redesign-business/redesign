# Vercel Sandbox vs. Modal Sandboxes

Verified against first-party sources on 2026-08-07.

## Decision

Keep the redesign pipeline on Vercel Sandbox. Modal can run the whole OpenCode job in a GPU-backed Sandbox, but that is the wrong resource shape for this workload: the GPU is reserved for the Sandbox's lifetime, so it is billed while OpenCode waits on model responses, GitHub, package downloads, and Vercel deployment. On Modal Starter, GPU concurrency is also limited to 10, below the pipeline's target of 30 concurrent jobs.

Image upscaling is outside v1. If it later becomes necessary, use a short-lived Modal GPU Function for only the selected image so the redesign Sandbox is not occupied by upscaling. Do not migrate the coding-agent Sandbox merely to gain GPU access.

## The important GPU detail

Modal's standard Sandbox API accepts `gpu: "L4"` (or another supported GPU), so GPU Sandboxes are real and straightforward:

```ts
import { ModalClient } from "modal";

const modal = new ModalClient();
const app = await modal.apps.fromName("redesign-jobs", { createIfMissing: true });
const image = modal.images.fromRegistry("nvidia/cuda:12.8.1-runtime-ubuntu24.04");
const sandbox = await modal.sandboxes.create(app, image, {
  gpu: "L4",
  cpu: 1, // one physical core, equivalent to two vCPUs
  memoryMiB: 4096,
  timeoutMs: 5 * 60 * 1000,
});
```

The documented `SandboxCreateParams.gpu` value is a reservation, Modal bills Sandbox resources by the second based on the greater of requested or actual usage, and GPU prices are per second. Therefore a GPU requested on creation is charged throughout the running Sandbox, not only while Real-ESRGAN is executing. This conclusion is an inference from Modal's resource and pricing rules; the pricing page does not separately spell out the phrase "GPU idle time inside a Sandbox." [JavaScript Sandbox API](https://modal.com/docs/sdk/js/latest/Sandbox) [Sandbox resource billing](https://modal.com/docs/guide/sandbox-resources) [Modal pricing](https://modal.com/pricing)

Modal also states that GPU Sandboxes are preemptible. A long coding session must tolerate interruption and checkpoint externally. [Modal Sandbox resources](https://modal.com/docs/guide/sandbox-resources)

## Platform comparison

| Concern | Vercel Sandbox | Modal Sandbox |
| --- | --- | --- |
| Isolation | Firecracker microVM with its own kernel, filesystem, and network | gVisor-isolated container; no access to other Modal workspace resources by default |
| Current TypeScript API | Stable `@vercel/sandbox`; already used here | `modal` JavaScript SDK is Beta and explicitly more limited than the Python SDK |
| CPU and RAM | `resources: { vcpus }`; 2 GB RAM per vCPU. Default 2 vCPU/4 GB. Limits: Hobby 4, Pro 8, Enterprise 32 vCPU | `cpu` is fractional physical cores (one core = two vCPUs); `memoryMiB` is independent. Default request 0.125 core/128 MiB. Numeric maximum CPU/RAM requests are not publicly stated |
| GPU | No GPU option is documented or exposed by the SDK | Standard Sandbox supports T4, L4, A10, L40S, A100 variants, RTX PRO 6000, H100, H200, B200, and B300; multiple GPUs are supported for some types |
| Timeout | Default 5 minutes; Hobby up to 45 minutes; Pro/Enterprise up to 24 hours; a running session can be extended | Default 5 minutes; maximum 24 hours; optional idle timeout |
| Template/fan-out | `sandbox.snapshot()`, `Sandbox.create({ source: { type: "snapshot", snapshotId } })`, or `Sandbox.fork({ sourceSandbox })`; current repo already creates non-persistent jobs from a template snapshot | `snapshotFilesystem()` returns an Image, then many Sandboxes can be created from that Image. Default filesystem-snapshot TTL is 30 days; `ttlMs: null` retains indefinitely. There is no direct fork call, but snapshot-Image fan-out is equivalent for this pipeline |
| Persistence | Persistent Sandboxes automatically snapshot on stop; this repo deliberately uses `persistent: false`. Separate Drives can outlive Sandboxes | Root filesystem is ephemeral unless snapshotted. Images/Volumes persist until deleted; a Volume can preserve intermediate output across preemption |
| 30 concurrent CPU jobs | Pro advertises 2,000 concurrent Sandboxes; Hobby has 10 | Starter includes 100 containers, so 30 CPU Sandboxes fit |
| 30 concurrent GPU jobs | Not available | Starter permits 10 concurrent GPUs. Team permits 50 but costs $250/month plus compute, with $100/month included compute |
| Network | Allow/deny rules, runtime policy updates, request proxying, and credential brokering that injects credentials on egress without placing them in the VM | Outbound public access by default; full block, CIDR allowlist, Beta TLS-domain allowlist, runtime updates, inbound CIDR rules, and encrypted tunnels |
| Secrets | Environment variables are supported; credential brokering can keep raw secrets outside the Sandbox | `Secret[]` values are injected as environment variables and are readable inside the Sandbox |
| Images and Docker | Built-in Amazon Linux runtimes or project-scoped VCR OCI images; full sudo, nested Docker, and FUSE support | Modal Image definitions or Linux/amd64 images from registries. Modal implements most Dockerfile instructions without Docker. Docker-in-Docker requires Beta VM Sandboxes, which do not support GPUs |
| Public ports | Up to 15 on the current product page | Encrypted, HTTP/2, or raw tunnels; authenticated Connect Tokens are available |

Sources: [Vercel Sandbox](https://vercel.com/sandbox), [Vercel duration and persistence](https://vercel.com/kb/guide/vercel-sandbox-duration-and-persistence), [Vercel Docker and OCI images](https://vercel.com/kb/guide/docker), [Vercel pricing](https://vercel.com/pricing), [Modal Sandbox API](https://modal.com/docs/sdk/js/latest/Sandbox), [Modal lifecycle](https://modal.com/docs/guide/sandboxes), [Modal snapshots](https://modal.com/docs/guide/sandbox-snapshots), [Modal networking](https://modal.com/docs/guide/sandbox-networking), [Modal existing images](https://modal.com/docs/guide/existing-images), [Modal JavaScript SDK status](https://modal.com/docs/sdk/js/latest), and [Modal pricing](https://modal.com/pricing).

Two Modal variants should not be conflated:

- Standard Sandboxes support GPUs.
- Modal's Beta V2 Sandboxes target more than 20 creates/second or more than 10,000 concurrent Sandboxes, but explicitly do not support GPUs. The ordinary backend is sufficient for 30 jobs. [Modal V2 Sandboxes](https://modal.com/docs/guide/sandbox-v2)

## Five-minute cost shape

These figures compare one 5-minute job using resources comparable to the current 2-vCPU/4-GB Vercel Sandbox. They exclude network, storage, plan fees, and included credits.

| Five-minute job | Per job | 30 jobs |
| --- | ---: | ---: |
| Vercel, one minute active CPU plus five minutes memory | $0.0113 | $0.34 |
| Vercel, all five minutes active CPU plus memory | $0.0284 | $0.85 |
| Modal CPU Sandbox, one physical core + 4 GiB reserved | $0.0198 | $0.59 |
| Modal T4 Sandbox, same CPU/RAM + GPU for all five minutes | $0.0690 | $2.07 |
| Modal L4 Sandbox, same CPU/RAM + GPU for all five minutes | $0.0864 | $2.59 |

Vercel charges $0.128 per active vCPU-hour and $0.0212 per provisioned GB-hour. CPU billing pauses during I/O waits, which matches a coding agent that spends substantial time waiting on LLM responses. Modal Sandbox pricing is $0.00003942 per physical core-second and $0.00000667 per GiB-second, charged on the greater of the request or actual use. T4 and L4 add $0.000164 and $0.000222 per second respectively. [Vercel pricing](https://vercel.com/pricing) [Modal pricing](https://modal.com/pricing)

Running the entire job on a GPU also does not improve research, Relume retrieval, copywriting, React editing, Git operations, or deployment. It accelerates only the short upscale. A separate 20-second L4 operation is roughly $0.0044 of GPU time; holding the same L4 for the full five-minute Sandbox is $0.0666 of GPU time.

## Lovable's use of Modal

The claim is genuine but it does not imply that Lovable gives every app-generation session a GPU. Modal's own case study says Lovable uses a Sandbox for every app-generation session and an encrypted Tunnel for access. Modal reports that Lovable reduced sandbox-orchestration code from 15,000 lines to 700, ran more than one million Sandboxes during a 48-hour promotion, and peaked at 20,000 concurrent Sandboxes. Modal's product page attributes to Lovable founder Anton Osika that Modal enabled tens of thousands of app-creation sessions. These are vendor-authored claims, not a default quota or an independent benchmark. [Modal's Lovable case study](https://modal.com/blog/lovable-case-study) [Modal Sandboxes product page](https://modal.com/products/sandboxes)

## Migration impact for this repository

Modal can run OpenCode; Modal publishes an official example that installs OpenCode into an Image, starts it in a Sandbox, exposes its server through an encrypted tunnel, and supplies GitHub credentials through a Modal Secret. [OpenCode on Modal](https://modal.com/docs/examples/opencode_server)

The final GitHub and Vercel path could remain unchanged: a Modal Sandbox can push the branch, call Vercel AI Gateway with the existing API key, and run `vercel deploy`. But the migration is still materially broader than the image problem:

- Replace `@vercel/sandbox` creation, snapshot/fork, command execution, file upload, lookup, terminal attachment, stop, and delete operations in `src/redesign.ts` with Modal's Beta TypeScript SDK.
- Replace `/vercel/sandbox` and `/home/vercel-sandbox` assumptions in `src/redesign.ts` and `src/cloud-runner.ts`.
- Build and publish a Modal Image containing OpenCode, Chromium, Relume MCP state, and runner dependencies; a filesystem snapshot can then carry authenticated Relume state into job Sandboxes.
- Rebuild recovery around Modal Sandbox IDs and `fromId()`. The existing Vercel CLI/tmux attachment path is provider-specific.
- Add `MODAL_TOKEN_ID` and `MODAL_TOKEN_SECRET`, while retaining Vercel credentials for AI Gateway and deployment.
- If the whole Sandbox has a GPU, add preemption-safe Git pushes or a mounted Volume with explicit checkpoints.

None of those changes improves the known composition problem. They replace working orchestration to optimize an optional image operation.

## Revisit trigger

Keep upscaling out of the first experiment. Add a separate Modal Real-ESRGAN Function only when generated previews demonstrate that source-image quality needs it; keep that work independent of the Vercel redesign Sandbox. Consider a full Modal Sandbox migration only if the Vercel Sandbox itself becomes the measured constraint—for example, a required GPU must be available throughout most of every job, more than 2,000 concurrent CPU Sandboxes are needed, or Modal's image/runtime model removes enough real orchestration to justify replacing the current integration.
