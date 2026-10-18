import test from "node:test";
import assert from "node:assert/strict";
import { generateWorkforcePlan } from "../src/planner.js";
import { buildProjectReviewContext } from "../src/project-review.js";

const definitions = [
  { id: "steel", name: "钢筋绑扎", division: "主体结构工程", subitem: "钢筋工程", category: "钢筋工", unit: "t", output: 10, crew: { 钢筋工: 4 } },
  { id: "pour", name: "混凝土浇筑", division: "主体结构工程", subitem: "混凝土工程", category: "混凝土工", unit: "m³", output: 100, crew: { 混凝土工: 4 } },
  { id: "embed", name: "机电管线预埋", division: "建筑机电工程", subitem: "预埋管线", category: "电工", unit: "m", output: 100, crew: { 电工: 2 } },
  { id: "install", name: "机电设备安装", division: "建筑机电工程", subitem: "设备安装", category: "安装工", unit: "台", output: 10, crew: { 安装工: 2 } },
].map((definition) => ({ ...definition, mode: "crew_day", status: "confirmed", workContent: definition.name }));
const store = { find: async (id) => definitions.find((definition) => definition.id === id) ?? null };
const project = { name: "多栋酒店施工", context: "结构施工与机电预埋配合，各栋有独立工作面", startDate: "2026-10-01", endDate: "2026-10-20" };

async function reviewed(input, dependencies, overrides = {}) {
  const context = await buildProjectReviewContext(input, store);
  return {
    ...input,
    constructionReview: {
      fingerprint: context.fingerprint,
      summary: "结合本次施工对象和工程量判断技术先后，各独立工作面可穿插",
      reviewedItemIds: context.workItems.map((item) => item.itemId),
      itemDecisions: context.workItems.map((item) => ({ itemId: item.itemId, sequenceStatus: "determined", reason: `本次资料明确${item.divisionRemark || "当前工作面"}的${item.name}施工范围，按已说明技术前置或独立工作面组织` })),
      dependencies,
      parallelGroups: [],
      assumptions: [],
      questions: [],
      ...overrides,
    },
  };
}

function assertDependencies(plan, dependencies) {
  assert.ok(plan.planOptions.length > 0);
  assert.ok(plan.planOptions.every((option) => ["sequential", "single-crew-day-overlap", "multi-crew-day-overlap", "two-shift", "multi-crew-day"].includes(option.id)));
  assert.ok(!plan.planOptions.some((option) => ["balanced", "early-overlap"].includes(option.id)));
  for (const option of plan.planOptions) {
    const byId = new Map(option.workItems.map((item) => [item.itemId, item]));
    for (const edge of dependencies) {
      const before = byId.get(edge.beforeItemId);
      const after = byId.get(edge.afterItemId);
      assert.ok(before.endDay < after.startDay, `${option.name}：${before.name}应在${after.name}之前完成`);
      assert.ok(before.endDate < after.startDate);
      assert.ok(after.dependsOnSequences.includes(before.sequence));
      assert.deepEqual(after.dependencyReasons.find((item) => item.sequence === before.sequence), { sequence: before.sequence, reason: edge.reason });
    }
    for (const item of option.workItems.filter((item) => item.status === "calculated")) {
      assert.ok(item.startDate >= project.startDate);
      assert.ok(item.endDate <= project.endDate);
    }
  }
}

test("GPT任务图跨分部双向配合仍可排程：钢筋→机电预埋→浇筑→设备安装", async () => {
  const input = {
    project,
    workItems: [
      { activityId: "pour", divisionId: "structure", divisionRemark: "酒店A栋", quantity: 200, unit: "m³" },
      { activityId: "install", divisionId: "mep", divisionRemark: "酒店A栋", quantity: 10, unit: "台" },
      { activityId: "steel", divisionId: "structure", divisionRemark: "酒店A栋", quantity: 30, unit: "t" },
      { activityId: "embed", divisionId: "mep", divisionRemark: "酒店A栋", quantity: 100, unit: "m" },
    ],
  };
  const dependencies = [
    { beforeItemId: "item-3", afterItemId: "item-4", reason: "钢筋定位后进行本部位机电预埋" },
    { beforeItemId: "item-4", afterItemId: "item-1", reason: "预埋及隐蔽检查后进行相应混凝土浇筑" },
    { beforeItemId: "item-1", afterItemId: "item-2", reason: "结构完成后方具备本项设备安装条件" },
  ];
  const plan = await generateWorkforcePlan(await reviewed(input, dependencies), store);
  assert.equal(plan.workflow.mode, "gpt");
  assert.equal(plan.project.context, project.context);
  assert.deepEqual(plan.workItems.map((item) => item.itemId), ["item-1", "item-2", "item-3", "item-4"]);
  assert.equal(plan.divisionSchedule.length, 2);
  assertDependencies(plan, dependencies);
});

