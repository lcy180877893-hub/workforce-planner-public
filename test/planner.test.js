import test from "node:test";
import assert from "node:assert/strict";
import { calculateCalendar, generateWorkforcePlan } from "../src/planner.js";
import { productivityData } from "../src/productivity-data.js";

class MemoryStore {
  constructor(items) {
    this.items = items;
  }

  async find(id) {
    return this.items.find((item) => item.id === id) ?? null;
  }
}

const store = new MemoryStore([
  {
    id: "role-sample",
    name: "人员工效样例",
    category: "测试",
    unit: "t",
    mode: "role_productivity",
    roleProductivity: { 钢筋工: 0.5, 普工: 1 },
    equipment: [],
    source: "测试",
    status: "confirmed",
  },
  {
    id: "sample",
    name: "样例工序",
    category: "测试",
    unit: "m²",
    mode: "crew_day",
    output: 100,
    crew: { 技工: 2, 普工: 3 },
    equipment: [],
    source: "测试",
    status: "confirmed",
  },
  {
    id: "pump-70",
    name: "70方泵",
    category: "降排水",
    unit: "m³",
    mode: "equipment_hour",
    output: 25,
    crew: {},
    equipment: ["70m³/h名义泵"],
    source: "用户确认",
    status: "confirmed",
  },
  {
    id: "pump-140",
    name: "140方泵",
    category: "降排水",
    unit: "m³",
    mode: "equipment_hour",
    output: 80,
    crew: {},
    equipment: ["140m³/h名义泵"],
    source: "用户确认",
    status: "confirmed",
  },
  {
    id: "raft-rebar", name: "钢筋绑扎/安装", category: "钢筋工", unit: "t",
    mode: "crew_day", output: 1, crew: { 钢筋工: 4 }, status: "confirmed",
  },
  {
    id: "raft-pour", name: "筏板混凝土浇筑", category: "混凝土工", unit: "m³",
    mode: "crew_day", output: 100, crew: { 混凝土工: 4 }, status: "confirmed",
  },
  {
    id: "raft-cure", name: "筏板养护", category: "混凝土工", unit: "㎡",
    mode: "crew_day", output: 100, crew: { 杂工: 1 }, status: "confirmed",
  },
  {
    id: "plain-pour", name: "基础垫层浇筑", category: "混凝土工", unit: "m³",
    mode: "crew_day", output: 100, crew: { 混凝土工: 2 }, status: "confirmed",
  },
  {
    id: "plain-cure", name: "基础垫层养护", category: "混凝土工", unit: "㎡",
    mode: "crew_day", output: 100, crew: { 杂工: 1 }, status: "confirmed",
  },
  {
    id: "composite", name: "管道包封", category: "管道工", unit: "m",
    mode: "crew_day", output: 100, crew: { 管道工: 2 }, status: "confirmed",
    workContent: "钢筋绑扎、模板安装、混凝土浇筑、拆模及混凝土养护。",
  },
  {
    id: "prefab-pour", name: "预制构件混凝土浇筑", category: "混凝土工", unit: "m³",
    mode: "crew_day", output: 100, crew: { 混凝土工: 2 }, status: "confirmed",
  },
]);

test("六月至九月自动识别为夏季，其余月份为冬季", () => {
  const calendar = calculateCalendar({
    startDate: "2026-05-31",
    endDate: "2026-10-01",
  });
  assert.deepEqual(calendar.periodDays, { winter: 2, summer: 122, ramadan: 0 });
  assert.equal(calendar.effectiveDays, 87.4);
});

test("斋月优先覆盖冬夏季，不叠加工效系数", () => {
  const calendar = calculateCalendar({
    startDate: "2026-02-18",
    endDate: "2026-03-19",
  });
  assert.deepEqual(calendar.periodDays, { winter: 0, summer: 0, ramadan: 30 });
  assert.equal(calendar.effectiveDays, 15);
  assert.equal(calendar.weightedFactor, 0.5);
});

