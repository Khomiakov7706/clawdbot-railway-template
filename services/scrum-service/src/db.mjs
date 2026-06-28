// Postgres access layer for the Scrum DB.
// Ported verbatim (logic-preserving) from the original OpenClaw workspace script
// `workspace-scrummaster/scripts/scrum_db_common.mjs` so behaviour is identical.
import pg from "pg";

const { Client } = pg;

export function getConnectionString() {
  const value = process.env.SCRUM_POSTGRESQL_PUBLIC_URL;
  if (!value) {
    throw new Error("SCRUM_POSTGRESQL_PUBLIC_URL is not set");
  }
  return value;
}

export async function withClient(fn) {
  const client = new Client({
    connectionString: getConnectionString(),
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

export async function listBaseTables(client) {
  const sql =
    "select table_schema, table_name from information_schema.tables where table_type = 'BASE TABLE' and table_schema not in ('pg_catalog', 'information_schema') order by table_schema, table_name";
  const result = await client.query(sql);
  return result.rows;
}

export function classifyTable(name) {
  const lower = name.toLowerCase();
  if (lower.includes("feedback")) return "feedback";
  if (lower.includes("task") || lower.includes("ticket") || lower.includes("issue") || lower.includes("backlog")) return "tasks";
  if (lower.includes("sprint")) return "sprints";
  if (lower.includes("member") || lower.includes("participant") || lower.includes("user") || lower.includes("team")) return "participants";
  if (lower.includes("risk") || lower.includes("blocker") || lower.includes("impediment")) return "risks";
  return null;
}

export async function tableSummary(client, table) {
  const fq = quoteIdent(table.table_schema) + "." + quoteIdent(table.table_name);
  const count = await client.query("select count(*)::bigint as count from " + fq);
  const columns = await client.query(
    "select column_name from information_schema.columns where table_schema = $1 and table_name = $2 order by ordinal_position",
    [table.table_schema, table.table_name],
  );
  const names = columns.rows.map((row) => row.column_name);
  const timeColumn =
    names.find((name) => /^(created_at|updated_at|inserted_at|timestamp|ts|date)$/i.test(name)) ||
    names.find((name) => /(created|updated|time|date|at)$/i.test(name));
  let latest = null;
  if (timeColumn) {
    const latestResult = await client.query("select max(" + quoteIdent(timeColumn) + ") as latest from " + fq);
    latest = latestResult.rows[0]?.latest ?? null;
  }
  return {
    schema: table.table_schema,
    table: table.table_name,
    kind: classifyTable(table.table_name),
    count: Number(count.rows[0].count),
    latest,
    columns: names,
  };
}

// Tables considered relevant to scrum tracking (same regex used by the originals).
export const RELEVANT_TABLE_RE = /feedback|task|ticket|issue|sprint|member|participant|team|user|risk|blocker|impediment/i;

export function quoteIdent(value) {
  return '"' + String(value).replaceAll('"', '""') + '"';
}