test("短工期的结构与机电双向配合仅增加班次或班组，不改变SCC内实际技术前置", async () => {
  const input = {
    project: { ...project, endDate: "2026-10-06" },
    workItems: [
      { activityId: "pour", divisionId: "structure", divisionRemark: "酒店A栋", quantity: 400, unit: "m³" },
      { activityId: "install", divisionId: "mep", divisionRemark: "酒店A栋", quantity: 20, unit: "台" },
      { activityId: "steel", divisionId: "structure", divisionRemark: "酒店A栋", quantity: 40, unit: "t" },
      { activityId: "embed", divisionId: "mep", divisionRemark: "酒店A栋", quantity: 200, unit: "m" },
    ],
  };
  const dependencies = [
    { beforeItemId: "item-3", afterItemId: "item-4", reason: "钢筋完成后进行机电预埋" },
    { beforeItemId: "item-4", afterItemId: "item-1", reason: "本部位预埋验收完成后才可浇筑" },
    { beforeItemId: "item-1", afterItemId: "item-2", reason: "结构完成后进行设备安装" },
  ];
  const plan = await generateWorkforcePlan(await reviewed(input, dependencies), store);
  assert.deepEqual(plan.planOptions.map((option) => option.id), ["two-shift", "multi-crew-day"]);
  assert.equal(plan.baselineAssessment.feasible, false);
  assert.equal(plan.baselineAssessment.requiredCalendarDays, 12);
  for (const option of plan.planOptions) {
    assert.equal(option.finishDate, "2026-10-06");
    assert.deepEqual(option.workItems.map((item) => item.dependsOnSequences), [[4], [1], [], [3]]);
  }
  assertDependencies(plan, dependencies);
});

test("分叉任务图中的短预埋和安装不额外增组，双班空置晚班不计人日且保留次日后继", async () => {
  const input = {
    project: { ...project, endDate: "2026-10-03" },
    workItems: [
      { activityId: "pour", divisionId: "structure", divisionRemark: "酒店A栋", quantity: 200, unit: "m³" },
      { activityId: "install", divisionId: "mep", divisionRemark: "酒店A栋", quantity: 10, unit: "台" },
      { activityId: "steel", divisionId: "structure", divisionRemark: "酒店A栋", quantity: 20, unit: "t" },
      { activityId: "embed", divisionId: "mep", divisionRemark: "酒店A栋", quantity: 100, unit: "m" },
    ],
  };
  const dependencies = [
    { beforeItemId: "item-3", afterItemId: "item-4", reason: "钢筋完成后进行预埋" },
    { beforeItemId: "item-4", afterItemId: "item-1", reason: "预埋检查完成后浇筑" },
    { beforeItemId: "item-3", afterItemId: "item-2", reason: "此独立设备只需本部位钢筋工作面交接完成" },
  ];
  const plan = await generateWorkforcePlan(await reviewed(input, dependencies), store);
  assert.equal(plan.baselineAssessment.requiredCalendarDays, 5);
  assert.deepEqual(plan.planOptions.map((option) => option.id), ["two-shift", "multi-crew-day"]);
  const daytime = plan.planOptions.find((option) => option.id === "multi-crew-day");
  assert.deepEqual(daytime.workItems.map((item) => item.crewsPerShift), [2, 1, 2, 1]);
  const twoShift = plan.planOptions.find((option) => option.id === "two-shift");
  assert.deepEqual(twoShift.workItems.map((item) => item.activeShifts), [2, 1, 2, 1]);
  assert.equal(twoShift.summary.totalPersonDays, 20);
  assert.deepEqual(twoShift.workItems.map((item) => item.startDay), [2, 1, 0, 1]);
  for (const option of plan.planOptions) assert.equal(option.finishDate, "2026-10-03");
  assertDependencies(plan, dependencies);
});

