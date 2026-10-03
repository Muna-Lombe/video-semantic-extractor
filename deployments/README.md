# Backend deployments

The production image installs the system media tools before installing the Python
package. This ordering is intentional: the extractor requires both `ffmpeg` and
`ffprobe`, and a deployment must fail during image creation rather than later on a
request.

## Prerequisites

For a local Docker deployment, install Docker Engine or Docker Desktop and run:

```bash
./deployments/check-system-requirements.sh docker
```

For Cloudflare Containers, install Node.js/npm and Docker locally. Authenticate
with Wrangler before deploying:

```bash
./deployments/check-system-requirements.sh cloudflare
npx wrangler login
```

The script checks host tools only. The image build separately verifies `ffmpeg`
and `ffprobe` after installing them with the base image's package manager and
before running `pip install`.

## Docker Compose

From the repository root:

```bash
docker compose -f deployments/compose.yaml up --build
curl http://localhost:8000/health
```

The API is available at `http://localhost:8000`; submit a JSON request to
`POST /capsule` with a public `video_url`. Configure download limits in
`deployments/compose.yaml` or through the deployment environment.

## Cloudflare Containers deployment

This deployment is **optional and separate** from the currently deployed
Internals/review Worker. Deploy it only when the product needs the hosted
`POST /capsule` extraction API. It is not a sampling-job consumer: deploying it
does not claim Internals jobs, send heartbeats, ingest registered dataset sources,
or finalize frame sets. Those capabilities still require a dedicated runner.

Do not expose the container Worker as the main Internals hostname. Keep the
control-plane/review Worker and container API as distinct services, then either
configure the gateway in `workers/capsule-gateway/src/index.ts` with the container URL or add an
explicit authenticated service-binding design. The Python API currently has no
end-user authentication, so do not deploy it publicly until access control and
cost limits are defined.

The Cloudflare deployment uses the same Dockerfile as the Compose deployment.
Build and push the image to Cloudflare's container registry from the repository
root, then update the account ID in
`workers/wrangler.capsule-container.toml`. The Worker entry point binds a single
named Durable Object container to the Python API on port 8000:

```bash
docker build -f deployments/Dockerfile \
	-t registry.cloudflare.com/ACCOUNT_ID/video-semantic-extractor:latest .
docker push registry.cloudflare.com/ACCOUNT_ID/video-semantic-extractor:latest
cd workers
npx wrangler deploy --config wrangler.capsule-container.toml
```

Cloudflare Container support must be enabled for the account and the selected
instance type must be available in the target region. The container needs
outbound internet access because the API downloads public videos and loads the
Whisper model. The image build installs and verifies `ffmpeg`/`ffprobe` before
Python dependencies, so the Cloudflare deployment has the same prerequisite
guarantee as Compose. Docker is required locally or in CI to build the image;
Wrangler only deploys the pushed image.

The image installs the CPU-only PyTorch wheel because Cloudflare Containers do
not provide a CUDA runtime. This avoids pulling the much larger NVIDIA runtime
packages and keeps the image suitable for the available container environment.

The Worker entry point in `workers/capsule-container/src/container.ts` is intentionally separate
from the existing `workers/capsule-gateway/src/index.ts` gateway. Use the existing Worker when
the Python API is hosted elsewhere; use this configuration when Cloudflare
should host the Python API itself. Neither entry point implements the Internals
sampling runner protocol.

### Planned sampling-runner Container

Managed sampling will use a **different** Cloudflare deployment from the capsule
Container above. The sampling-runner Worker will own a sampling Container Durable
Object binding and a `CONTROL_PLANE` Service binding to the Internals Worker. Its
scheduled or queue-driven handler will claim jobs, supervise heartbeats, invoke
the shared sampling engine in the Container, and return artifacts through the
existing lease-bound runner API.

