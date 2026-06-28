# Current-state audit — OpenClaw on Railway

> Snapshot date: 2026-06-28. Source: live container (`railway ssh`) of the
> `openClaw` project, `production` env, service `main-clawdbot`. This is the factual
> base for the migration plan. Secrets are listed by **name only** (values redacted).

## 0. Headline facts

- **One Railway service** (`main-clawdbot`) runs everything. This repo is only a thin
  wrapper (`src/server.js` serves `/setup/healthz`, proxies the OpenClaw gateway); it
  builds OpenClaw from source. **No business logic lives in this repo.**
- **All agent logic lives in the runtime volume**, not in code:
  - state dir `/data/.clawdbot` (config `openclaw.json`, per-agent auth/sessions)
  - per-agent workspaces `/data/workspace-<agent>`
  - a shared workspace `/data/workspace` (contains the trader's real service code)
- **Running OpenClaw version: `v2026.6.10`** — but the Dockerfile pins `v2026.6.9`.
  → in-place `openclaw update` drift. Reproducible builds are not guaranteed today.
- **Default model:** `codex/gpt-5.5` (codex agent runtime).
- **MCP go/no-go: GO.** `openclaw mcp add` supports `--transport streamable-http | sse`,
  `--url`, `--header`, `--auth oauth`, mutual TLS. Remote HTTP MCP servers over the
  network are fully supported → the "separate Railway service ↔ OpenClaw via MCP"
  architecture is viable.
- **MCP currently in use: NONE.** `openclaw mcp list` is empty. So today nothing is
  wired via MCP; agent capability comes from built-in tools + per-workspace scripts.

## 1. Agents (from `agents.list` + Telegram bindings)

| Agent id      | Persona / theme                  | Telegram account | Workspace                     | Status |
|---------------|----------------------------------|------------------|-------------------------------|--------|
| `main`        | default gateway persona          | (default)        | —                             | active |
| `healthdiet`  | "Док" — AI dietologist           | `healthdiet`     | `/data/workspace-healthdiet`  | active |
| `scrummaster` | "Скрам-мастер" — scrum for team  | `scrummaster`    | `/data/workspace-scrummaster` | active |
| `trader`      | "Trader" — guarded trade support | `trader`         | `/data/workspace-trader`      | active |
| `claude-code` | codegen agent runtime dir        | —                | —                             | runtime |
| `codex`       | codex agent runtime dir          | —                | —                             | runtime |

Routing: `bindings` map `telegram.accountId` → agent. Each business agent has its own
Telegram bot account.

Agent "logic" pattern (same for all): markdown instruction files in the workspace —
`AGENTS.md`, `SYSTEM_PROMPT.md`, `TOOLS.md`, `HEARTBEAT.md`, `MEMORY.md`, `USER.md`,
`SOUL.md`, `IDENTITY.md` — plus per-workspace `scripts/`, `node_modules`/`.venv`.

## 2. Global config inventory (`/data/.clawdbot/openclaw.json`)

- `skills.entries.goplaces.apiKey` — Google Places API key **(secret, in config)**
- `plugins`: `openai`, `telegram`, `codex` enabled; `perplexity` enabled with
  `webSearch.apiKey` **(secret, in config)**
- `tools`: `profile`, `web` (no Playwright/browser tool registered globally — browser
  automation is driven from the agent workspace, not a global tool)
- `hooks.internal`: `boot-md`, `command-logger`, `compaction-notifier`,
  `session-memory`, `bootstrap-extra-files`
- `session.heartbeat.dmScope = per-channel-peer`

⚠️ **Secrets stored in plaintext inside `openclaw.json`** (goplaces, perplexity). Part
of migration should move these into per-service Railway env vars + secret store.

## 3. Per-functionality audit

### 3.1 Food / nutrition logging  → target `food-service`
- **Lives in:** `healthdiet` workspace, `skills/health-diet`, Playwright
  (`package.json: playwright ^1.60`). Browser screenshots present
  (`tmp-after-dinner-click.png`, `tmp-after-search-gov.png`, `tmp-health-search.png`).
- **External systems:** the Health Diet web app (browser automation/login), Google
  Places (`goplaces`), Perplexity web search.
- **Secrets:** `HEALTH_DIET_EMAIL`, `HEALTH_DIET_PASSWORD`, goplaces key, perplexity key.
- **Trigger:** user via Telegram (`healthdiet`) + heartbeat (alerts only on failed diet
  job / broken Health Diet auth).
- **State:** workspace `.git`, `memory/`, screenshots, `.venv`.
- **Migrate?** Yes. Playwright + credentials → isolated container (also removes heavy
  browser deps from the OpenClaw image).
- **Priority:** 2nd (after a read-only warm-up). **Risk:** browser session/auth fragility,
  stored login/password.

### 3.2 Garmin (sleep / HRV / activity)  → target `garmin-service`
- **Lives in:** also inside `healthdiet` (NOT a separate agent). `garmin-activity-*.png`
  in the workspace; `TOOLS.md` says "use Garmin data to interpret nutrition/recovery".
  `.venv` suggests a Python Garmin client.
- **External systems:** Garmin Connect.
- **Secrets:** Garmin credentials (env, to confirm exact var names).
- **Trigger:** indirectly via healthdiet conversations.
- **Migrate?** Yes, but note: **Garmin and Food are entangled in one agent.** Splitting
  them is real work, not a clean lift. Read-only, so low risk once separated.
- **Priority:** good first *read-only* candidate, but requires un-entangling from food.

### 3.3 Trading / signals  → target `finance-service`
- **Lives in:** mostly **already externalized** as a standalone Python codebase at
  `/data/workspace/tg-user-listener` (+ `signal-trader-service` compat shim). The
  `trader` agent workspace is thin: `AGENTS.md`, `docs/TRADING_RUNBOOK.md`,
  `scripts/trader_health_check.sh`.
- **Key code:** `listener.py` (Telegram user-listener for signals),
  `bybit_execution_guarded.py` (**guarded** trade execution on Bybit),
  `daily_report_daemon.py`, `portfolio_review_daemon.py`,
  `backfill_50_to_postgres.py`, `prune_postgres_retention.py`,
  `check_listener_health.{py,cron}`.
- **External systems:** Telegram (signal source), **Bybit exchange (real orders)**,
  PostgreSQL.
- **Secrets:** `TELEGRAM_INVEST_BOT_TOKEN`, `SIGNAL_ALERT_BOT_TOKEN`, `DATABASE_URL`,
  Bybit API key/secret, notify chat ids (`TELEGRAM_TRADE_NOTIFY_CHAT_ID`, …).
- **Runtime state:** `/data/tg-user-listener/runtime/*.json` (supervisor_state,
  telegram_listener_status, daily_report_state, bot_updates_state) + Postgres.
- **Trigger:** cron (`check_listener_health.cron`), supervised daemons, heartbeat health
  alerts, Telegram.
- **Migrate?** Yes — architecturally the **easiest** (code is already separate); it just
  lives in the shared volume instead of its own service. Already has guarded execution
  (matches the safety-rules requirement).
- **Priority:** migrate **last** by risk (real money), even though it's technically ready.
  **Risk:** financial loss, Telegram session revocation, daemon lifecycle.

### 3.4 Scrum DB watch  → target `scrum-service` (NOT in the original plan's list)
- **Lives in:** `scrummaster` workspace, Node scripts (`scrum_db_overview.mjs`,
  `scrum_db_change_check.mjs`, `scrum_db_export.mjs`, `run_scrum_db_watch_daemon.sh`),
  `pg` dependency.
- **External systems:** PostgreSQL (`SCRUM_POSTGRESQL_PUBLIC_URL`), read-only by policy.
- **Secrets:** `SCRUM_POSTGRESQL_PUBLIC_URL`.
- **Trigger:** heartbeat (`scrum_db_change_check.mjs`), watch daemon, Telegram.
- **State:** `exports/`, `logs/`, `memory/heartbeat-state.json`.
- **Migrate?** Yes — **the lowest-risk candidate of all** (pure read-only DB polling,
  self-contained `.mjs`, no browser, no money).
- **Priority:** best **first** migration to validate the MCP pattern.

### 3.5 Scheduling (cross-cutting)  → target `scheduler-service`
- **Currently scattered across:** OpenClaw per-agent heartbeat (`HEARTBEAT.md`), cron
  files (`/data/workspace/cron`, `check_listener_health.cron`), a `systemd` dir, and
  supervised Python daemons. There is **no single scheduler** — this is the real gap.

## 4. Corrections to the proposed plan (based on findings)

1. **Audit must come from the live container, not the repo** — confirmed: repo has none
   of the logic.
2. **Garmin-first is not the clean win the plan assumes** — Garmin is entangled inside
   the food (`healthdiet`) agent. The genuinely lowest-risk first service is
   **scrum-service** (read-only Postgres, self-contained Node scripts).
3. **Trader is already a separate codebase** — its migration is "lift `tg-user-listener`
   out of the shared volume into its own Railway service", not "extract logic from
   prompts". Highest blast radius, so still last by risk.
4. **MCP over HTTP is supported** → drop the plan's custom `service-registry.yaml` + REST
   router; expose each service as an MCP server and let OpenClaw's MCP client + the LLM
   route. Less code than the plan.
5. **`notifier-service` / `memory-service` are unjustified for now** — OpenClaw already
   is the Telegram notifier and already has memory/heartbeat.
6. **Secrets currently sit in `openclaw.json` and the shared volume** — migration should
   relocate them to per-service Railway env vars.

## 5. Revised first-MVP recommendation

1. Stand up **`instance-openclaw-v2`** as a *new* Railway service (new volume, clean
   config, pinned version). Leave `main-clawdbot` untouched as rollback.
2. Externalize **scrum-service** first (lowest risk): standalone repo/dir + Dockerfile,
   deployed as its own Railway service, exposing an **MCP server over HTTP** on Railway
   **private networking** (`*.railway.internal`, not public) + bearer header.
3. Register it in `instance-openclaw-v2` via `openclaw mcp add ... --transport
   streamable-http --url http://scrum-service.railway.internal/... --header
   "Authorization=Bearer …"`. Validate end-to-end against the live scrum DB.
4. Repeat the pattern for **garmin-service** (un-entangle from healthdiet), then
   **food-service** (Playwright isolated), then **finance-service** (trader, with the
   plan's safety rules), then consolidate scheduling into **scheduler-service**.
5. Cut Telegram over to the new instance; decommission `main-clawdbot`.

## 6. Open items to confirm next

- Exact Garmin credential env var names and the Python client used (inside healthdiet
  `.venv`).
- How daemons/cron are actually supervised today (systemd? a wrapper? `/data/workspace/cron`).
- Whether `bybit_execution_guarded.py` already implements dry-run + limits + emergency
  stop, or only "guarded" order placement.
- Re-pin the Dockerfile to the running version (`v2026.6.10`) to stop build/runtime drift.
