import test from "node:test";
import assert from "node:assert/strict";
import { applyProjectReview, buildProjectReviewContext, PROJECT_REVIEW_JSON_SCHEMA, snapshotProductivityStore } from "../src/project-review.js";

const definition = {
  id: "steel", name: "钢筋绑扎", division: "主体结构", subitem: "钢筋工程", category: "钢筋工",
  unit: "t", mode: "crew_day", output: 2, crew: { 钢筋工: 4, 普工: 1 }, status: "confirmed",
  workContent: "钢筋绑扎与安装", notes: "8小时班组工效",
};
const input = {
  project: { name: "酒店", startDate: "2026-10-01", endDate: "2026-12-31", context: "A栋和B栋独立施工" },
  workItems: [
    { itemId: "a", activityId: "steel", divisionId: "division-a", quantity: "10", unit: "t", divisionRemark: " A栋 ", remark: " 基础 " },
    { itemId: "b", activityId: "steel", divisionId: "division-b", quantity: 20, unit: "t", divisionRemark: "B栋" },
  ],
};
const store = { find: async (id) => id === definition.id ? structuredClone(definition) : null };
const prepared = () => [
  { definition: { ...definition }, result: { itemId: "a", sequence: 1, name: "A栋钢筋", status: "calculated", dependsOnSequences: [99] } },
  { definition: { ...definition }, result: { itemId: "b", sequence: 2, name: "B栋钢筋", status: "calculated", dependsOnSequences: [1] } },
  { definition: { ...definition }, result: { itemId: "c", sequence: 3, name: "A栋浇筑", status: "calculated", dependsOnSequences: [] } },
];
const review = (overrides = {}) => ({
  fingerprint: "fingerprint-current", summary: "A栋绑扎后浇筑，B栋独立施工", reviewedItemIds: ["a", "b", "c"],
  itemDecisions: [
    { itemId: "a", sequenceStatus: "determined", reason: "A栋钢筋是本次基础施工的已具备条件的首项工作" },
    { itemId: "b", sequenceStatus: "determined", reason: "B栋钢筋有独立工作面，可与A栋平行组织" },
    { itemId: "c", sequenceStatus: "determined", reason: "A栋浇筑需等待对应钢筋绑扎完成" },
  ],
  dependencies: [{ beforeItemId: "a", afterItemId: "c", reason: "同一基础须完成钢筋绑扎后浇筑" }],
  parallelGroups: [{ itemIds: ["a", "b"], reason: "不同楼栋具备独立工作面" }],
  assumptions: ["各栋材料和工作面独立"], questions: [], ...overrides,
});

test("全项目上下文包含范围备注、工效和项目条件，且不含历史与模型指令数据", async () => {
  const context = await buildProjectReviewContext({ ...input, history: ["private"], constructionReview: review() }, store);
  assert.equal(context.project.context, "A栋和B栋独立施工");
  assert.equal(context.workItems[0].divisionRemark, "A栋");
  assert.equal(context.workItems[0].remark, "基础");
  assert.equal(context.workItems[0].productivity.output, 2);
  assert.equal(context.workItems[0].workContent, "钢筋绑扎与安装");
  assert.equal(context.workItems[0].status, "calculated");
  assert.equal(JSON.stringify(context).includes("private"), false);
  assert.equal(JSON.stringify(context).includes("fingerprint-current"), false);
  assert.match(context.instructions, /已取消.*至少养护两天/);
  assert.match(context.instructions, /管道试验合格后才能包封/);
  assert.deepEqual(PROJECT_REVIEW_JSON_SCHEMA.required, ["fingerprint", "summary", "reviewedItemIds", "itemDecisions", "dependencies", "parallelGroups", "assumptions", "questions"]);
});

test("上下文指纹不受对象属性顺序影响，但数量、工期、备注和工效变化均使审查失效", async () => {
  const original = await buildProjectReviewContext(input, store);
  const reordered = { workItems: input.workItems, project: { context: input.project.context, endDate: input.project.endDate, startDate: input.project.startDate, name: input.project.name } };
  const reorderedStore = { find: async () => ({ ...definition, crew: { 普工: 1, 钢筋工: 4 } }) };
  assert.equal((await buildProjectReviewContext(reordered, reorderedStore)).fingerprint, original.fingerprint);
  assert.equal((await buildProjectReviewContext({ ...input, project: original.project }, store)).fingerprint, original.fingerprint);
  for (const change of [
    { ...input, workItems: [{ ...input.workItems[0], quantity: 11 }, input.workItems[1]] },
    { ...input, project: { ...input.project, endDate: "2027-01-01" } },
    { ...input, workItems: [{ ...input.workItems[0], divisionRemark: "C栋" }, input.workItems[1]] },
    { ...input, project: { ...input.project, context: "共用一个工作面" } },
  ]) assert.notEqual((await buildProjectReviewContext(change, store)).fingerprint, original.fingerprint);
  assert.notEqual((await buildProjectReviewContext(input, { find: async () => ({ ...definition, output: 3 }) })).fingerprint, original.fingerprint);
});

