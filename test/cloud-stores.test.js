import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import {
  PostgresHistoryStore, PostgresProductivityStore, PUBLIC_STORE_LIMITS,
  migrateDatabase, seedPublicProductivity,
} from "../src/cloud-stores.js";
import { productivityData } from "../src/productivity-data.js";

// Real PostgreSQL SQL, not an in-memory mock of a store. PGlite has one backend;
// lease that connection for each complete pg-style transaction, exactly as a
// single-connection pg Pool does. This checks concurrent application calls and
// actual unique constraints, not separate PostgreSQL backend lock scheduling.
async function createPool(context) {
  const database = await PGlite.create();
  context.after(() => database.close());
  let pending = Promise.resolve();
  async function lease() {
    const previous = pending;
    let release;
    pending = new Promise((resolve) => { release = resolve; });
    await previous;
    return release;
  }
  async function query(sql, values) {
    if (sql.includes("CREATE TABLE IF NOT EXISTS")) {
      const results = await database.exec(sql);
      return results.at(-1) ?? { rows: [] };
    }
    return database.query(sql, values);
  }
  const pool = {
    async connect() {
      const release = await lease();
      return { query, release };
    },
    async query(sql, values) {
      const release = await lease();
      try { return await query(sql, values); } finally { release(); }
    },
  };
  await migrateDatabase(pool);
  return pool;
}

function plan(name = "人造测试项目") {
  return {
    project: { name, startDate: "2026-10-01", endDate: "2026-11-01" },
    summary: { calculatedItems: 1, totalPersonDays: 20, tradePeak: { 钢筋工: 2 } },
    workItems: [{ name: "人造测试工序", quantity: 10, divisionRemark: "楼 A", remark: "楼 A" }],
  };
}

const metadata = { requestId: "synthetic-request-1", requestInputHash: "synthetic-hash-1" };

test("PostgreSQL history strictly isolates user lists, details, request lookup and deletion", async (context) => {
  const pool = await createPool(context);
  const alice = new PostgresHistoryStore(pool, "synthetic-alice");
  const bob = new PostgresHistoryStore(pool, "synthetic-bob");
  const saved = await alice.addRequest({ ...plan(), userId: "synthetic-bob", owner: "synthetic-bob" }, metadata);
  assert.equal(saved.created, true);
  assert.equal((await alice.list()).length, 1);
  assert.deepEqual(await bob.list(), []);
  assert.equal(await bob.findByRequestId(metadata.requestId), null);
  await assert.rejects(bob.get(saved.record.id), { statusCode: 404 });
  await assert.rejects(bob.delete(saved.record.id), { statusCode: 404 });
  await assert.rejects(bob.get("not-even-a-uuid' OR 1=1 --"), { statusCode: 404 });
  assert.equal((await alice.get(saved.record.id)).plan.project.name, "人造测试项目");
  assert.equal("userId" in saved.record, false, "metadata ownership is never taken from project JSON");
  assert.equal((await alice.list())[0].workItemNames[0], "人造测试工序");
  assert.deepEqual((await alice.list())[0].workItemRemarks, ["楼 A"]);
  assert.equal("requestInputHash" in (await alice.list())[0], false);
  await alice.delete(saved.record.id);
  await assert.rejects(alice.get(saved.record.id), { statusCode: 404 });
  await assert.rejects(alice.delete(saved.record.id), { statusCode: 404 });
});

test("same request ID is per-user; concurrent same-user replay saves once and conflicts on changed hash", async (context) => {
  const pool = await createPool(context);
  const alice = new PostgresHistoryStore(pool, "synthetic-alice");
  const bob = new PostgresHistoryStore(pool, "synthetic-bob");
  const results = await Promise.all(Array.from({ length: 6 }, () => alice.addRequest(plan(), metadata)));
  assert.equal(results.filter((result) => result.created).length, 1);
  assert.equal(new Set(results.map((result) => result.record.id)).size, 1);
  const first = results[0].record;
  const other = await bob.addRequest(plan("乙项目"), metadata);
  assert.notEqual(first.id, other.record.id);
  assert.equal((await alice.list()).length, 1);
  assert.equal((await bob.list()).length, 1);
  const replay = await alice.addRequest(plan("不应覆盖"), metadata);
  assert.equal(replay.created, false);
  assert.equal(replay.record.plan.project.name, "人造测试项目");
  assert.equal(replay.record.plan.requestId, metadata.requestId);
  await assert.rejects(alice.addRequest(plan(), { ...metadata, requestInputHash: "different" }), { statusCode: 409 });
  const usage = await pool.query("SELECT saved_count FROM public_plan_usage WHERE user_id = $1", ["synthetic-alice"]);
  assert.equal(usage.rows[0].saved_count, 1);
  // Verify the database-level composite UNIQUE constraint, not just JS checks.
  await assert.rejects(pool.query(
    "INSERT INTO public_plan_history (id,user_id,request_id,request_input_hash,plan) VALUES ($1,$2,$3,$4,$5::jsonb)",
    [randomUUID(), "synthetic-alice", metadata.requestId, "other", JSON.stringify(plan())],
  ), { code: "23505" });
});

