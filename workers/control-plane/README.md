<!-- @type documentation @purpose Describe the control-plane and hosted review Worker package. -->
# Control-plane Worker

Hosts Internals APIs, the review/adjudication workflow, static browser assets, and
D1 migrations. Deploy it from the parent `workers/` root with `wrangler.toml` so
all asset and migration paths resolve consistently.

The Worker depends on D1, private R2 buckets, Static Assets, `ADMIN_TOKEN`, and the
optional runner credential described in `../README.md`. API errors are returned as
structured HTTP responses; deployment and migration failures stop the production
release script.
