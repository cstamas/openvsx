# Open VSX edge rate limiting

A Fastly Compute service that attributes each request to an Open VSX rate limit customer,
rejects customers the origin has blocked, and reports customer requests back to the origin.
The origin side and its configuration are described under `ovsx.rate-limit.edge` in
[doc/configuration.md](../doc/configuration.md).

## Develop

```sh
npm install
npm test                 # request-path logic, no Fastly runtime needed
npm run build            # bin/main.wasm
fastly compute serve     # local server on :7676, origin expected on :8080
```

`fastly.toml` seeds the local KV store from `local/ratelimit-config.json`. Requests from
127.0.0.1 resolve to the customer `local`, and `X-RateLimit-Token: dev-blocked-token` resolves to
a customer that is blocked, so it gets a `429`. Usage records are printed to the local server's
output.

## Service resources

The deployed service links these, by name:

| Name        | Kind                   | Content                                                        |
|-------------|------------------------|----------------------------------------------------------------|
| `origin`    | backend                | the Open VSX origin                                            |
| `ratelimit` | KV store               | written by the origin: `ratelimit-config`, `block:<customer>`  |
| `ratelimit` | secret store           | `edge-shared-secret`, equal to `ovsx.rate-limit.edge.shared-secret` |
| `usage`     | HTTPS logging endpoint | POSTs to `https://<origin host>/internal/edge/usage`, newline-delimited JSON, header `X-OpenVSX-Edge-Secret` |

Point the logging endpoint at the origin's own host name, not the public one served by this
service. Fastly also needs the origin to answer its logging endpoint ownership challenge at
`/.well-known/fastly/logging/challenge`. The origin does not do that yet.