test("可调整每年冬夏季日期和各自工效比例", () => {
  const calendar = calculateCalendar({
    startDate: "2026-04-29",
    endDate: "2026-05-02",
    calendarRules: {
      winter: { start: "10-01", end: "04-30", factor: 0.9 },
      summer: { start: "05-01", end: "09-30", factor: 0.6 },
    },
  });
  assert.deepEqual(calendar.periodDays, { winter: 2, summer: 2, ramadan: 0 });
  assert.equal(calendar.effectiveDays, 3);
  assert.equal(calendar.calendarRules.source, "custom");
});

test("手动斋月日期可多段录入并优先覆盖季节", () => {
  const calendar = calculateCalendar({
    startDate: "2026-06-01",
    endDate: "2026-06-10",
    calendarRules: {
      summer: { factor: 0.8 },
      ramadan: {
        mode: "custom",
        ranges: [
          { startDate: "2026-06-02", endDate: "2026-06-03" },
          { startDate: "2026-06-07", endDate: "2026-06-08" },
        ],
        factor: 0.4,
      },
    },
  });
  assert.deepEqual(calendar.periodDays, { winter: 0, summer: 6, ramadan: 4 });
  assert.equal(calendar.effectiveDays, 6.4);
  assert.match(calendar.seasonRule, /2026-06-02至2026-06-03/);
});

test("自定义冬夏季须覆盖全年，斋月日期与比例须有效", () => {
  const project = { startDate: "2026-06-01", endDate: "2026-06-10" };
  assert.throws(() => calculateCalendar({
    ...project,
    calendarRules: { winter: { end: "06-10" } },
  }), /互不重叠/);
  assert.throws(() => calculateCalendar({
    ...project,
    calendarRules: { summer: { factor: 0 } },
  }), /工效比例/);
  assert.throws(() => calculateCalendar({
    ...project,
    calendarRules: { ramadan: { mode: "custom", ranges: [] } },
  }), /斋月起止日期/);
  assert.throws(() => calculateCalendar({
    ...project,
    calendarRules: { ramadan: { mode: "custom", ranges: [{ startDate: "2026-06-10", endDate: "2026-06-01" }] } },
  }), /不能早于/);
});

test("完工日期不能早于开工日期", () => {
  assert.throws(
    () => calculateCalendar({ startDate: "2026-10-02", endDate: "2026-10-01" }),
    /不能早于开工日期/,
  );
});

test("夏季工效按70%排程并以完整班次统计人日", async () => {
  const plan = await generateWorkforcePlan(
    {
      project: { startDate: "2026-06-01", endDate: "2026-06-10" },
      workItems: [{ activityId: "sample", quantity: 1000, unit: "m²" }],
    },
    store,
  );
  const daytime = plan.planOptions.find((option) => option.id === "multi-crew-day");
  assert.equal(daytime.workItems[0].requiredCrews, 2);
  assert.deepEqual(daytime.workItems[0].peakCrew, { 技工: 4, 普工: 6 });
  assert.equal(daytime.summary.totalPersonDays, 80);
  assert.equal(daytime.workItems[0].endDate, "2026-06-08");
});

test("自定义工效比例影响班组测算并留存规则", async () => {
  const plan = await generateWorkforcePlan(
    {
      project: {
        startDate: "2026-10-01",
        endDate: "2026-10-10",
        calendarRules: { winter: { factor: 0.5 } },
      },
      workItems: [{ activityId: "sample", quantity: 1000, unit: "m²" }],
    },
    store,
  );
  const daytime = plan.planOptions.find((option) => option.id === "multi-crew-day");
  assert.equal(daytime.workItems[0].requiredCrews, 2);
  assert.deepEqual(daytime.workItems[0].peakCrew, { 技工: 4, 普工: 6 });
  assert.equal(plan.project.calendarRules.winter.factor, 0.5);
  assert.match(plan.project.seasonRule, /冬季每年10-01至05-31（50%）/);
});

test("人员工效按各工种分别反算人数和人日", async () => {
  const plan = await generateWorkforcePlan(
    {
      project: { startDate: "2026-10-01", endDate: "2026-10-10" },
      workItems: [{ activityId: "role-sample", quantity: 10, unit: "t" }],
    },
    store,
  );
  const daytime = plan.planOptions.find((option) => option.id === "multi-crew-day");
  assert.deepEqual(daytime.workItems[0].peakCrew, { 钢筋工: 2, 普工: 1 });
  assert.deepEqual(daytime.workItems[0].personDaysByTrade, { 钢筋工: 20, 普工: 10 });
  assert.equal(daytime.summary.totalPersonDays, 30);
  assert.match(daytime.workItems[0].productivity, /钢筋工 0.5t\/人日/);
});

