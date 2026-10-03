<!-- @type documentation @purpose Describe the optional external capsule gateway Worker package. -->
# Capsule Gateway Worker

Validates capsule requests and forwards them to an externally hosted backend. It
is retained as an alternative to the Cloudflare Container adapter and currently
has no production Wrangler configuration.

Set `UPSTREAM_API_URL` and, when required, `CAPSULE_API_TOKEN`. Invalid requests
and upstream failures are returned as bounded HTTP error responses.
