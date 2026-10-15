---
name: sandbank
description: Run code and commands in disposable sandboxes through the Sandbank MCP server (local Docker or sbx cloud). Use to execute untrusted or heavy code, run long jobs, expose a preview URL, or show the user a live console of their sandboxes.
---

# Use Sandbank sandboxes

The `@sandbank.dev/mcp` server creates disposable sandboxes on two providers
and shows them in an inline console. Tools: `providers_list`, `sandbox_create`,
`sandbox_list`, `sandbox_exec`, `file_read`, `file_write`, `port_expose`,
`sandbox_destroy`, `render_console`.

## Pick a provider

| Need | Provider |
| --- | --- |
| Local, free, offline, or a GPU on the user's own box | `docker` |
| A link the user can open or share (public https preview) | `sbx` |
| Cloud GPU templates, isolation from the user's machine | `sbx` |
| Untrusted code | `sbx` (containers are not a strong boundary) |

- `docker` is always available when the docker CLI works. Local GPU access is
  configured by the server operator through `runArgs` (for example
  `--gpus all`), not per call.
- `sbx` needs `SBX_API_KEY` in the server's environment. `image` is an sbx
  template name. Ports are served at `https://<port>-<id>.<domain>`.
- With `docker`, `port_expose` only works for ports published at create: pass
  `ports: [[0, 3000]]` (0 = any free host port). The URL is local
  (`http://127.0.0.1:<port>`), so it is not shareable.
- If the user wants a shareable preview and `sbx` is not configured, say so
  instead of silently falling back to docker.

## Standard loop

1. `providers_list` — see which providers are `configured` and their
   `capabilities`.
2. `sandbox_create` with `provider`, optional `image`, `env`, and always
   `autoDestroyMinutes` (a safety net, e.g. 30). Keep the returned `id`.
3. `file_write` code in, then `sandbox_exec` to run it. Prefer writing a
   script file over long inline shell quoting.
4. `port_expose` for any web service, then give the user the `url`.
5. `render_console` to show the result (see below).
6. `sandbox_destroy` when done.

## Rules

- **Always destroy what you create**, also after a failure. Before finishing,
  `sandbox_list` and confirm nothing of yours remains. Never destroy
  sandboxes you did not create unless the user asks.
- **No secrets in commands, file contents, or URLs.** Pass credentials as
  `env` at `sandbox_create` and reference `$NAME` in commands. Never echo them.
  Env values must be single-line.
- **Keep output short.** Pipe through `tail -n 50`, `head`, or `grep`;
  redirect noisy installs to a log file and read only the tail with
  `file_read`. Large stdout wastes context.
- **Use absolute paths** or `cwd` for `sandbox_exec`; each exec is a fresh
  shell, so `cd` and `export` do not persist between calls.
- **Verify, do not assume.** Check `exitCode` and `stderr` on every exec.
- `file_read` returns base64 for binary files (images, archives).

## When to call `render_console`

Data tools (`sandbox_list`, `sandbox_exec`, ...) return data for you to reason
over; `render_console` renders it for the user. Call it:

- after a meaningful result: a server is up, a build or test run finished,
  an artifact is ready, or several sandboxes are running in parallel;
- with `focusId` to highlight the sandbox you are discussing;
- once at the end, before cleanup, when the user should see the final state.

Do not call it after every step. It adds no information for you, and a host
without MCP Apps support shows only a text summary, so always state the key
facts (id, url, exit code) in your own reply too.

## Errors

| Symptom | Fix |
| --- | --- |
| `ExecTimeout` | Raise `timeoutMs` for legitimately slow work. For jobs longer than a few minutes, background it: `nohup cmd > /tmp/job.log 2>&1 &`, then poll with `sandbox_exec` (`tail /tmp/job.log`, `pgrep`). |
| sandbox not found | It expired (`autoDestroyMinutes`) or was destroyed. Run `sandbox_list`, and create a new one if needed. |
| provider not configured | Run `providers_list`; for `sbx` ask the user to set `SBX_API_KEY` and restart the server. |
| `port_expose` fails on docker | The port was not published at create. Recreate with `ports`. |
| nonzero `exitCode` | Read `stderr`, fix, rerun. Do not retry blindly. |

Report errors to the user plainly; do not hide a failed run behind a console.