test("未知工效明确列入待补充且不计入合计", async () => {
  const plan = await generateWorkforcePlan(
    {
      project: { startDate: "2026-10-01", endDate: "2026-10-20" },
      workItems: [{ name: "未知工序", quantity: 50, unit: "项" }],
    },
    store,
  );
  assert.equal(plan.summary.missingItems, 1);
  assert.equal(plan.summary.totalPersonDays, 0);
  assert.equal(plan.workItems[0].status, "missing_productivity");
});

test("不可用的管底基础不参与劳动力及工期测算", async () => {
  const plan = await generateWorkforcePlan({
    project: { startDate: "2026-10-01", endDate: "2026-10-10" },
    workItems: [
      { activityId: "pending-pipe-bedding", quantity: 100 },
      { activityId: "cross-project-15", quantity: 100, unit: "m" },
    ],
  }, new MemoryStore(productivityData));
  assert.equal(plan.workItems[0].status, "missing_productivity");
  assert.match(plan.workItems[0].reason, /不可用/);
  assert.equal(plan.workItems[0].startDate, undefined);
  assert.equal(plan.workItems[1].status, "calculated");
  assert.equal(plan.summary.missingItems, 1);
});

test("工序按录入顺序编号，备注在各测算分支中保留", async () => {
  const plan = await generateWorkforcePlan(
    {
      project: { startDate: "2026-10-01", endDate: "2026-10-10" },
      workItems: [
        { activityId: "sample", quantity: 100, unit: "m²", remark: " 先做样板段 " },
        { name: "待补充工序", quantity: 1, unit: "项", remark: "现场确认" },
        { activityId: "pump-70", quantity: 250, unit: "m³", remark: "提前进场" },
        { activityId: "role-sample", quantity: 1, unit: "t", remark: "夜班" },
        { activityId: "sample", quantity: 100, unit: "m³", remark: "复核单位" },
      ],
    },
    store,
  );
  assert.deepEqual(plan.workItems.map(({ sequence, remark }) => [sequence, remark]), [
    [1, "先做样板段"],
    [2, "现场确认"],
    [3, "提前进场"],
    [4, "夜班"],
    [5, "复核单位"],
  ]);
  assert.deepEqual(plan.workItems.map(({ status }) => status), [
    "calculated", "missing_productivity", "calculated", "calculated", "unit_mismatch",
  ]);
});

test("多种降排水泵合计只配置1名电工", async () => {
  const plan = await generateWorkforcePlan(
    {
      project: { startDate: "2026-10-01", endDate: "2026-10-10" },
      workItems: [
        { activityId: "pump-70", quantity: 2500, unit: "m³" },
        { activityId: "pump-140", quantity: 8000, unit: "m³" },
      ],
    },
    store,
  );
  assert.equal(plan.summary.tradePeak["电工"], 1);
  assert.equal(plan.summary.tradePersonDays["电工"], 10);
  assert.ok(plan.summary.equipmentPeak["70m³/h名义泵"] >= 1);
  assert.ok(plan.summary.equipmentPeak["140m³/h名义泵"] >= 1);
});