test("同名分部通过楼栋备注区分，审查只约束本栋前置，不产生跨栋汇总依赖", async () => {
  const input = {
    project,
    workItems: [
      { activityId: "steel", divisionRemark: " 酒店A栋 ", quantity: 20, unit: "t" },
      { activityId: "pour", divisionRemark: "酒店A栋", quantity: 100, unit: "m³" },
      { activityId: "steel", divisionRemark: "酒店B栋", quantity: 10, unit: "t" },
      { activityId: "pour", divisionRemark: "酒店B栋", quantity: 100, unit: "m³" },
    ],
  };
  const context = await buildProjectReviewContext(input, store);
  assert.notEqual(context.workItems[0].divisionId, context.workItems[2].divisionId);
  const dependencies = [
    { beforeItemId: "item-1", afterItemId: "item-2", reason: "A栋钢筋绑扎完成后进行A栋浇筑" },
    { beforeItemId: "item-3", afterItemId: "item-4", reason: "B栋钢筋绑扎完成后进行B栋浇筑" },
  ];
  const plan = await generateWorkforcePlan(await reviewed(input, dependencies, {
    parallelGroups: [{ itemIds: ["item-1", "item-3"], reason: "两栋楼独立工作面，钢筋作业可各自组织" }],
  }), store);
  assert.deepEqual(plan.divisionSchedule.map((division) => division.divisionRemark), ["酒店A栋", "酒店B栋"]);
  assert.deepEqual(plan.workItems.map((item) => item.hierarchyNumber), ["1.1.1", "1.2.1", "2.1.1", "2.2.1"]);
  assert.deepEqual(plan.workItems[1].dependsOnSequences, [1]);
  assert.deepEqual(plan.workItems[3].dependsOnSequences, [3]);
  assertDependencies(plan, dependencies);
});

test("经确认的独立工作面可用单班组白班搭接完成，但早晚班不放松原分部顺序", async () => {
  const input = {
    project: { ...project, endDate: project.startDate },
    workItems: [
      { activityId: "steel", divisionRemark: "酒店A栋", quantity: 1, unit: "t" },
      { activityId: "steel", divisionRemark: "酒店B栋", quantity: 1, unit: "t" },
    ],
  };
  const approved = await reviewed(input, [], {
    parallelGroups: [{ itemIds: ["item-1", "item-2"], reason: "两栋楼均已具备独立工作面，人员材料可各自组织" }],
  });
  const plan = await generateWorkforcePlan(approved, store);
  assert.equal(plan.baselineAssessment.feasible, false);
  assert.deepEqual(plan.planOptions.map((option) => option.id), ["single-crew-day-overlap"]);
  const overlap = plan.planOptions[0];
  assert.equal(overlap.finishDate, project.startDate);
  assert.ok(overlap.workItems.every((item) => item.startDay === 0 && item.endDay === 0 && item.crewsPerShift === 1 && item.shiftsPerDay === 1));
  assert.equal(overlap.summary.conservativePeakHeadcount, 8);
  assert.ok(plan.unavailableOptions.some((option) => option.id === "two-shift"));
  assert.ok(plan.unavailableOptions.some((option) => option.id === "multi-crew-day"));
});

test("长工期仅输出单班顺序方案，按实际作业天数推进而不制造数月空档", async () => {
  const input = {
    project: { ...project, endDate: "2027-05-31" },
    workItems: [
      { activityId: "steel", divisionRemark: "酒店A栋", quantity: 80, unit: "t" },
      { activityId: "steel", divisionRemark: "酒店B栋", quantity: 80, unit: "t" },
      { activityId: "pour", divisionRemark: "酒店B栋", quantity: 100, unit: "m³" },
    ],
  };
  const dependencies = [{ beforeItemId: "item-2", afterItemId: "item-3", reason: "B栋混凝土须等相应钢筋完成后施工" }];
  const plan = await generateWorkforcePlan(await reviewed(input, dependencies, {
    parallelGroups: [{ itemIds: ["item-1", "item-2"], reason: "两栋钢筋工作面独立具备开工条件，可均衡组织班组" }],
  }), store);
  assert.deepEqual(plan.planOptions.map((option) => option.id), ["sequential"]);
  const sequential = plan.planOptions[0];
  const [firstRoot, secondRoot] = sequential.workItems;
  assert.equal(firstRoot.requiredCrews, 1);
  assert.equal(secondRoot.requiredCrews, 1);
  assert.equal(firstRoot.durationDays, 8);
  assert.equal(secondRoot.startDay, firstRoot.endDay + 1);
  assert.deepEqual(firstRoot.dependsOnSequences, []);
  assert.deepEqual(secondRoot.dependsOnSequences, []);
  for (const option of plan.planOptions) {
    const [, steel, concrete] = option.workItems;
    assert.ok(steel.endDay < concrete.startDay, `${option.name}仍须满足B栋实际钢筋前置`);
    assert.deepEqual(concrete.dependsOnSequences, [2]);
  }
});

