# @sandbank.dev/cloudflare-bridge

Lets the Sandbank MCP server (and any Node client) use Cloudflare Sandboxes
(Workers + Containers, via `@cloudflare/sandbox`). The existing
`@sandbank.dev/cloudflare` adapter only runs inside a Worker; this package adds

- a small **bridge Worker** (`src/worker`) that hosts the Sandbox Durable Object and exposes a bearer-token HTTP API, and
- a **client adapter** (`CloudflareBridgeAdapter`) that the MCP server registers as the `cloudflare` provider.

Cloudflare has no hard spending limit, so the bridge is built to be cheap and easy to stop:

| Guard | Value |
| --- | --- |
| Container `max_instances` | 3 |
| Container `instance_type` | `basic` |
| Idle sleep (`sleepAfter`) | 5 min |
| Sandbox lifetime | default 30 min, max 60 min, enforced per request and by a 5-minute cron |
| Concurrent sandboxes | 3 (HTTP 429 at the cap) |
| Kill switch | `DRAIN=1`: every request gets 503, every alarm deletes itself and stops the container, the cron destroys all sandboxes |
| Alarm hygiene | `schedule()` values are clamped to [0, 1 h] (the library takes seconds, not epoch ms); `alarm()` never throws, it parks |
| Auth | `Authorization: Bearer <BRIDGE_TOKEN>`, constant-time compare; unconfigured token rejects everything |

## Deploy

```sh
cd packages/cloudflare-bridge
printf '%s' "$TOKEN" | wrangler secret put BRIDGE_TOKEN
wrangler deploy
# stop everything:
wrangler deploy --var DRAIN:1
```

`wrangler deploy --dry-run --outdir .wrangler-dry-run` validates the bundle and bindings without deploying.
Set `PREVIEW_HOSTNAME` (a custom domain with wildcard routing) to enable `port_expose`.

## Use from the MCP server

```sh
SANDBANK_CF_BRIDGE_URL=https://<your-bridge>.workers.dev \
SANDBANK_CF_BRIDGE_TOKEN=<token> npx @sandbank.dev/mcp
```

Without both variables `providers_list` shows `cloudflare (not configured)`.