test("单班顺序工期不足时仅给出早晚班与多班组白班及施工横道图", async () => {
  const plan = await generateWorkforcePlan(
    {
      project: { startDate: "2026-10-01", endDate: "2026-10-10" },
      workItems: [1, 2, 3].map((number) => ({
        itemId: `item-${number}`, division: `第${number}分部`, subitem: "示例分项", activityId: "sample", quantity: 500, unit: "m²", remark: `第${number}段`,
      })),
    },
    store,
  );
  assert.deepEqual(plan.planOptions.map(({ id }) => id), ["two-shift", "multi-crew-day"]);
  assert.equal(plan.baselineAssessment.feasible, false);
  assert.equal(plan.baselineAssessment.requiredCalendarDays, 15);
  assert.equal(plan.baselineAssessment.availableCalendarDays, 10);
  assert.equal(plan.baselineAssessment.overrunDays, 5);
  for (const option of plan.planOptions) {
    assert.equal(option.feasible, true);
    assert.ok(option.finishDate <= plan.project.endDate);
    const finishOffset = (Date.parse(option.finishDate) - Date.parse(plan.project.startDate)) / 86400000;
    assert.equal(option.slackDays, plan.project.durationDays - finishOffset - 1);
    assert.deepEqual(option.workItems.map(({ sequence }) => sequence), [1, 2, 3]);
    for (const item of option.workItems) {
      assert.ok(item.startDate <= item.endDate);
      assert.ok(item.endDate <= plan.project.endDate);
      assert.ok(item.requiredCrews >= 1);
      assert.ok(!("availableDays" in item));
    }
    assert.ok(option.workItems[0].endDay < option.workItems[1].startDay);
    assert.ok(option.workItems[1].endDay < option.workItems[2].startDay);
  }
  assert.deepEqual(plan.summary, plan.planOptions.find((option) => option.id === plan.selectedOptionId).summary);
});

test("同一分部工序可同日开工，三个顺序分部无法压入两天", async () => {
  const concurrent = await generateWorkforcePlan({
    project: { startDate: "2026-10-01", endDate: "2026-10-02" },
    workItems: [1, 2, 3].map(() => ({ division: "同一分部", activityId: "sample", quantity: 1, unit: "m²" })),
  }, store);
  assert.deepEqual(concurrent.workItems.map((item) => item.startDay), [0, 0, 0]);
  await assert.rejects(
    generateWorkforcePlan(
      {
        project: { startDate: "2026-10-01", endDate: "2026-10-02" },
        workItems: [1, 2, 3].map((number) => ({ division: `第${number}分部`, activityId: "sample", quantity: 1, unit: "m²" })),
      },
      store,
    ),
    /无法.*(?:满足|完成)|(?:满足|完成).*无法/,
  );
});

test("工效单位不一致时停止计算", async () => {
  const plan = await generateWorkforcePlan(
    {
      project: { startDate: "2026-10-01", endDate: "2026-10-10" },
      workItems: [{ activityId: "sample", quantity: 100, unit: "m³" }],
    },
    store,
  );
  assert.equal(plan.workItems[0].status, "unit_mismatch");
  assert.match(plan.workItems[0].reason, /单位不一致/);
});

test("钢筋完成后才浇筑，浇筑完成后才养护且不附加固定天数", async () => {
  const plan = await generateWorkforcePlan({
    project: { startDate: "2026-10-01", endDate: "2026-10-08" },
    workItems: [
      { activityId: "raft-rebar", quantity: 1, unit: "t" },
      { activityId: "raft-pour", quantity: 100, unit: "m³" },
      { activityId: "raft-cure", quantity: 100, unit: "㎡" },
    ],
  }, store);
  assert.equal("minimumCuringCalendarDays" in plan.workflow, false);
  assert.equal("minimumCuringCalendarDays" in plan.calculationAssumptions, false);
  for (const option of plan.planOptions) {
    const [rebar, pour, cure] = option.workItems;
    assert.ok(rebar.endDay < pour.startDay);
    assert.ok(pour.endDay < cure.startDay);
    assert.equal(cure.durationDays, 1);
    assert.equal(cure.personDaysByTrade["杂工"], 1);
    assert.deepEqual(pour.dependsOnSequences, [1]);
    assert.deepEqual(cure.dependsOnSequences, [2]);
  }
  assert.match(plan.workflow.checks.join(" "), /钢筋绑扎完成后/);
});

test("夏季养护仍只按工程量与工效计算，不强制两天", async () => {
  const plan = await generateWorkforcePlan({
    project: { startDate: "2026-06-01", endDate: "2026-06-08" },
    workItems: [
      { activityId: "plain-pour", quantity: 1, unit: "m³" },
      { activityId: "plain-cure", quantity: 1, unit: "㎡" },
    ],
  }, store);
  assert.ok(plan.planOptions.every((option) => option.workItems[1].durationDays === 1));
});

