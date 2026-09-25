# Edge Rate Limiting: running the proof of concept locally

This proof of concept moves customer rate limiting in front of the Fastly CDN. A Fastly Compute
service (`edge/`) attributes each request to a rate limit customer and rejects customers the
origin has blocked. It reports customer requests back to the origin, which charges them to the
customer's tier (`server/`, package `org.eclipse.openvsx.ratelimit.edge`). The configuration is
documented under `ovsx.rate-limit.edge` in [doc/configuration.md](doc/configuration.md).

## What works locally, and what does not

The local Fastly server (`fastly compute serve`, which runs Viceroy) stands in for Fastly, with
two gaps:

| Part of the loop | Locally |
|---|---|
| Edge attributes a request to a customer by client IP or `X-RateLimit-Token` | works |
| Edge overwrites forged `X-OpenVSX-Edge-*` / `X-OpenVSX-Client-IP` headers | works |
| Edge strips the origin's per-client `X-RateLimit-*` headers | works |
| Edge rejects a blocked customer with `429` | works, for the customer blocked in the fixture only (see below) |
| Edge writes one usage line per charged customer request | works, printed to the local server's output |
| Fastly delivers usage lines to `/internal/edge/usage` | **not available**: step 5 pipes the output to the origin with `curl` instead |
| Origin ingests usage, charges the customer's bucket, rejects forwarded requests once it is exhausted | works |
| Origin publishes customer config and blocks to the Fastly KV store | **not visible to the edge**: the local KV store is read from files at startup and the origin cannot write to it. Step 3 runs a stand-in Fastly API that prints the writes |
| Unblock job deletes a block once the bucket refills | works, visible as a `DELETE` on the stand-in API |
| Fastly logging endpoint ownership challenge | **not implemented** (`/.well-known/fastly/logging/challenge`), needed before a real deployment |

So the edge never learns about blocks the origin creates. The end-to-end effect is still
visible, because the origin itself rejects the requests the edge forwards once the customer's
bucket is empty. Blocking at the edge is shown separately with a customer the fixture
(`edge/local/ratelimit-config.json` and `edge/fastly.toml`) marks as blocked.

## Prerequisites

- Docker, for Postgres and the Valkey cluster
- Java 25 (for example `~/.sdkman/candidates/java/25.0.4-tem`); the build refuses Java 21
- Node.js 22 or newer
- The Fastly CLI (`fastly`); no Fastly account or login is needed for the local server
- Python 3, for the stand-in Fastly API

Ports used: 5432 (Postgres), 7001-7006 (Valkey), 8080 (origin), 7676 (edge), 9090 (stand-in
Fastly API).

## 1. Start Postgres and Valkey

From the repository root:

```sh
docker compose --profile db --profile valkey up -d
```

## 2. Start the stand-in Fastly API

In a new terminal. It accepts the origin's KV writes and prints them:

```sh
python3 - <<'EOF'
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import unquote
class H(BaseHTTPRequestHandler):
    def _ok(self, verb):
        n = int(self.headers.get('Content-Length', 0))
        print(verb, unquote(self.path.rsplit('/keys/', 1)[-1]), self.rfile.read(n).decode()[:120], flush=True)
        self.send_response(200); self.end_headers()
    def do_PUT(self): self._ok('PUT')
    def do_DELETE(self): self._ok('DELETE')
    def log_message(self, *a): pass
HTTPServer(('127.0.0.1', 9090), H).serve_forever()
EOF
```

## 3. Start the origin with rate limiting and the edge enabled

In a new terminal:

```sh
cd server
export JAVA_HOME=~/.sdkman/candidates/java/25.0.4-tem
SPRING_APPLICATION_JSON='{
  "spring": {"data": {"redis": {
    "cluster": {"nodes": "127.0.0.1:7001,127.0.0.1:7002,127.0.0.1:7003,127.0.0.1:7004,127.0.0.1:7005,127.0.0.1:7006"},
    "username": "openvsx", "password": "openvsx"}}},
  "ovsx": {"rate-limit": {"enabled": true, "edge": {"enabled": true,
    "fastly-api-url": "http://127.0.0.1:9090", "fastly-api-token": "local", "kv-store-id": "local"}}}
}' ./gradlew runServer
```

The shared secret needs no setting: `server/src/dev/resources/application.yml` has
`dev-edge-secret`, the same value as the local secret store in `edge/fastly.toml`. On startup
the stand-in API prints `PUT ratelimit-config {...}`, the customer configuration the origin
publishes for the edge.

## 4. Create a tier and a customer

Once the origin has started, since Flyway creates the tables. The customer must be named
`local`, the name the edge fixture gives 127.0.0.1:

```sh
docker compose exec -T postgres psql -U openvsx -d postgres <<'SQL'
INSERT INTO tier (id, name, description, tier_type, capacity, duration, refill_strategy)
VALUES (9001, 'edge-poc', 'edge PoC', 'NON_FREE', 5, 60, 'GREEDY');
INSERT INTO customer (id, name, tier_id, state, cidr_blocks)
VALUES (9001, 'local', 9001, 'ENFORCEMENT', '127.0.0.1/32');
SQL
```

That is 5 requests per 60 seconds, refilled continuously (one request every 12 seconds), and
enforced.

## 5. Start the edge, and deliver its usage lines to the origin

In a new terminal:

```sh
cd edge
npm install
npm run build
fastly compute serve --skip-build 2>&1 \
  | grep --line-buffered -o '{"ts".*}' \
  | while read -r line; do
      curl -s -o /dev/null -X POST http://127.0.0.1:8080/internal/edge/usage \
           -H 'X-OpenVSX-Edge-Secret: dev-edge-secret' --data-binary "$line"
    done
```

The edge listens on 7676 and forwards to the origin on 8080. The pipeline stands in for the
Fastly logging endpoint, posting each usage line as a batch of one.

## 6. Try it

### A customer running out of its tier

```sh
for i in $(seq 1 8); do curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:7676/api/-/search; done
```

Expect about five `200` followed by `429`:

- The `429`s come from the origin. The edge had already reported the first five requests, so the
  bucket is empty when the origin checks it.
- The stand-in API prints `PUT block:local <epoch>`. In a real deployment this is what makes the
  edge itself reject the customer, without forwarding.
- Rejected requests are not charged, so retrying does not extend the block. One request succeeds
  again about every 12 seconds. Within a minute the unblock job prints `DELETE block:local`.
- The responses have no `X-RateLimit-*` headers: the edge removes them, since from a cached
  response they would describe another client.

### Blocking at the edge

The fixture holds a customer blocked until 2100, identified by a token:

```sh
curl -i http://127.0.0.1:7676/api/-/search -H 'X-RateLimit-Token: dev-blocked-token'
```

The response is a `429` with `Retry-After` produced by the edge; the request never reaches the
origin.

### Forged edge headers

Sent straight to the origin with the wrong secret:

```sh
curl -si http://127.0.0.1:8080/api/-/search \
  -H 'X-OpenVSX-Edge-Secret: guess' -H 'X-OpenVSX-Edge-Customer: local' | grep -i x-ratelimit
```

The origin ignores the claimed customer and counts the request as usual. The `X-RateLimit-Limit`
header shows it was charged on the origin. Through the edge, a client's copy of these headers is
overwritten before the request is forwarded.

### Operational paths are not limited

```sh
curl -si http://127.0.0.1:8080/actuator/health | grep -i x-ratelimit || echo "not rate limited"
```

## Clean up

Stop the three foreground processes, then:

```sh
docker compose exec -T postgres psql -U openvsx -d postgres \
  -c "DELETE FROM customer WHERE id = 9001; DELETE FROM tier WHERE id = 9001;"
docker compose --profile db --profile valkey down
```

## Automated tests

Nothing above is needed to run the tests:

```sh
cd server && JAVA_HOME=~/.sdkman/candidates/java/25.0.4-tem ./gradlew test --tests 'org.eclipse.openvsx.ratelimit.*'
cd edge && npm test
```

`EdgeRateLimitIntegrationTest` covers the origin's side of the loop against a real Spring
context and Postgres (Docker required). The Fastly API and Redis are mocked.

## Known limitations of the proof of concept

- **Anonymous traffic is not counted at the edge.** Only identified customers are; the origin
  still limits anonymous requests that reach it, but anonymous cache hits are not counted
  anywhere.
- **The origin's IP matching has quirks, and the edge copies them.** It is IPv4 only. Where
  customer ranges overlap, the least specific one wins. A range written with host bits set
  (`1.1.1.1/24`) matches that single address only. The edge reproduces all three so the two
  sides agree; they look like origin bugs worth fixing together.
- **A download costs two requests**: the `302` and the CDN fetch it points to. Tier capacities
  need re-tuning before customers are enforced.
- **Enforcement at the edge lags** by the log batch period plus KV propagation, expected under a
  minute. The origin rejects forwarded requests immediately, but cached responses keep flowing
  until the edge sees the block.
- **Real-time usage is not reconciled** against the hourly S3 access logs. Batch deduplication
  covers Fastly's redeliveries, but a batch Fastly drops outright is lost from the usage
  statistics.
