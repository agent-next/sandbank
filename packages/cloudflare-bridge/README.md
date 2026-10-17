# @sandbank.dev/cloudflare-bridge

Lets the Sandbank MCP server (and any Node client) use Cloudflare Sandboxes
(Workers + Containers, via `@cloudflare/sandbox`). The existing
`@sandbank.dev/cloudflare` adapter only runs inside a Worker; this package adds

- a small **bridge Worker** (`src/worker`) that hosts the Sandbox Durable Object and exposes a bearer-token HTTP API, and
- a **client adapter** (`CloudflareBridgeAdapter`) that the MCP server registers as the `cloudflare` provider.

Cloudflare has no hard spending limit, so the bridge is built to be cheap and easy to stop:

| Guard | Value |
| --- | --- |
| Container `max_instances` | 256 |
| Container `instance_type` | `standard-1` (1/2 vCPU, 4 GiB: fits one Claude Code worker) |
| Idle sleep (`sleepAfter`) | 5 min |
| Sandbox lifetime | default 30 min, max 60 min, enforced per request and by a 5-minute cron |
| Concurrent sandboxes | 256 (HTTP 429 at the cap) |
| Creation cutoff | optional `CREATE_DEADLINE` var (ISO time): creates return 403 from then on; unset means no cutoff, an unparseable value refuses creates |
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

To stop new sandboxes at a fixed time (for example when a credit ends), deploy with
`wrangler deploy --var CREATE_DEADLINE:2030-01-01T00:00:00Z`. There is no default cutoff.

`wrangler deploy --dry-run --outdir .wrangler-dry-run` validates the bundle and bindings without deploying.
Set `PREVIEW_HOSTNAME` (a custom domain with wildcard routing) to enable `port_expose`. Ports must be 1024-65535; 3000 is reserved by the Sandbox SDK control plane inside the container.

## Use from the MCP server

```sh
SANDBANK_CF_BRIDGE_URL=https://<your-bridge>.workers.dev \
SANDBANK_CF_BRIDGE_TOKEN=<token> npx @sandbank.dev/mcp
```

Without both variables `providers_list` shows `cloudflare (not configured)`.

## References

Cloudflare documentation used for this package:

- Sandbox SDK Wrangler configuration: https://developers.cloudflare.com/sandbox/sdk/configuration/wrangler/
- Sandboxes get started: https://developers.cloudflare.com/sandbox/get-started/
- Containers limits and instance types: https://developers.cloudflare.com/containers/platform/limits/
- Containers pricing: https://developers.cloudflare.com/containers/pricing/
- Containers scheduling policy: https://developers.cloudflare.com/containers/configuration/scheduling-policy/
- Durable Objects alarms: https://developers.cloudflare.com/durable-objects/api/alarms/
- Cron Triggers: https://developers.cloudflare.com/workers/configuration/cron-triggers/
- Wrangler configuration: https://developers.cloudflare.com/workers/wrangler/configuration/
- Wrangler `containers` commands: https://developers.cloudflare.com/workers/wrangler/commands/containers/