test("工期足够时仅保留顺序方案，下一分部等待前一分部养护完成", async () => {
  const plan = await generateWorkforcePlan({
    project: { startDate: "2026-10-01", endDate: "2026-10-08" },
    workItems: [
      { division: "主体结构", activityId: "plain-pour", quantity: 1, unit: "m³" },
      { division: "主体结构", activityId: "plain-cure", quantity: 300, unit: "㎡" },
      { division: "场外工程", activityId: "sample", quantity: 1, unit: "m²", remark: "独立的场外预制工作" },
    ],
  }, store);
  const sequential = plan.planOptions.find((option) => option.id === "sequential");
  assert.deepEqual(plan.planOptions.map((option) => option.id), ["sequential"]);
  assert.ok(sequential.workItems[1].endDay < sequential.workItems[2].startDay);
});

test("三级序号与分部级限制：整个后续分部等待目标分部全部完成", async () => {
  const plan = await generateWorkforcePlan({
    project: { startDate: "2026-10-01", endDate: "2026-10-15" },
    workItems: [
      { division: "主体结构", subitem: "钢筋工程", activityId: "sample", quantity: 300, unit: "m²" },
      { division: "主体结构", subitem: "混凝土工程", activityId: "sample", quantity: 100, unit: "m²" },
      { division: "室外工程", subitem: "管网", activityId: "sample", quantity: 100, unit: "m²" },
      { division: "室外工程", subitem: "管网", activityId: "sample", quantity: 100, unit: "m²" },
    ],
    divisionConstraints: [{ division: "室外工程", afterDivision: "主体结构", waitForCompletion: true }],
  }, store);
  assert.deepEqual(plan.workItems.map((item) => item.hierarchyNumber), ["1.1.1", "1.2.1", "2.1.1", "2.1.2"]);
  for (const option of plan.planOptions) {
    assert.ok(option.workItems[2].startDay > Math.max(option.workItems[0].endDay, option.workItems[1].endDay));
    assert.ok(option.workItems[3].startDay > Math.max(option.workItems[0].endDay, option.workItems[1].endDay));
    assert.equal(option.divisionSchedule[1].afterDivision, "1 · 主体结构");
  }
});

test("同名分部按独立序号排程，并区分等待整个分部、分项和具体工序", async () => {
  const base = {
    project: { startDate: "2026-10-01", endDate: "2026-10-20" },
    workItems: [
      { itemId: "long", divisionId: "d-a", division: "主体结构", subitemId: "s-long", subitem: "模板工程", activityId: "sample", quantity: 1000, unit: "m²" },
      { itemId: "short", divisionId: "d-a", division: "主体结构", subitemId: "s-short", subitem: "钢筋工程", activityId: "sample", quantity: 100, unit: "m²" },
      { itemId: "next", divisionId: "d-b", division: "主体结构", subitemId: "s-next", subitem: "钢筋工程", activityId: "sample", quantity: 100, unit: "m²" },
    ],
  };
  const calculate = (target) => generateWorkforcePlan({
    ...base,
    divisionConstraints: [{ divisionId: "d-b", afterDivisionId: "d-a", ...target }],
  }, store);
  const whole = await calculate({});
  const subitem = await calculate({ afterSubitemId: "s-short" });
  const work = await calculate({ afterSubitemId: "s-short", afterItemId: "short" });
  assert.deepEqual(whole.workItems.map((item) => item.hierarchyNumber), ["1.1.1", "1.2.1", "2.1.1"]);
  assert.deepEqual(whole.divisionSchedule.map((group) => group.division), ["主体结构", "主体结构"]);
  const selected = (plan) => plan.planOptions.find((option) => option.id === "sequential").workItems;
  assert.ok(selected(whole)[2].startDay > selected(whole)[0].endDay);
  assert.ok(selected(subitem)[2].startDay > selected(subitem)[1].endDay);
  assert.equal(selected(subitem)[2].startDay, selected(whole)[2].startDay);
  assert.equal(selected(work)[2].startDay, selected(subitem)[2].startDay);
  assert.equal(work.divisionSchedule[1].afterDivision, "1.2.1 · 样例工序");
});

