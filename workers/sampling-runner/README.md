<!-- @type documentation @purpose Describe the managed sampling-runner Worker package. -->
# Sampling-runner Worker

Schedules the sampling Container and proxies its allowlisted runner API requests
to the control plane through a private Service binding. Deploy it from the parent
`workers/` root with `wrangler.sampling-runner.toml`.

The Worker requires `SAMPLING_CONTAINER`, `CONTROL_PLANE`, and `RUNNER_TOKEN`.
Non-runner paths are rejected, and unsuccessful scheduled dispatches fail the
scheduled task for Cloudflare observability.
