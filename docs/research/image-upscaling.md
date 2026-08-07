# Image upscaling: Vercel Sandbox CPU vs. Modal GPU

Verified against primary sources on 2026-08-07.

## Decision

Leave image upscaling out of v1. Preserve and use the best suitable original images without adding Upscayl, Real-ESRGAN, or Modal to the production path.

The sandbox tests completed one 300×300 to 1200×1200 `upscayl-lite-4x` image in 23 seconds and one 800×600 to 3200×2400 image in 102 seconds on the default 2-vCPU/4-GB sandbox. The experiment proved local CPU upscaling is possible, but it would block the redesign Sandbox and can materially extend the five-minute pipeline. That cost is unnecessary until generated previews demonstrate an image-quality problem.

If upscaling is later needed, prefer a short-lived Modal GPU Function so the redesign Sandbox can continue independently. Benchmark that function against the same inputs and acceptance criteria before choosing its Real-ESRGAN model and settings.

## Cost comparison

Vercel lists Sandbox Active CPU from $0.128 per vCPU-hour and provisioned memory from $0.0212 per GB-hour. CPU is metered in milliseconds; memory is measured for the session in one-minute increments. The default sandbox is 2 vCPUs and 4 GB. The Hobby plan includes 5 Active CPU hours and 420 GB-hours of memory monthly. [Vercel pricing](https://vercel.com/pricing) [Vercel billing details](https://vercel.com/kb/guide/vercel-sandbox-duration-and-persistence) [default resources](https://vercel.com/changelog/vercel-sandbox-now-supports-1-vcpu-2-gb-configurations)

For the observed upscales, assuming both vCPUs remain fully active:

| Input → output | Runtime | Active CPU | Added memory ceiling | Marginal total |
| --- | ---: | ---: | ---: | ---: |
| 300×300 → 1200×1200 | 23 seconds | $0.00164 | $0.00141 | **$0.00164–$0.00305** |
| 800×600 → 3200×2400 | 102 seconds | $0.00725 | $0.00283 | **$0.00725–$0.01008** |

The memory ceiling assumes the upscale adds one full billing minute for the small image or two for the larger one; it may add less when it fits into minutes the existing job already incurs. At 300 images, the two observed sizes would cost roughly **$0.49–$0.92** or **$2.18–$3.02** respectively, before included usage.

Modal currently lists an NVIDIA L4 at $0.000222/second, one physical CPU core (2 vCPUs) at $0.0000131/second, and memory at $0.00000222/GiB/second. Its Starter plan includes $30/month of compute credit and 10-GPU concurrency. [Modal pricing](https://modal.com/pricing)

For an illustrative L4 function with one physical CPU core and 4 GiB memory:

| Total billed duration | GPU | CPU + memory | Total per image | 300 images |
| --- | ---: | ---: | ---: | ---: |
| 20 seconds | $0.00444 | $0.00044 | **$0.00488** | **$1.46** |
| 60 seconds | $0.01332 | $0.00132 | **$0.01464** | **$4.39** |

These Modal scenarios are price calculations, not measured Real-ESRGAN runtimes. They exclude transfer/storage charges and optional region selection, which Modal prices at 1.5–1.75× base rates. The $30 credit can make initial usage free, but it should not drive the architecture.

At published rates, Modal must finish a small-image invocation in roughly **7–13 seconds** to match its local cost. For the observed 800×600 case, even a 20-second Modal invocation would be cheaper than the local CPU path, but its actual Real-ESRGAN runtime and image quality remain unmeasured. Modal's strongest case is lower wall-clock latency and parallel GPU capacity.

## Operational tradeoffs

| Concern | Existing Sandbox CPU | Modal GPU function |
| --- | --- | --- |
| Current evidence | Proven: 23 seconds at 300×300; 102 seconds at 800×600 | Unbenchmarked for these inputs/model |
| Job latency | Acceptable for one small image; materially slower as pixel count grows | Likely faster inference, but cold start and transfer must be measured |
| Throughput | Occupies sandbox CPU; multiple images compete with the redesign job | Autoscaling pool; Starter allows 10 concurrent GPUs |
| Idle cost | No separate service | Functions scale to zero by default |
| Operations | Binary/model can live in the existing snapshot | Another deployment, credential, request, upload/download, and retry path |

Modal confirms that Functions scale to zero by default. Keeping containers warm can reduce cold starts but introduces idle resource charges. [Modal autoscaling](https://modal.com/docs/guide/scale) [Modal cold starts](https://modal.com/docs/guide/cold-start)

## Runtime and licensing

The main Real-ESRGAN Python implementation requires Python 3.7+ and PyTorch 1.7+ and is BSD-3-Clause licensed. Its official repository also publishes portable NCNN executables that include binaries and models and require neither CUDA nor PyTorch. [Real-ESRGAN repository](https://github.com/xinntao/Real-ESRGAN) [BSD-3-Clause license](https://github.com/xinntao/Real-ESRGAN/blob/master/LICENSE)

The separate Real-ESRGAN NCNN/Vulkan implementation is MIT licensed and supports JPG/PNG/WebP, 2×/3×/4× scaling, and tiled processing. If distributing that binary rather than the Python implementation, preserve its separate license notice. [Real-ESRGAN NCNN/Vulkan](https://github.com/xinntao/Real-ESRGAN-ncnn-vulkan) [NCNN/Vulkan license](https://github.com/xinntao/Real-ESRGAN-ncnn-vulkan/blob/master/LICENSE)

## Revisit trigger

Only prototype a non-blocking Modal GPU Function after production data shows one of these exact problems:

- more than one image per job needs upscaling;
- selective upscaling materially delays redesign jobs;
- concurrent image upscales starve OpenCode/build work of sandbox CPU; or
- larger source images make the CPU runtime unacceptable.

Then benchmark one L4 and one cheaper T4 against the same image set, model/output settings, end-to-end latency, and accepted visual quality. Modal lists T4 at $0.000164/second and L4 at $0.000222/second, so the cheapest GPU should be chosen from measurements rather than assumed. Do not move the redesign job to a GPU Sandbox merely to add this operation.
