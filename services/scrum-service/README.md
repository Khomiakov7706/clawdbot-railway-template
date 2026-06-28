# scrum-service

First externalized service of the OpenClaw migration (see
[`docs/current-state-audit.md`](../../docs/current-state-audit.md)). It lifts the
read-only Scrum-Postgres watching logic out of the OpenClaw `scrummaster` agent
workspace into a standalone service that OpenClaw calls **over MCP**.

It is the lowest-risk migration candidate (read-only Postgres, no browser, no money) and
exists to validate the whole "separate Railway service ↔ OpenClaw via MCP" pattern before
the riskier food/finance services follow.

> Lives under `services/scrum-service/` in the wrapper repo for now. On Railway it is its
> own service with **Root Directory = `services/scrum-service`**. If the system later moves
> to a dedicated monorepo, this is a clean `git mv`.

## Capabilities (MCP tools)

| MCP tool             | Origin script (OpenClaw workspace)   | Notes |
|----------------------|--------------------------------------|-------|
| `scrum_overview`     | `scrum_db_overview.mjs`              | tables + counts + latest + columns |
| `scrum_change_check` | `scrum_db_change_check.mjs`          | stateful; new rows since last call |
| `scrum_export`       | `scrum_db_export.mjs`                | `kind`, `limit` (json only) |

All are **read-only**. SQL logic is ported verbatim from the originals.

## HTTP surface

| Route          | Auth   | Purpose |
|----------------|--------|---------|
| `GET /health`  | none   | Railway healthcheck |
| `GET /version` | none   | build info |
| `POST /mcp`    | bearer | MCP streamable-http endpoint |

`/mcp` requires `Authorization: Bearer ${INTERNAL_API_KEY}` and **fails closed** if no key
is configured.

## Run locally

```bash
cp .env.example .env   # fill SCRUM_POSTGRESQL_PUBLIC_URL + INTERNAL_API_KEY
npm install
npm test               # pure-logic unit tests (no DB needed)
npm start              # serves on $PORT (default 3000)
curl localhost:3000/health
```

## Deploy on Railway

1. New service in the `openClaw` project → deploy from this repo.
2. Settings → **Root Directory** = `services/scrum-service` (Dockerfile builder).
3. Variables: `SCRUM_POSTGRESQL_PUBLIC_URL`, `INTERNAL_API_KEY`
   (`openssl rand -hex 32`). Optionally attach a volume at `/data` to persist
   change-check state.
4. Keep it **private** (no public domain) — OpenClaw reaches it over Railway private
   networking at `scrum-service.railway.internal`.

## Wire into OpenClaw (the new instance)

```bash
openclaw mcp add scrum \
  --transport streamable-http \
  --url http://scrum-service.railway.internal:${PORT}/mcp \
  --header "Authorization=Bearer ${INTERNAL_API_KEY}"
openclaw mcp probe   # should list scrum_overview / scrum_change_check / scrum_export
```

Once validated, the `scrummaster` agent's `TOOLS.md`/`HEARTBEAT.md` can point at these MCP
tools instead of running the local `.mjs` scripts.

## Not migrated here (intentionally)

- The `while true; sleep 1800` watch daemon + direct Telegram send (`scrum_db_watch_*`).
  Scheduling and notification belong to the future `scheduler-service` / OpenClaw, not to
  this read API. This service only answers when asked.