test("限制目标的分项与工序必须属于所选分部", async () => {
  const base = {
    project: { startDate: "2026-10-01", endDate: "2026-10-10" },
    workItems: [
      { itemId: "a", divisionId: "a", division: "甲", subitemId: "a-1", subitem: "分项", activityId: "sample", quantity: 100, unit: "m²" },
      { itemId: "b", divisionId: "b", division: "乙", subitemId: "b-1", subitem: "分项", activityId: "sample", quantity: 100, unit: "m²" },
    ],
  };
  await assert.rejects(generateWorkforcePlan({ ...base, divisionConstraints: [
    { divisionId: "b", afterDivisionId: "a", afterSubitemId: "b-1" },
  ] }, store), /所选分项不属于目标分部/);
  await assert.rejects(generateWorkforcePlan({ ...base, divisionConstraints: [
    { divisionId: "b", afterDivisionId: "a", afterSubitemId: "a-1", afterItemId: "b" },
  ] }, store), /所选工序不属于目标分项/);
});

test("限制目标含待补充工效时不冒称目标已完成", async () => {
  await assert.rejects(generateWorkforcePlan({
    project: { startDate: "2026-10-01", endDate: "2026-10-10" },
    workItems: [
      { itemId: "missing", divisionId: "a", division: "甲", subitemId: "a-1", subitem: "分项", name: "待补充", quantity: 1, unit: "项" },
      { itemId: "b", divisionId: "b", division: "乙", subitemId: "b-1", subitem: "分项", activityId: "sample", quantity: 1, unit: "m²" },
    ],
    divisionConstraints: [{ divisionId: "b", afterDivisionId: "a" }],
  }, store), /限制目标.*缺少可用工效/);
});

test("后录入的分部若是技术前置，结果调整分部实际顺序", async () => {
  const plan = await generateWorkforcePlan({
    project: { startDate: "2026-10-01", endDate: "2026-10-08" },
    workItems: [
      { division: "浇筑分部", activityId: "raft-pour", quantity: 1, unit: "m³" },
      { division: "钢筋分部", activityId: "raft-rebar", quantity: 1, unit: "t" },
    ],
  }, store);
  assert.deepEqual(plan.divisionSchedule.map((group) => group.division), ["钢筋分部", "浇筑分部"]);
  assert.ok(plan.workItems[1].endDay < plan.workItems[0].startDay);
});

test("两个分部各有钢筋和浇筑时，不因全项目汇总前置制造分部循环", async () => {
  const plan = await generateWorkforcePlan({
    project: { startDate: "2026-10-01", endDate: "2026-10-15" },
    workItems: [
      { division: "甲", activityId: "raft-rebar", quantity: 1, unit: "t" },
      { division: "甲", activityId: "raft-pour", quantity: 1, unit: "m³" },
      { division: "乙", activityId: "raft-rebar", quantity: 1, unit: "t" },
      { division: "乙", activityId: "raft-pour", quantity: 1, unit: "m³" },
    ],
  }, store);
  assert.deepEqual(plan.workItems[1].dependsOnSequences, [1]);
  assert.deepEqual(plan.workItems[3].dependsOnSequences, [3]);
  assert.ok(plan.planOptions.length > 0);
});

test("分部等待环路和无效目标明确拒绝", async () => {
  const base = {
    project: { startDate: "2026-10-01", endDate: "2026-10-08" },
    workItems: [
      { division: "甲", activityId: "sample", quantity: 1, unit: "m²" },
      { division: "乙", activityId: "sample", quantity: 1, unit: "m²" },
    ],
  };
  await assert.rejects(generateWorkforcePlan({ ...base, divisionConstraints: [
    { division: "甲", afterDivision: "乙", waitForCompletion: true },
    { division: "乙", afterDivision: "甲", waitForCompletion: true },
  ] }, store), /形成循环/);
  await assert.rejects(generateWorkforcePlan({ ...base, divisionConstraints: [
    { division: "甲", afterDivision: "丙", waitForCompletion: true },
  ] }, store), /分部限制无效/);
});

test("取消固定养护两天后，三天工期可完成单日浇筑与单日养护", async () => {
  const plan = await generateWorkforcePlan({
    project: { startDate: "2026-10-01", endDate: "2026-10-03" },
    workItems: [
      { activityId: "plain-pour", quantity: 1, unit: "m³" },
      { activityId: "plain-cure", quantity: 1, unit: "㎡" },
      { activityId: "sample", quantity: 1, unit: "m²", remark: "独立作业" },
    ],
  }, store);
  assert.deepEqual(plan.planOptions.map((option) => option.id), ["sequential"]);
  assert.ok(plan.planOptions.every((option) => option.workItems[1].durationDays === 1));
});

