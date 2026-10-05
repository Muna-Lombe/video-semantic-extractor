<!-- @type documentation @purpose Describe the managed sampling-runner Worker package. -->
# Sampling-runner Worker

Schedules the sampling Container and proxies its allowlisted runner API requests
to the control plane through a private Service binding. Deploy it from the parent
`workers/` root with `wrangler.sampling-runner.toml`.

The Worker requires `SAMPLING_CONTAINER`, `CONTROL_PLANE`, and `RUNNER_TOKEN`.
Non-runner paths are rejected, and unsuccessful scheduled dispatches fail the
scheduled task for Cloudflare observability.

## Logs and observability

The sampling-runner and control-plane Wrangler configurations enable Workers
Observability with a 100% head-sampling rate. The sampling-runner retains
invocation logs. The control plane disables raw invocation logs to avoid retaining
invitation credentials that may appear in request URLs; it emits safe structured
API events instead. After deploying the configurations, use **Workers & Pages →
the Worker → Observability → Logs**, or stream live events with
`npx wrangler tail --config wrangler.sampling-runner.toml` and
`npx wrangler tail --config wrangler.toml`.

The runner Worker emits structured events for scheduled dispatch and each
control-plane service-binding response, including status and elapsed time. The
Python Container writes structured JSON lifecycle events to stdout for claims,
idle/busy cycles, source download and processing, finalization, and failures.
Container stdout/stderr and Durable Object invocation outcomes are available from
the sampling-runner's Cloudflare logs. Logs deliberately omit bearer credentials,
lease tokens, source URLs, and request bodies.
