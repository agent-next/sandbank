# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

## [0.8.1] - 2026-10-15

### Added
- `@sandbank.dev/mcp` — MCP server (`sandbank-mcp` bin) exposing sandbox tools plus an MCP Apps console UI (`render_console`), with a bundled skill/plugin
- Hosted mode for `@sandbank.dev/mcp` (`SANDBANK_MCP_TOKEN` secret path, `SANDBANK_MCP_PROVIDERS` filter) for Claude/ChatGPT custom connectors
- OpenUI `render_view` generative view in `@sandbank.dev/mcp` (component catalog bundled via `@sandbank.dev/openui-view`, now published)
- `@sandbank.dev/sbx` — agent-next sandbox (sbx) adapter: E2B-compatible cloud sandbox with sbx endpoints, `SBX_API_KEY`, and kill-on-timeout defaults
- `@sandbank.dev/docker` — local Docker container adapter over the `docker` CLI: exec/stream, files, pause/unpause, published ports, named volumes, `--rm` auto-destroy
- `E2BAdapterConfig.apiUrl` so E2B-compatible endpoints are not overridden by a global `E2B_API_URL`
- `connectTerminal()` in `@sandbank.dev/core` — wraps ttyd WebSocket binary protocol into `TerminalSession` interface with `write`/`onData`/`resize`/`close`
- GitHub Actions CI workflows (PR checks, integration tests, npm release)
- Vitest resolve aliases for cross-package imports without build step

### Fixed
- `@sandbank.dev/mcp` HTTP endpoint answers CORS for browser-based MCP hosts (any origin when hosted, local origins only in local mode)
- OpenUI view sends `ui/notifications/initialized`, so MCP Apps hosts deliver the tool result; BarChart width capped
- `uploadArchive`/`downloadArchive` error messages now correctly identify the unsupported operation instead of misleading `'snapshot'`
- Daytona integration tests now properly skip when `DAYTONA_API_KEY` is not set
- `@sandbank.dev/relay` package resolution failure in tests (missing `dist/` directory)

### Changed
- README terminal capability updated from ❌ to ✅ for all providers (ttyd-based implementation)
- `@sandbank.dev/boxlite` local mode now uses the official `@boxlite-ai/boxlite` Node.js SDK instead of the Python bridge

## [0.1.0] - 2026-02-27

Initial release.

### Added

#### Core (`@sandbank.dev/core`)
- `SandboxProvider` interface with `create`/`get`/`list`/`destroy` operations
- Capability system: `exec.stream`, `terminal`, `sleep`, `volumes`, `snapshot`, `port.expose`
- Type-safe capability detection: `withTerminal()`, `withStreaming()`, `withVolumes()`, etc.
- Error hierarchy: `SandboxError`, `SandboxNotFoundError`, `ExecTimeoutError`, `CapabilityNotSupportedError`, etc.
- `createSession()` for multi-agent orchestration with shared context
- `writeFileViaExec`/`readFileViaExec` fallbacks for adapters without native file I/O

#### Adapters
- `@sandbank.dev/daytona` — Daytona cloud VM adapter (volumes, port.expose, terminal)
- `@sandbank.dev/flyio` — Fly.io Machines adapter, zero external dependencies (volumes, port.expose, terminal)
- `@sandbank.dev/cloudflare` — Cloudflare Workers adapter (exec.stream, snapshot, volumes, port.expose, terminal)

#### Communication
- `@sandbank.dev/relay` — WebSocket + HTTP relay server with JSON-RPC 2.0 protocol
- `@sandbank.dev/agent` — Lightweight in-sandbox client with `connect()`, messaging, and shared context

#### Testing
- Cross-provider conformance test suite (38+ tests)
- Unit tests for all packages
- Integration tests gated by environment variables (Daytona, Fly.io, Cloudflare)
- E2E tests for Cloudflare Workers

#### Documentation
- README in English, Chinese, and Japanese
