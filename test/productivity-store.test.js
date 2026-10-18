import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ProductivityStore } from "../src/productivity-store.js";
import { hierarchyEntryCount } from "../src/productivity-hierarchy.js";

test("默认库保留46条已确认工效和1条不可用的管底基础占位项", async () => {
  const items = await new ProductivityStore().list();
  assert.equal(items.length, 47);
  assert.equal(hierarchyEntryCount, 47);
  assert.equal(items.every((item) => item.division && item.subitem && item.hierarchyOrder), true);
  assert.equal(new Set(items.map((item) => item.division)).size, 6);
  assert.deepEqual(
    [items.find((item) => item.name === "筏板养护").division, items.find((item) => item.name === "筏板养护").subitem],
    ["地基与基础工程", "基础混凝土工程"],
  );
  assert.deepEqual(
    [items[0].category, items[0].name, items[0].output, items[0].productivityUnit],
    ["防水工", "筏板侧模修补防水", 42.26, "㎡/班组·8h"],
  );
  assert.deepEqual(
    [items.find((item) => item.name === "腻子找平").category,
      items.find((item) => item.name === "腻子找平").name,
      items.find((item) => item.name === "腻子找平").output],
    ["油漆工", "腻子找平", 150],
  );
  assert.equal(items.every((item) => item.mode === "crew_day"), true);
  assert.equal(items.filter((item) => item.status === "confirmed").length, 46);
  assert.equal(items.filter((item) => item.status === "confirmed").every((item) => item.workContent && item.crewText), true);
  const pipeBedding = items.find((item) => item.id === "pending-pipe-bedding");
  assert.deepEqual([pipeBedding.division, pipeBedding.subitem, pipeBedding.name, pipeBedding.status],
    ["室外及附属工程", "管底基础", "管底基础", "unavailable"]);
  assert.equal(pipeBedding.output, null);
  assert.equal(pipeBedding.unit, "");
  assert.deepEqual(pipeBedding.crew, {});
  assert.equal((await new ProductivityStore().find("cross-project-42")).output, 8);
  assert.equal((await new ProductivityStore().find("cross-project-43")).output, 145.5);
  assert.equal((await new ProductivityStore().find("cross-project-17")).crew["外籍技工"], 7);
  assert.equal((await new ProductivityStore().find("cross-project-27")).crew["外籍技工"], 8);
});

test("管底基础补齐前保持不可用，补齐后才能改为可用", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "saudi-pipe-bedding-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const store = new ProductivityStore({
    customPath: path.join(directory, "custom.json"),
    deletedPath: path.join(directory, "deleted.json"),
  });
  const pending = await store.find("pending-pipe-bedding");
  assert.equal(pending.status, "unavailable");
  await assert.rejects(store.upsert({
    id: pending.id, division: pending.division, subitem: pending.subitem,
    name: pending.name, category: "待分类", status: "confirmed", mode: "crew_day",
  }), /缺少工程量单位|请先确认工种类型/);
  const confirmed = await store.upsert({
    id: pending.id, division: pending.division, subitem: pending.subitem,
    name: pending.name, category: "土方\/道路工", status: "confirmed", mode: "crew_day",
    unit: "m³", output: 10, crew: { 杂工: 2 },
  });
  assert.equal(confirmed.status, "confirmed");
  assert.equal(confirmed.output, 10);
  assert.deepEqual(confirmed.crew, { 杂工: 2 });
});

test("默认工效可修改、删除并用相同编码恢复", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "saudi-productivity-"));
  const customPath = path.join(directory, "custom.json");
  const deletedPath = path.join(directory, "deleted.json");
  await Promise.all([
    writeFile(customPath, "[]\n", "utf8"),
    writeFile(deletedPath, "[]\n", "utf8"),
  ]);
  context.after(() => rm(directory, { recursive: true, force: true }));

  const store = new ProductivityStore({ customPath, deletedPath });
  const editedInput = {
    id: "cross-project-12",
    category: "钢筋工",
    name: "钢筋绑扎/安装（修订）",
    unit: "t",
    mode: "crew_day",
    output: 1.2,
    crew: { 中籍: 1, 外籍技工: 4, 杂工: 5 },
    crewText: "中籍1 + 外籍技工4 + 杂工5",
    productivityUnit: "t/班组·8h",
    workContent: "测试修订",
  };
  await store.upsert(editedInput);
  const edited = await store.find("cross-project-12");
  assert.equal(edited.name, "钢筋绑扎/安装（修订）");
  assert.equal(edited.output, 1.2);
  assert.deepEqual([edited.division, edited.subitem], ["主体结构工程", "钢筋工程"]);

  await store.delete("cross-project-12");
  assert.equal(await store.find("cross-project-12"), null);

  await store.upsert({ ...editedInput, name: "钢筋绑扎/安装（恢复）" });
  const restored = await store.find("cross-project-12");
  assert.equal(restored.name, "钢筋绑扎/安装（恢复）");
  assert.deepEqual([restored.division, restored.subitem], ["主体结构工程", "钢筋工程"]);

  const moved = await store.upsert({ ...editedInput, division: "其他工程", subitem: "新分项" });
  assert.deepEqual([moved.division, moved.subitem, moved.hierarchyOrder], ["其他工程", "新分项", undefined]);
});

test("同名工序可分别归入不同分部和分项", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "saudi-hierarchy-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const store = new ProductivityStore({
    customPath: path.join(directory, "custom.json"),
    deletedPath: path.join(directory, "deleted.json"),
  });
  const input = {
    category: "钢筋工",
    name: "钢筋绑扎/安装",
    unit: "t",
    mode: "crew_day",
    output: 1,
    crew: { 中籍: 1 },
  };
  const foundation = await store.upsert({ ...input, division: "地基与基础工程", subitem: "基础钢筋工程" });
  const structure = await store.upsert({ ...input, division: "主体结构工程", subitem: "钢筋工程" });
  assert.notEqual(foundation.id, structure.id);
  assert.deepEqual(
    (await store.list()).filter((item) => item.id === foundation.id || item.id === structure.id)
      .map((item) => [item.division, item.subitem]),
    [["地基与基础工程", "基础钢筋工程"], ["主体结构工程", "钢筋工程"]],
  );
});