test("未指定 itemId 时生成稳定标识，并报告不可用与单位冲突", async () => {
  const result = await buildProjectReviewContext({ ...input, workItems: [
    { activityId: "missing", name: "待补充试验", quantity: 1, unit: "项" },
    { activityId: "steel", quantity: 1, unit: "m³" },
  ] }, store);
  assert.deepEqual(result.workItems.map(({ itemId }) => itemId), ["item-1", "item-2"]);
  assert.deepEqual(result.workItems.map(({ status }) => status), ["missing_productivity", "unit_mismatch"]);
  await assert.rejects(buildProjectReviewContext({ ...input, workItems: [input.workItems[0], input.workItems[0]] }, store), /itemId 重复/);
});

test("审查图替换旧规则，保留不同楼栋的独立关系并给出每条依赖依据", () => {
  const work = prepared();
  const result = applyProjectReview(work, review(), "fingerprint-current");
  assert.deepEqual(work.map(({ result }) => result.dependsOnSequences), [[], [], [1]]);
  assert.deepEqual(work[2].result.dependencyReasons, [{ sequence: 1, reason: "同一基础须完成钢筋绑扎后浇筑" }]);
  assert.equal(result.mode, "gpt");
  assert.equal(result.itemDecisions.length, 3);
  assert.equal(result.dependencies[0].beforeSequence, 1);
  assert.equal(result.parallelGroups[0].itemIds.includes("b"), true);
  assert.match(result.checks.join(" "), /不同楼栋/);
});

test("不允许复用已过期审查，也不允许遗漏工序或重复审查", () => {
  assert.throws(() => applyProjectReview(prepared(), review(), "other-fingerprint"), /已过期/);
  assert.throws(() => applyProjectReview(prepared(), review({ reviewedItemIds: ["a", "c"] }), "fingerprint-current"), /未完整覆盖/);
  assert.throws(() => applyProjectReview(prepared(), review({ reviewedItemIds: ["a", "a", "b", "c"] }), "fingerprint-current"), /重复/);
  const work = prepared();
  work[1].result.itemId = "a";
  assert.throws(() => applyProjectReview(work, review(), "fingerprint-current"), /itemId 重复/);
});

test("未知、自身、重复、循环依赖均被拒绝，失败时不改动原排程", () => {
  const cases = [
    [[{ beforeItemId: "unknown", afterItemId: "c", reason: "未知" }], /未知工序/],
    [[{ beforeItemId: "a", afterItemId: "a", reason: "自身" }], /依赖自身/],
    [[{ beforeItemId: "a", afterItemId: "c", reason: "一" }, { beforeItemId: "a", afterItemId: "c", reason: "二" }], /依赖重复/],
    [[{ beforeItemId: "a", afterItemId: "c", reason: "一" }, { beforeItemId: "c", afterItemId: "a", reason: "二" }], /形成循环/],
  ];
  for (const [dependencies, error] of cases) {
    const work = prepared();
    const before = structuredClone(work);
    assert.throws(() => applyProjectReview(work, review({ dependencies }), "fingerprint-current"), error);
    assert.deepEqual(work, before);
  }
});

test("平行施工声明不能与直接或间接技术顺序冲突", () => {
  assert.throws(() => applyProjectReview(prepared(), review({ parallelGroups: [{ itemIds: ["a", "c"], reason: "错误平行" }] }), "fingerprint-current"), /依赖冲突/);
  assert.throws(() => applyProjectReview(prepared(), review({
    dependencies: [
      { beforeItemId: "a", afterItemId: "b", reason: "第一步" },
      { beforeItemId: "b", afterItemId: "c", reason: "第二步" },
    ], parallelGroups: [{ itemIds: ["a", "c"], reason: "错误平行" }],
  }), "fingerprint-current"), /间接前后置依赖冲突/);
});

test("必要前置缺少可用工效时不能冒称测算完成，未参与依赖的缺项仍可呈报", () => {
  const work = prepared();
  work[0].definition = null;
  work[0].result.status = "missing_productivity";
  assert.throws(() => applyProjectReview(work, review(), "fingerprint-current"), /必要前置.*缺少可用工效/);
  work[0].definition = definition;
  work[0].result.status = "unit_mismatch";
  assert.throws(() => applyProjectReview(work, review(), "fingerprint-current"), /必要前置.*缺少可用工效/);
  work[1].definition = null;
  work[1].result.status = "missing_productivity";
  work[0].result.status = "calculated";
  assert.equal(applyProjectReview(work, review({ questions: ["请补充B栋工效"] }), "fingerprint-current").warnings[0], "施工顺序待确认：请补充B栋工效");
});