test("直接测算传入GPT审查时，显式分部等待条件仍约束新增搭接方案", async () => {
  const input = {
    project: { ...project, endDate: "2026-10-04" },
    workItems: [
      { itemId: "a", activityId: "steel", divisionId: "division-a", divisionRemark: "A区", quantity: 30, unit: "t" },
      { itemId: "b", activityId: "steel", divisionId: "division-b", divisionRemark: "B区", quantity: 30, unit: "t" },
    ],
    divisionConstraints: [{ divisionId: "division-b", afterDivisionId: "division-a" }],
  };
  const plan = await generateWorkforcePlan(await reviewed(input, [], {
    parallelGroups: [{ itemIds: ["a", "b"], reason: "各有独立钢筋工作面及完整人员，但用户另外指定B区等A区完成" }],
  }), store);
  assert.equal(plan.planOptions.some((option) => option.id === "single-crew-day-overlap"), false);
  assert.ok(plan.unavailableOptions.some((option) => option.id === "single-crew-day-overlap" && option.reason));
  for (const option of plan.planOptions) assert.ok(option.workItems[0].endDay < option.workItems[1].startDay);
});

test("工程量或楼栋备注变化后，不能将旧GPT判断用于新的劳动力测算", async () => {
  const input = { project, workItems: [{ activityId: "steel", quantity: 10, unit: "t", divisionRemark: "A栋" }] };
  const approved = await reviewed(input, []);
  for (const workItems of [
    [{ ...input.workItems[0], quantity: 20 }],
    [{ ...input.workItems[0], divisionRemark: "B栋" }],
  ]) {
    await assert.rejects(generateWorkforcePlan({ ...approved, workItems }, store), /施工顺序判断已过期/);
  }
});

test("劳动力计算和审查校验使用同一工效快照，重复读取不会混用新旧工效", async () => {
  const input = { project, workItems: [{ activityId: "steel", quantity: 10, unit: "t", divisionRemark: "A栋" }] };
  const approved = await reviewed(input, []);
  let reads = 0;
  const changingStore = {
    async find(id) {
      reads += 1;
      const original = await store.find(id);
      return { ...original, output: reads === 1 ? original.output : original.output * 10 };
    },
  };
  const plan = await generateWorkforcePlan(approved, changingStore);
  assert.equal(plan.workflow.fingerprint, approved.constructionReview.fingerprint);
  assert.equal(plan.workItems[0].productivity, "10t/班组·8h");
});

test("GPT须审查全部工序，缺工效项保留为缺项，不能被遗漏或冒称前置已完成", async () => {
  const input = {
    project,
    workItems: [
      { activityId: "steel", quantity: 10, unit: "t", divisionRemark: "A栋" },
      { activityId: "unavailable", name: "专项试验", quantity: 1, unit: "项", divisionRemark: "A栋" },
    ],
  };
  const approved = await reviewed(input, [], { questions: ["专项试验缺少工效，需补充后完善工期及劳动力"] });
  const plan = await generateWorkforcePlan(approved, store);
  assert.deepEqual(plan.workflow.reviewedItemIds, ["item-1", "item-2"]);
  assert.equal(plan.missingProductivity[0].itemId, "item-2");
  assert.equal(plan.missingProductivity[0].divisionRemark, "A栋");
  assert.equal(plan.workItems[1].status, "missing_productivity");
  assert.equal(plan.summary.calculatedItems, 1);
  assert.equal(plan.summary.missingItems, 1);
  assert.match(plan.workflow.warnings.join(" "), /专项试验缺少工效/);
  await assert.rejects(generateWorkforcePlan({ ...approved, constructionReview: { ...approved.constructionReview, reviewedItemIds: ["item-1"] } }, store), /未完整覆盖/);
  await assert.rejects(generateWorkforcePlan({ ...approved, constructionReview: {
    ...approved.constructionReview,
    dependencies: [{ beforeItemId: "item-2", afterItemId: "item-1", reason: "专项试验为本次施工必要前置" }],
  } }, store), /必要前置.*缺少可用工效/);
});
