<!-- @type documentation @purpose Describe the Product capsule Container Worker package. -->
# Capsule Container Worker

Adapts the Product capsule API image to a Cloudflare Container Durable Object.
Build and push the image from the repository root, then deploy from the parent
`workers/` root with `wrangler.capsule-container.toml`.

The adapter depends on `@cloudflare/containers` and the `VIDEO_CONTAINER` binding.
Container startup or upstream failures are returned as HTTP error responses.
