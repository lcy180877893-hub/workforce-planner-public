import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const entrypoint = fileURLToPath(new URL("../src/guest-stdio.js", import.meta.url));
const trenchId = "cross-project-41";
const input = {
  project: { name: "本机工效试算", startDate: "2026-11-17", endDate: "2026-11-21", context: "一个工作面，沟槽开挖前置条件均已满足。每天一个8小时白班。" },
  workItems: [{ itemId: "trench", activityId: trenchId, quantity: 200, unit: "m" }],
};

async function call(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  assert.ok(!result.isError, JSON.stringify(result.content));
  return result.structuredContent;
}

async function lookup(client, id) {
  const result = await call(client, "list_productivity", { search: id });
  return result.items.find((entry) => entry.id === id);
}

function reviewed(fingerprint) {
  return { ...input, constructionReview: {
    fingerprint, summary: "单项沟槽开挖采用白班顺序施工。",
    reviewedItemIds: ["trench"], itemDecisions: [{ itemId: "trench", sequenceStatus: "determined", reason: "开工条件已满足。" }],
    dependencies: [], parallelGroups: [], assumptions: [], questions: [],
  } };
}

async function checkPlan(client, output, personDays, finishDate) {
  const prepared = await call(client, "prepare_project_review", input);
  assert.equal(prepared.workItems[0].productivity.output, output);
  const plan = await call(client, "generate_workforce_plan", reviewed(prepared.fingerprint));
  assert.equal(plan.saved, false);
  assert.equal(plan.planOptions[0].summary.conservativePeakHeadcount, 4);
  assert.equal(plan.planOptions[0].summary.totalPersonDays, personDays);
  assert.equal(plan.planOptions[0].finishDate, finishDate);
  return prepared.fingerprint;
}

test("local clients can maintain and reuse only their own on-disk productivity through the installed entry point", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "workforce-local-test-"));
  const clients = new Set();
  t.after(async () => {
    await Promise.all([...clients].map((client) => client.close()));
    await rm(root, { recursive: true, force: true, maxRetries: 5 });
  });
  async function start(directory) {
    const client = new Client({ name: "local-productivity-test", version: "1.0.0" });
    clients.add(client);
    await client.connect(new StdioClientTransport({
      command: process.execPath, args: [entrypoint], cwd: root, stderr: "pipe",
      env: { WORKFORCE_LOCAL_DATA_DIR: join(root, directory) },
    }));
    return client;
  }

  const [alice, coworkerA, bob] = await Promise.all([start("A"), start("A"), start("B")]);
  const { tools } = await alice.listTools();
  assert.deepEqual(tools.map((tool) => tool.name).sort(), [
    "delete_productivity", "generate_workforce_plan", "get_current_profile", "list_productivity",
    "open_workforce_planner", "prepare_project_review", "upsert_productivity",
  ]);
  const profile = await call(alice, "get_current_profile");
  assert.equal(profile.authenticated, false);
  assert.equal(profile.account, null);
  assert.equal(profile.accessMode, "local");
  const original = await lookup(alice, trenchId);
  assert.equal(original.catalogScope, "bundled");
  const originalFingerprint = await checkPlan(alice, 100, 8, "2026-11-18");
  const updated = await call(alice, "upsert_productivity", { id: trenchId, output: 50 });
  assert.equal(updated.saved.name, original.name);
  assert.deepEqual(updated.saved.crew, original.crew);
  assert.equal((await lookup(coworkerA, trenchId)).hasLocalOverride, true);
  const stale = await alice.callTool({ name: "generate_workforce_plan", arguments: reviewed(originalFingerprint) });
  assert.equal(stale.isError, true, "changed productivity requires a new review");
  await checkPlan(coworkerA, 50, 16, "2026-11-20");

  const sample = { id: "local-test-item", name: "试验段开挖", category: "土方工程",
    unit: "m", crew: { 普工: 4 }, mode: "crew_day", output: 25, status: "confirmed" };
  const added = (await call(alice, "upsert_productivity", sample)).saved;
  assert.equal(added.catalogScope, "local");
  assert.equal(added.hasLocalOverride, false);
  await Promise.all([
    call(alice, "upsert_productivity", { id: sample.id, output: 30 }),
    call(coworkerA, "upsert_productivity", { id: sample.id, source: "试验段实测" }),
  ]);
  const concurrent = await lookup(alice, sample.id);
  assert.equal(concurrent.hasLocalOverride, false);
  assert.equal(concurrent.output, 30);
  assert.equal(concurrent.source, "试验段实测");
  const invalid = await alice.callTool({ name: "upsert_productivity", arguments: { id: sample.id, crew: {} } });
  assert.equal(invalid.isError, true);
  assert.deepEqual((await lookup(alice, sample.id)).crew, sample.crew);
  assert.equal(await lookup(bob, sample.id), undefined);
  await checkPlan(bob, 100, 8, "2026-11-18");

  await Promise.all([alice.close(), coworkerA.close()]);
  clients.delete(alice);
  clients.delete(coworkerA);
  const restarted = await start("A");
  assert.equal((await lookup(restarted, sample.id)).output, 30);
  await checkPlan(restarted, 50, 16, "2026-11-20");
  await call(restarted, "delete_productivity", { id: sample.id });
  await call(restarted, "delete_productivity", { id: trenchId });
  await restarted.close();
  clients.delete(restarted);
  const reopened = await start("A");
  assert.equal(await lookup(reopened, sample.id), undefined);
  assert.equal(await lookup(reopened, trenchId), undefined);
  assert.equal((await lookup(bob, trenchId)).output, 100);
  const afterDelete = await call(reopened, "prepare_project_review", input);
  assert.equal(afterDelete.workItems[0].status, "missing_productivity");
  assert.equal(afterDelete.workItems[0].productivity, null);
});
