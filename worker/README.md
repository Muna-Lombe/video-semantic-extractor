<!-- @type documentation @purpose Document the Cloudflare gateway. -->
# Worker gateway

The Worker validates `POST /capsule`, applies a 2 KiB request-body limit, and
forwards the request to `UPSTREAM_API_URL`. Set the optional secret
`CAPSULE_API_TOKEN` when the backend requires bearer authentication.

The gateway is deliberately not a video upload proxy; clients send a public video
URL and the backend performs the bounded download.

