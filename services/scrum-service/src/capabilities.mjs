// Business capabilities for scrum-service. These mirror the three original OpenClaw
// workspace scripts (overview / change-check / export) but return structured JSON
// instead of printing, so they can be surfaced as MCP tools.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

import { RELEVANT_TABLE_RE, classifyTable, listBaseTables, quoteIdent, tableSummary, withClient } from "./db.mjs";

const MAX_DETAIL_ROWS = 10;

// Where change-check persists table counts between calls. Defaults to the Railway
// volume; falls back to a local file for local dev. Ephemeral storage just means the
// first call after a restart establishes a baseline (no changes reported) — same as the
// original behaviour when no prior state file existed.
const STATE_PATH = process.env.SCRUM_STATE_PATH || "/data/scrum-service/state.json";

// --- overview -------------------------------------------------------------------------

export async function overview() {
  const summaries = await withClient(async (client) => {
    const tables = await listBaseTables(client);
    const relevant = tables.filter((table) => RELEVANT_TABLE_RE.test(table.table_name));
    const selected = relevant.length ? relevant : tables;
    const results = [];
    for (const table of selected) {
      results.push(await tableSummary(client, table));
    }
    return results;
  });
  return { checkedAt: new Date().toISOString(), tables: summaries };
}

// --- change-check (stateful) ----------------------------------------------------------

async function readState() {
  try {
    return JSON.parse(await readFile(STATE_PATH, "utf8"));
  } catch {
    return { scrumDb: { lastCheckAt: null, tables: {}, notifiedAt: null } };
  }
}

async function writeState(state) {
  await mkdir(path.dirname(STATE_PATH), { recursive: true });
  await writeFile(STATE_PATH, JSON.stringify(state, null, 2) + "\n");
}

function tableKey(summary) {
  return summary.schema + "." + summary.table;
}

function pickColumn(columns, patterns) {
  return columns.find((column) => patterns.some((pattern) => pattern.test(column)));
}

async function latestRows(client, summary, limit) {
  const fq = quoteIdent(summary.schema) + "." + quoteIdent(summary.table);
  const columns = summary.columns;
  const timeColumn = pickColumn(columns, [
    /^(created_at|updated_at|inserted_at|timestamp|ts|date)$/i,
    /(created|updated|time|date|at)$/i,
  ]);
  const idColumn = pickColumn(columns, [/^id$/i, /(^|_)id$/i]);
  const sprintColumn = pickColumn(columns, [/^sprint_id$/i, /^sprint$/i]);
  const categoryColumn = pickColumn(columns, [/^category$/i, /type/i]);
  const textColumn = pickColumn(columns, [/^raw_text$/i, /^text$/i, /feedback/i, /comment/i, /message/i, /content/i]);

  const orderBy = timeColumn ? " order by " + quoteIdent(timeColumn) + " desc" : "";
  const result = await client.query("select * from " + fq + orderBy + " limit $1", [limit]);
  return result.rows.map((row) => ({
    id: idColumn ? row[idColumn] : undefined,
    sprint: sprintColumn ? row[sprintColumn] : undefined,
    category: categoryColumn ? row[categoryColumn] : undefined,
    text: textColumn ? row[textColumn] : undefined,
    createdAt: timeColumn ? row[timeColumn] : undefined,
  }));
}

export async function changeCheck() {
  const state = await readState();
  const previous = state.scrumDb?.tables ?? {};

  const summaries = await withClient(async (client) => {
    const tables = await listBaseTables(client);
    const relevant = tables.filter((table) => RELEVANT_TABLE_RE.test(table.table_name));
    const results = [];
    for (const table of relevant) {
      const summary = await tableSummary(client, table);
      const key = tableKey(summary);
      const prev = previous[key];
      if (summary.kind === "feedback" && prev && summary.count > Number(prev.count || 0)) {
        summary.newRows = await latestRows(client, summary, Math.min(summary.count - Number(prev.count || 0), MAX_DETAIL_ROWS));
      }
      results.push(summary);
    }
    return results;
  });

  const changes = [];
  const nextTables = {};
  for (const summary of summaries) {
    const key = tableKey(summary);
    const prev = previous[key];
    nextTables[key] = { kind: summary.kind, count: summary.count, latest: summary.latest };
    if (prev && summary.count > Number(prev.count || 0)) {
      changes.push({
        table: key,
        kind: summary.kind,
        added: summary.count - Number(prev.count || 0),
        count: summary.count,
        latest: summary.latest,
        rows: summary.newRows,
      });
    }
  }

  const now = new Date().toISOString();
  await writeState({
    ...state,
    scrumDb: {
      lastCheckAt: now,
      tables: nextTables,
      notifiedAt: changes.length ? now : state.scrumDb?.notifiedAt ?? null,
    },
  });

  // `baseline: true` => first run / no prior state, equivalent to the original's HEARTBEAT_OK.
  const baseline = !Object.keys(previous).length;
  return { checkedAt: now, baseline, changes };
}

// --- export ---------------------------------------------------------------------------

const EXPORT_KINDS = ["all", "feedback", "tasks", "sprints", "participants", "risks"];

export async function exportRows({ kind = "all", limit = 50 } = {}) {
  if (!EXPORT_KINDS.includes(kind)) {
    throw new Error("Unsupported kind. Use feedback, tasks, sprints, participants, risks, or all.");
  }
  const cappedLimit = Math.min(Number(limit) || 50, 1000);

  const tablesOut = await withClient(async (client) => {
    const tables = await listBaseTables(client);
    const relevant = tables
      .map((table) => ({ ...table, kind: classifyTable(table.table_name) }))
      .filter((table) => table.kind && (kind === "all" || table.kind === kind));

    const result = {};
    for (const table of relevant) {
      const fq = quoteIdent(table.table_schema) + "." + quoteIdent(table.table_name);
      const columns = await client.query(
        "select column_name from information_schema.columns where table_schema = $1 and table_name = $2 order by ordinal_position",
        [table.table_schema, table.table_name],
      );
      const names = columns.rows.map((row) => row.column_name);
      const timeColumn =
        names.find((name) => /^(created_at|updated_at|inserted_at|timestamp|ts|date)$/i.test(name)) ||
        names.find((name) => /(created|updated|time|date|at)$/i.test(name));
      const orderBy = timeColumn ? " order by " + quoteIdent(timeColumn) + " desc" : "";
      const rows = await client.query("select * from " + fq + orderBy + " limit $1", [cappedLimit]);
      result[table.table_schema + "." + table.table_name] = rows.rows;
    }
    return result;
  });

  return { exportedAt: new Date().toISOString(), kind, limit: cappedLimit, tables: tablesOut };
}