test("daily and storage limits reject without deleting or replacing saved history", async (context) => {
  const pool = await createPool(context);
  const daily = new PostgresHistoryStore(pool, "synthetic-daily", { limits: { savesPerUserPerDay: 1 } });
  const first = await daily.addRequest(plan(), metadata);
  assert.equal((await daily.addRequest(plan(), metadata)).created, false, "replay is free of additional quota");
  await assert.rejects(daily.add(plan()), { statusCode: 429 });
  await daily.delete(first.record.id);
  await assert.rejects(daily.add(plan()), { statusCode: 429 }, "deleting history must not bypass daily protection");

  const personal = new PostgresHistoryStore(pool, "synthetic-personal", { limits: { historyPerUser: 1 } });
  const saved = await personal.add(plan());
  await assert.rejects(personal.add(plan()), { statusCode: 429 });
  assert.equal((await personal.get(saved.id)).id, saved.id);
  const capped = new PostgresHistoryStore(pool, "synthetic-global", { limits: { historyTotal: 1 } });
  await assert.rejects(capped.add(plan()), { statusCode: 429 });
  assert.deepEqual(await capped.list(), []);

  const size = new PostgresHistoryStore(pool, "synthetic-size", { limits: { planBytes: 100 } });
  await assert.rejects(size.add(plan()), { statusCode: 413 });
  assert.deepEqual(await size.list(), []);
  assert.equal(PUBLIC_STORE_LIMITS.planBytes, 1024 * 1024);
  assert.throws(() => new PostgresHistoryStore(pool, ""), { statusCode: 400 });
  assert.throws(() => new PostgresHistoryStore(pool, "synthetic", { limits: { planBytes: Infinity } }), { statusCode: 500 });
  await assert.rejects(personal.addRequest(plan(), { requestId: "missing-hash" }), { statusCode: 400 });
});

test("shared productivity is readable by members but mutable only by a trusted admin", async (context) => {
  const pool = await createPool(context);
  await seedPublicProductivity(pool);
  const member = new PostgresProductivityStore(pool);
  const admin = new PostgresProductivityStore(pool, { isAdmin: true });
  const initial = await member.find(productivityData[0].id);
  assert.ok(initial);
  assert.equal((await member.list()).length, productivityData.length);
  assert.ok((await member.list({ search: initial.name })).some((entry) => entry.id === initial.id));
  await assert.rejects(member.upsert({ ...initial, isAdmin: true }), { statusCode: 403 });
  await assert.rejects(member.delete(initial.id), { statusCode: 403 });
  member.isAdmin = true;
  await assert.rejects(member.upsert(initial), { statusCode: 403 }, "request data and public properties cannot mutate private authorization");
  const falseAdmin = new PostgresProductivityStore(pool, { isAdmin: "true" });
  await assert.rejects(falseAdmin.delete(initial.id), { statusCode: 403 });

  const changed = await admin.upsert({ ...initial, output: 123.45, workContent: "管理员核验后的人工测试内容" });
  assert.equal(changed.output, 123.45);
  await seedPublicProductivity(pool);
  assert.equal((await member.find(initial.id)).output, 123.45, "insert-only seed must preserve admin changes");
  assert.equal((await member.find(initial.id)).workContent, "管理员核验后的人工测试内容");
  await admin.delete(initial.id);
  assert.equal(await member.find(initial.id), null);
  await seedPublicProductivity(pool);
  assert.equal(await member.find(initial.id), null, "seed must not resurrect deleted catalog entries");
  await assert.rejects(admin.delete(initial.id), { statusCode: 404 });
  await admin.upsert(initial);
  assert.ok(await member.find(initial.id), "admin may explicitly restore an entry");
  await assert.rejects(admin.upsert({ id: "invalid", category: "钢筋工", name: "人工测试", mode: "crew_day", unit: "t", output: -1 }), { statusCode: 400 });
  await assert.rejects(admin.upsert({ ...initial, workContent: "x".repeat(40 * 1024) }), { statusCode: 413 });
});

test("database migration and safe default seed can run repeatedly without changes to personal history", async (context) => {
  const pool = await createPool(context);
  const history = new PostgresHistoryStore(pool, "synthetic-migration");
  const saved = await history.add(plan());
  await migrateDatabase(pool);
  await seedPublicProductivity(pool);
  await migrateDatabase(pool);
  await seedPublicProductivity(pool);
  assert.equal((await history.get(saved.id)).plan.project.name, "人造测试项目");
  const count = await pool.query("SELECT count(*)::integer AS count FROM public_productivity");
  assert.equal(count.rows[0].count, productivityData.length);
});
