import assert from "node:assert/strict";
import { test } from "node:test";

import { classifyTable, quoteIdent } from "../src/db.mjs";

test("classifyTable maps names to scrum categories", () => {
  assert.equal(classifyTable("sprint_feedback"), "feedback");
  assert.equal(classifyTable("backlog_tasks"), "tasks");
  assert.equal(classifyTable("ticket"), "tasks");
  assert.equal(classifyTable("sprints"), "sprints");
  assert.equal(classifyTable("team_members"), "participants");
  assert.equal(classifyTable("risks"), "risks");
  assert.equal(classifyTable("blockers"), "risks");
  assert.equal(classifyTable("unrelated_metrics"), null);
});

test("quoteIdent escapes embedded double quotes", () => {
  assert.equal(quoteIdent("plain"), '"plain"');
  assert.equal(quoteIdent('we"ird'), '"we""ird"');
});
