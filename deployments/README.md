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

The Cloudflare deployment uses the same Dockerfile as the Compose deployment.
Build and push the image to Cloudflare's container registry from the repository
root, then update the account ID in
`deployments/cloudflare/wrangler.toml`. The Worker entry point binds a single
named Durable Object container to the Python API on port 8000:

```bash
docker build -f deployments/Dockerfile \
	-t registry.cloudflare.com/ACCOUNT_ID/video-semantic-extractor:latest .
docker push registry.cloudflare.com/ACCOUNT_ID/video-semantic-extractor:latest
npx wrangler deploy --config deployments/cloudflare/wrangler.toml
```

Cloudflare Container support must be enabled for the account and the selected
instance type must be available in the target region. The container needs
outbound internet access because the API downloads public videos and loads the
Whisper model. The image build installs and verifies `ffmpeg`/`ffprobe` before
Python dependencies, so the Cloudflare deployment has the same prerequisite
guarantee as Compose. Docker is required locally or in CI to build the image;
Wrangler only deploys the pushed image.

The Worker entry point in `worker/src/container.ts` is intentionally separate
from the existing `worker/src/index.ts` gateway. Use the existing Worker when
the Python API is hosted elsewhere; use this configuration when Cloudflare
should host the Python API itself.

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