test("多个浇筑和养护行保守排序，并提示无法按部位配对", async () => {
  const plan = await generateWorkforcePlan({
    project: { startDate: "2026-10-01", endDate: "2026-10-10" },
    workItems: [
      { activityId: "plain-pour", quantity: 1, unit: "m³" },
      { activityId: "plain-cure", quantity: 1, unit: "㎡" },
      { activityId: "plain-pour", quantity: 1, unit: "m³" },
      { activityId: "plain-cure", quantity: 1, unit: "㎡" },
    ],
  }, store);
  assert.ok(plan.workItems[1].startDay > plan.workItems[2].endDay);
  assert.ok(plan.workItems[3].startDay > plan.workItems[2].endDay);
  assert.match(plan.warnings.join(" "), /多项浇筑或养护/);
  assert.ok(plan.workItems.every((item) => !("building" in item) && !("part" in item)));
});

test("未录入养护时仍允许工程量测算，但明确标示缺项", async () => {
  const plan = await generateWorkforcePlan({
    project: { startDate: "2026-10-01", endDate: "2026-10-08" },
    workItems: [{ activityId: "plain-pour", quantity: 10, unit: "m³" }],
  }, store);
  assert.match(plan.warnings.join(" "), /不含养护劳动力与时间/);
});

test("即使倒序输入浇筑、养护、钢筋，也在结果中按技术顺序排程", async () => {
  const plan = await generateWorkforcePlan({
    project: { startDate: "2026-10-01", endDate: "2026-10-08" },
    workItems: [
      { activityId: "raft-pour", quantity: 10, unit: "m³" },
      { activityId: "raft-cure", quantity: 10, unit: "㎡" },
      { activityId: "raft-rebar", quantity: 1, unit: "t" },
    ],
  }, store);
  for (const option of plan.planOptions) {
    const [pour, cure, rebar] = option.workItems;
    assert.ok(rebar.endDay < pour.startDay);
    assert.ok(pour.endDay < cure.startDay);
    assert.deepEqual(pour.dependsOnSequences, [3]);
    assert.deepEqual(cure.dependsOnSequences, [1]);
  }
  assert.match(plan.warnings.join(" "), /录入顺序不作为技术前后置校验/);
});

test("最近一次测算规模下，所有资源方案均须等待钢筋完成后才浇筑", async () => {
  const byName = (name) => productivityData.find((item) => item.name === name);
  const rebar = byName("钢筋绑扎/安装");
  const pour = byName("楼板/屋面混凝土浇筑");
  const cure = byName("楼板养护");
  const plan = await generateWorkforcePlan({
    project: { startDate: "2026-10-01", endDate: "2027-05-31" },
    workItems: [
      { activityId: rebar.id, quantity: 300, unit: rebar.unit },
      { activityId: pour.id, quantity: 1500, unit: pour.unit },
      { activityId: cure.id, quantity: 15000, unit: cure.unit },
    ],
  }, new MemoryStore(productivityData));
  for (const option of plan.planOptions) {
    const [steel, concrete, curing] = option.workItems;
    assert.ok(steel.endDay < concrete.startDay, `${option.name}不得提前浇筑`);
    assert.ok(concrete.endDay < curing.startDay, `${option.name}不得提前养护`);
  }
});

test("浇筑和养护合并的工效保留估算但提示不能单独核对养护", async () => {
  const plan = await generateWorkforcePlan({
    project: { startDate: "2026-10-01", endDate: "2026-10-08" },
    workItems: [{ activityId: "composite", quantity: 100, unit: "m" }],
  }, store);
  assert.match(plan.warnings.join(" "), /建议拆分/);
});

test("预制构件工效不被识别为现场现浇工序", async () => {
  const plan = await generateWorkforcePlan({
    project: { startDate: "2026-10-01", endDate: "2026-10-08" },
    workItems: [{ activityId: "prefab-pour", quantity: 100, unit: "m³" }],
  }, store);
  assert.equal(plan.workItems[0].processType, "other");
  assert.ok(!plan.warnings.some((warning) => warning.includes("未录入养护")));
});
