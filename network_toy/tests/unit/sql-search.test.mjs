// Node-native unit tests for app/src/datasource/sql-search.js — the SELECT-only
// guard and the guided-fields → SQL builder.
//
// Pure functions (no sql.js, no DOM); the module's runtime half (setSearchScope
// / runSearch) is browser-only and not exercised here — it's covered by the
// Playwright browser tests against the fallworm fixture.
//
//   node --test tests/unit/sql-search.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  validateSelect, buildGuidedQuery, capQuery, DEFAULT_ROW_CAP,
} from "../../app/src/datasource/sql-search.js";

test("SELECT-only guard accepts SELECT and WITH … SELECT", () => {
  assert.equal(validateSelect("SELECT id, title FROM papers").ok, true);
  assert.equal(validateSelect("  select * from papers where year > 2000").ok, true);
  assert.equal(
    validateSelect("WITH t AS (SELECT id FROM papers) SELECT * FROM t").ok,
    true,
  );
  // Trailing semicolon + comments are tolerated.
  assert.equal(validateSelect("SELECT id FROM papers; -- pick ids").ok, true);
  assert.equal(validateSelect("/* note */ SELECT id FROM papers").ok, true);
});

test("SELECT-only guard rejects DDL/DML", () => {
  for (const bad of [
    "DROP TABLE papers",
    "UPDATE papers SET year = 2000",
    "INSERT INTO papers (id) VALUES (1)",
    "DELETE FROM papers",
    "ATTACH 'x.db' AS x",
    "DETACH x",
    "PRAGMA table_info(papers)",
    "ALTER TABLE papers ADD COLUMN x",
    "CREATE TABLE t (id)",
  ]) {
    assert.equal(validateSelect(bad).ok, false, `should reject: ${bad}`);
  }
});

test("SELECT-only guard rejects empty and multi-statement input", () => {
  assert.equal(validateSelect("").ok, false);
  assert.equal(validateSelect("   ").ok, false);
  // A second statement after the first (the single trailing ; is allowed, but
  // not a ; in the middle).
  assert.equal(validateSelect("SELECT id FROM papers; DROP TABLE papers").ok, false);
  assert.equal(validateSelect("SELECT 1; SELECT 2").ok, false);
});

test("guided-fields builder composes SELECT … FROM papers WHERE …", () => {
  const sql = buildGuidedQuery({
    titleContains: "soil",
    yearFrom: 2015,
    yearTo: 2026,
    venue: "Nature",
    pubType: "article",
  });
  assert.match(sql, /^SELECT [\s\S]*FROM papers p/);
  assert.match(sql, /title LIKE '%soil%'/);
  assert.match(sql, /year >= 2015/);
  assert.match(sql, /year <= 2026/);
  assert.match(sql, /venue LIKE '%Nature%'/);
  assert.match(sql, /pub_type = 'article'/);
  // No min-in-degree → no citations subquery.
  assert.equal(/citations/.test(sql), false);
});

test("guided-fields min in-degree emits the citations COUNT subquery", () => {
  const sql = buildGuidedQuery({ minInDegree: 5 });
  assert.match(sql, /SELECT COUNT\(\*\) FROM citations WHERE cited_id = p\.id\) >= 5/);
});

test("guided-fields builder skips blank fields and has no WHERE when empty", () => {
  const empty = buildGuidedQuery({});
  assert.equal(/WHERE/.test(empty), false);
  const blank = buildGuidedQuery({ titleContains: "   ", yearFrom: "" });
  assert.equal(/WHERE/.test(blank), false);
});

test("guided-fields escapes single quotes to avoid breaking the literal", () => {
  const sql = buildGuidedQuery({ titleContains: "O'Brien" });
  assert.match(sql, /title LIKE '%O''Brien%'/);
});

test("capQuery wraps with a cap+1 LIMIT for capped-detection", () => {
  const wrapped = capQuery("SELECT id FROM papers", 1000);
  assert.match(wrapped, /SELECT \* FROM \(SELECT id FROM papers\) LIMIT 1001/);
  assert.equal(DEFAULT_ROW_CAP, 1000);
});
