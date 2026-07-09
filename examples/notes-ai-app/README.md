# Notes AI App

This example was generated from `skills/create-sandbank-ai-app/SKILL.md`.

It shows the intended Sandbank App Kernel shape for a new AI product:

- one app manifest;
- object and capability contracts;
- a DB9/Postgres-compatible workspace gateway;
- branch-first proposals for writes;
- approval before user-visible data changes;
- SDK and Tool Use execution from the same capability contract.

## Run

```bash
pnpm --filter @sandbank.example/notes-ai-app typecheck
pnpm --filter @sandbank.example/notes-ai-app verify
```

By default the example uses a local DB9-compatible workspace and a temporary
Sandbank scoped grant. To test against a real DB9 workspace, set:

```bash
export DB9_TOKEN=...
export DB9_DB_ID=...
pnpm --filter @sandbank.example/notes-ai-app verify
```

The verification script does not print real tokens.