test("审查不能省略数组或依赖依据", () => {
  assert.throws(() => applyProjectReview(prepared(), review({ assumptions: undefined }), "fingerprint-current"), /施工顺序假设必须为数组/);
  assert.throws(() => applyProjectReview(prepared(), review({ dependencies: [{ beforeItemId: "a", afterItemId: "c", reason: " " }] }), "fingerprint-current"), /依赖的依据不能为空/);
});

test("逐项施工判断须覆盖每项且附理由，不能出现未知或重复标识", () => {
  const decisions = review().itemDecisions;
  assert.throws(() => applyProjectReview(prepared(), review({ itemDecisions: undefined }), "fingerprint-current"), /逐项施工顺序判断必须为数组/);
  assert.throws(() => applyProjectReview(prepared(), review({ itemDecisions: decisions.slice(0, 2) }), "fingerprint-current"), /逐项施工顺序判断未完整覆盖/);
  assert.throws(() => applyProjectReview(prepared(), review({ itemDecisions: [...decisions, decisions[0]] }), "fingerprint-current"), /工序标识重复/);
  assert.throws(() => applyProjectReview(prepared(), review({ itemDecisions: [...decisions.slice(0, 2), { ...decisions[2], itemId: "unknown" }] }), "fingerprint-current"), /引用未知工序/);
  assert.throws(() => applyProjectReview(prepared(), review({ itemDecisions: [{ ...decisions[0], reason: " " }, ...decisions.slice(1)] }), "fingerprint-current"), /施工顺序判断依据不能为空/);
  assert.throws(() => applyProjectReview(prepared(), review({ itemDecisions: [{ ...decisions[0], sequenceStatus: "probably" }, ...decisions.slice(1)] }), "fingerprint-current"), /状态须为/);
});

test("关键顺序无法判断时暂停，不以空依赖冒充可平行施工", () => {
  const work = prepared();
  const before = structuredClone(work);
  const itemDecisions = review().itemDecisions.map((decision) => decision.itemId === "c"
    ? { ...decision, sequenceStatus: "needs_information", reason: "需明确浇筑对应的楼层及钢筋施工范围" }
    : decision);
  assert.throws(() => applyProjectReview(work, review({ itemDecisions, dependencies: [], parallelGroups: [] }), "fingerprint-current"), /暂停测算.*对应的楼层.*project.context/);
  assert.deepEqual(work, before);
});

test("同名分部默认标识区分楼栋，显式分部和分项标识须与范围保持一致", async () => {
  const noIds = input.workItems.map(({ divisionId, ...item }) => item);
  const context = await buildProjectReviewContext({ ...input, workItems: noIds }, store);
  assert.notEqual(context.workItems[0].divisionId, context.workItems[1].divisionId);
  await assert.rejects(buildProjectReviewContext({ ...input, workItems: input.workItems.map((item) => ({ ...item, divisionId: "same" })) }, store), /不同施工部位备注/);
  await assert.rejects(buildProjectReviewContext({ ...input, workItems: input.workItems.map((item) => ({ ...item, subitemId: "same" })) }, store), /不同分部或名称/);
  await assert.rejects(buildProjectReviewContext({ ...input, workItems: [
    { itemId: "a", divisionId: "same", division: "结构", quantity: 1, unit: "项" },
    { itemId: "b", divisionId: "same", division: "装饰", quantity: 1, unit: "项" },
  ] }, store), /不同名称/);
});

test("一次审查内相同工效只读取一次，后续库改动不改变当前快照且调用方不能污染快照", async () => {
  let reads = 0;
  const mutable = structuredClone(definition);
  const changingStore = { async find() { reads += 1; return { ...mutable, output: reads }; } };
  const snapshot = snapshotProductivityStore(changingStore);
  assert.equal(snapshotProductivityStore(snapshot), snapshot);
  const [first, second] = await Promise.all([snapshot.find("steel"), snapshot.find("steel")]);
  assert.equal(reads, 1);
  assert.equal(first.output, 1);
  assert.equal(second.output, 1);
  first.crew.钢筋工 = 999;
  mutable.crew.钢筋工 = 888;
  assert.equal((await snapshot.find("steel")).crew.钢筋工, 4);
  const context = await buildProjectReviewContext(input, snapshot);
  assert.equal(reads, 1);
  assert.deepEqual(context.workItems.map((item) => item.productivity.output), [1, 1]);
  const next = await buildProjectReviewContext(input, changingStore);
  assert.equal(reads, 2, "上下文内部也应对重复工效建立单次读取快照");
  assert.notEqual(next.fingerprint, context.fingerprint);
});