Do not add the Product capsule Container as a binding of the Internals Worker and
do not point the runner at the public `workers.dev` hostname. The binding direction
is runner to control plane: `env.CONTROL_PLANE.fetch()` privately invokes the
existing Worker. The runner credential still applies at the API boundary because
private routing and authorization solve different problems. A control-plane-to-
runner binding is unnecessary for the polling design; a queue can later provide
prompt wake-ups without replacing atomic claims.

The runner implementation is in `backend/video_semantic_extractor/sampling_runner.py`,
its image is defined by `deployments/SamplingRunner.Dockerfile`, and its Worker is
configured by `workers/wrangler.sampling-runner.toml`. Deploy the
control-plane Worker and its migrations first. Then build and push the runner image
under the release tag in the Wrangler configuration, set the runner Worker's copy
of the same `RUNNER_TOKEN`, and deploy it:

```bash
docker build -f deployments/SamplingRunner.Dockerfile \
  -t registry.cloudflare.com/ACCOUNT_ID/video-semantic-extractor-sampling-runner:2026-10-03.1 .
docker push registry.cloudflare.com/ACCOUNT_ID/video-semantic-extractor-sampling-runner:2026-10-03.1
npx wrangler secret put RUNNER_TOKEN \
  --config workers/wrangler.sampling-runner.toml
cd workers
npm run deploy:sampling-runner
```

Replace `ACCOUNT_ID` in the commands and runner Wrangler configuration. The image
tag in the build command and configuration must match. Never deploy a `:latest`
reference: Cloudflare rejects it when creating a Container application. For each
image release, choose a new unique tag, push it, and update the configuration in the
same change so a deployment cannot silently select a different image. The cron
trigger invokes one guarded `/run-once` execution each minute. The Container claims
at most one job per invocation, rejects concurrent work as `busy`, downloads sources
with the existing SSRF and size protections, maintains a heartbeat thread, uploads
checksum-bound frames, and finalizes `frame-set-manifest.v1`. Remote rollout,
real-media execution, and Container resource sizing still require verification in
an authenticated Cloudflare account.

## Cloudflare project layout

`workers/` is the single Cloudflare project root for all Worker deployments in
this repository. It contains the shared Node package, source, static assets,
migrations, and every Wrangler configuration:

```text
workers/
├── control-plane/                   control-plane code, assets, and migrations
├── capsule-container/               Product capsule Container adapter code
├── capsule-gateway/                 optional external-backend gateway code
├── sampling-runner/                 sampling runner code
├── wrangler.toml                    control-plane and review Worker config
├── wrangler.capsule-container.toml  Product capsule Container Worker config
└── wrangler.sampling-runner.toml    sampling-runner Worker config
```

Set the Cloudflare Workers Builds root directory to `workers` for each Worker
project, and select the matching Wrangler configuration or npm deploy script. Do
not set the build root to an individual nested Worker directory: the root-level
Wrangler configuration and shared Node package would not be visible. Do not put
Wrangler configuration under `deployments/`, either, because that directory is
outside the configured build root.

`deployments/` remains the repository-root build context for Dockerfiles, Compose,
and host prerequisite scripts. Container images must therefore be built and pushed
from the repository root before the corresponding Wrangler deployment runs from
`workers/`. This split keeps all Cloudflare-visible Worker inputs under one root
without duplicating the Python backend into the Worker package.

## Configuration and operations

The API rejects private or loopback video URLs by default. Set
`CAPSULE_ALLOW_PRIVATE_URLS=1` only in a trusted private deployment. The main
limits are:

```text
CAPSULE_MAX_DOWNLOAD_BYTES=500000000
CAPSULE_DOWNLOAD_TIMEOUT_SEC=120
```

Whisper's `tiny` model is loaded when the application starts. Give the service
enough memory for model loading and concurrent extraction, and use persistent
model caching or a pre-warmed image if startup latency matters. Do not expose
the API publicly without authentication or an upstream gateway policy; the
current application provides URL validation and download limits, not user
authentication.
