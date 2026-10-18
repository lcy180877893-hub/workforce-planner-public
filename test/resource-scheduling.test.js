import test from "node:test";
import assert from "node:assert/strict";
import { generateWorkforcePlan } from "../src/planner.js";

const definitions = [
  { id: "sample", name: "通用作业", category: "测试工", mode: "crew_day", unit: "m²", output: 100, crew: { 技工: 2, 普工: 3 }, equipment: [] },
  { id: "pump", name: "70方泵", category: "降排水", mode: "equipment_hour", unit: "m³", output: 25, crew: {}, equipment: ["70m³/h名义泵"] },
  { id: "pump-large", name: "140方泵", category: "降排水", mode: "equipment_hour", unit: "m³", output: 80, crew: {}, equipment: ["140m³/h名义泵"] },
  { id: "steel", name: "钢筋绑扎/安装", category: "钢筋工", mode: "crew_day", unit: "t", output: 10, crew: { 钢筋工: 4 }, equipment: [] },
  { id: "pour", name: "筏板混凝土浇筑", category: "混凝土工", mode: "crew_day", unit: "m³", output: 100, crew: { 混凝土工: 4 }, equipment: [] },
].map((definition) => ({ ...definition, source: "隔离测试", status: "confirmed" }));

// The fixture is read-only and never touches the deployed productivity/history files.
const store = { find: async (id) => definitions.find((definition) => definition.id === id) ?? null };
const input = (quantity, endDate = "2026-10-05", project = {}) => ({
  project: { startDate: "2026-10-01", endDate, ...project },
  workItems: [{ activityId: "sample", quantity, unit: "m²" }],
});
const byId = (plan, id) => plan.planOptions.find((option) => option.id === id);

test("充足工期只推荐单班单组顺序施工，不无故增加人员或输出旧穿插方案", async () => {
  const plan = await generateWorkforcePlan(input(500, "2026-10-20"), store);
  assert.deepEqual(plan.planOptions.map((option) => option.id), ["sequential"]);
  assert.equal(plan.selectedOptionId, "sequential");
  assert.equal(plan.baselineAssessment.feasible, true);
  assert.equal(plan.baselineAssessment.finishDate, "2026-10-05");
  assert.equal(plan.baselineAssessment.requiredCalendarDays, 5);
  assert.equal(plan.baselineAssessment.availableCalendarDays, 20);
  assert.equal(plan.baselineAssessment.overrunDays, 0);
  assert.equal(plan.baselineAssessment.isComplete, true);
  assert.equal(plan.baselineAssessment.assessedItems, 1);
  assert.equal(plan.baselineAssessment.missingItems, 0);
  assert.ok(plan.baselineAssessment.reason);
  const item = plan.workItems[0];
  assert.equal(item.requiredCrews, 1);
  assert.equal(item.crewsPerShift, 1);
  assert.equal(item.shiftsPerDay, 1);
  assert.equal(item.hoursPerShift, 8);
  assert.equal(item.totalCrewRosters, 1);
  assert.deepEqual(item.crewPerShift, { 技工: 2, 普工: 3 });
  assert.deepEqual(item.peakCrew, item.crewPerShift);
  assert.equal(plan.summary.totalPersonDays, 25);
  assert.equal(plan.summary.conservativePeakHeadcount, 5);
  assert.equal(plan.summary.peakOnShiftHeadcount, 5);
});

test("单班单组超期后仅提供单组早晚班与多班组白班，两者不改变顺序", async () => {
  const plan = await generateWorkforcePlan(input(1000), store);
  assert.deepEqual(plan.planOptions.map((option) => option.id), ["two-shift", "multi-crew-day"]);
  assert.equal(plan.baselineAssessment.feasible, false);
  assert.equal(plan.baselineAssessment.finishDate, "2026-10-10");
  assert.equal(plan.baselineAssessment.requiredCalendarDays, 10);
  assert.equal(plan.baselineAssessment.availableCalendarDays, 5);
  assert.equal(plan.baselineAssessment.overrunDays, 5);
  const twoShift = byId(plan, "two-shift");
  const daytime = byId(plan, "multi-crew-day");
  assert.equal(twoShift.workItems[0].requiredCrews, 1);
  assert.equal(twoShift.workItems[0].crewsPerShift, 1);
  assert.equal(twoShift.workItems[0].shiftsPerDay, 2);
  assert.equal(twoShift.workItems[0].hoursPerShift, 8);
  assert.equal(twoShift.workItems[0].totalCrewRosters, 2);
  assert.equal(daytime.workItems[0].requiredCrews, 2);
  assert.equal(daytime.workItems[0].crewsPerShift, 2);
  assert.equal(daytime.workItems[0].shiftsPerDay, 1);
  assert.equal(daytime.workItems[0].totalCrewRosters, 2);
  for (const option of plan.planOptions) {
    assert.equal(option.finishDate, "2026-10-05");
    assert.equal(option.feasible, true);
    assert.equal(option.summary.totalPersonDays, 50);
    assert.equal(option.summary.conservativePeakHeadcount, 10);
  }
  assert.equal(twoShift.summary.peakOnShiftHeadcount, 5);
  assert.equal(daytime.summary.peakOnShiftHeadcount, 10);
});

test("早晚班是两套人员而非同一人连续工作，最后未开工的晚班不计人日", async () => {
  const plan = await generateWorkforcePlan(input(1100, "2026-10-06"), store);
  const option = byId(plan, "two-shift");
  const item = option.workItems[0];
  assert.deepEqual(item.crewPerShift, { 技工: 2, 普工: 3 });
  assert.deepEqual(item.peakCrew, { 技工: 4, 普工: 6 });
  assert.deepEqual(item.personDaysByTrade, { 技工: 22, 普工: 33 });
  assert.equal(item.durationDays, 6);
  assert.equal(item.endDate, "2026-10-06");
  assert.equal(option.summary.totalPersonDays, 55);
  assert.deepEqual(option.summary.tradePersonDays, { 技工: 22, 普工: 33 });
  assert.deepEqual(option.summary.tradePeak, { 技工: 4, 普工: 6 });
  assert.deepEqual(option.summary.tradePeakPerShift, { 技工: 2, 普工: 3 });
  assert.equal(option.summary.conservativePeakHeadcount, 10);
  assert.equal(option.summary.peakOnShiftHeadcount, 5);
});

test("双班仍不足时如实标为不可用，多班组白班可增加到三个整数班组", async () => {
  const plan = await generateWorkforcePlan(input(1500), store);
  assert.deepEqual(plan.planOptions.map((option) => option.id), ["multi-crew-day"]);
  assert.ok(plan.unavailableOptions.some((option) => option.id === "two-shift" && option.reason));
  assert.ok(!plan.planOptions.some((option) => ["balanced", "early-overlap"].includes(option.id)));
  assert.equal(plan.workItems[0].crewsPerShift, 3);
  assert.equal(plan.workItems[0].requiredCrews, 3);
  assert.equal(plan.workItems[0].shiftsPerDay, 1);
  assert.equal(plan.workItems[0].totalCrewRosters, 3);
  assert.equal(plan.summary.conservativePeakHeadcount, 15);
  assert.equal(plan.summary.peakOnShiftHeadcount, 15);
});

test("资源替代方案保留夏季70%和斋月优先50%，不捏造晚班折减", async () => {
  const summer = await generateWorkforcePlan(input(500, "2026-06-04", {
    startDate: "2026-06-01",
  }), store);
  assert.equal(summer.baselineAssessment.requiredCalendarDays, 8);
  for (const option of summer.planOptions) assert.equal(option.finishDate, "2026-06-04");
  assert.equal(byId(summer, "two-shift").summary.totalPersonDays, 40);

  const ramadan = await generateWorkforcePlan(input(300, "2026-06-04", {
    startDate: "2026-06-01",
    calendarRules: { ramadan: { mode: "custom", factor: 0.5,
      ranges: [{ startDate: "2026-06-01", endDate: "2026-06-10" }] } },
  }), store);
  assert.deepEqual(ramadan.project.periodDays, { winter: 0, summer: 0, ramadan: 4 });
  assert.equal(ramadan.baselineAssessment.requiredCalendarDays, 6);
  const twoShift = byId(ramadan, "two-shift");
  assert.equal(twoShift.finishDate, "2026-06-03");
  assert.equal(twoShift.summary.totalPersonDays, 30);
  assert.equal(twoShift.workItems[0].crewsPerShift, 1);
});

test("两班及多班组均保留钢筋完成次日才浇筑，不能将后置塞到同日晚班", async () => {
  const data = {
    project: { startDate: "2026-10-01", endDate: "2026-10-04" },
    workItems: [
      { activityId: "pour", quantity: 400, unit: "m³" },
      { activityId: "steel", quantity: 40, unit: "t" },
    ],
  };
  const plan = await generateWorkforcePlan(data, store);
  assert.equal(plan.baselineAssessment.requiredCalendarDays, 8);
  for (const option of plan.planOptions) {
    const [pour, steel] = option.workItems;
    assert.equal(steel.endDay + 1, pour.startDay);
    assert.deepEqual(pour.dependsOnSequences, [2]);
  }
  await assert.rejects(generateWorkforcePlan({ ...data,
    project: { ...data.project, endDate: "2026-10-01" },
  }, store), /无法.*(?:满足|完成)|(?:满足|完成).*无法/);
});

test("双班不擅自把泵每日10小时改成20小时，所有泵仍合计一个电工", async () => {
  const plan = await generateWorkforcePlan({
    project: { startDate: "2026-10-01", endDate: "2026-10-03" },
    workItems: [
      { activityId: "sample", quantity: 500, unit: "m²" },
      { activityId: "pump", quantity: 1250, unit: "m³" },
      { activityId: "pump-large", quantity: 4000, unit: "m³" },
    ],
  }, store);
  assert.equal(plan.calculationAssumptions.equipmentOperatingHoursPerDay, 10);
  assert.equal(plan.baselineAssessment.requiredCalendarDays, 5);
  assert.deepEqual(plan.planOptions.map((option) => option.id), ["multi-crew-day"]);
  assert.ok(plan.unavailableOptions.some((option) => option.id === "two-shift"));
  assert.equal(plan.workItems[1].requiredEquipment["70m³/h名义泵"], 2);
  assert.equal(plan.workItems[2].requiredEquipment["140m³/h名义泵"], 2);
  assert.equal(plan.summary.equipmentPeak["70m³/h名义泵"], 2);
  assert.equal(plan.summary.equipmentPeak["140m³/h名义泵"], 2);
  assert.equal(plan.summary.tradePeak["电工"], 1);
  assert.equal(plan.summary.tradePeakPerShift["电工"], 1);
  assert.equal(plan.summary.tradePersonDays["电工"], 3);
});

test("极小正工效比例和超大工程量须有限失败，不能溢出或无限预测", { timeout: 2_000 }, async () => {
  for (const payload of [
    input(100, "2026-10-01", { calendarRules: { winter: { factor: Number.MIN_VALUE } } }),
    input(Number.MAX_VALUE, "2026-10-01"),
  ]) {
    await assert.rejects(generateWorkforcePlan(payload, store), (error) => {
      assert.equal(error.statusCode, 400);
      assert.match(error.message, /无法|范围|无效/);
      return true;
    });
  }
  await assert.rejects(generateWorkforcePlan(input(Infinity), store), /大于0的数值/);
});

test("基线超过有限预测范围时完工日和超期天数保留未知，仍可给出有限资源的可行替代", async () => {
  const plan = await generateWorkforcePlan(input(5_000_000, "2026-10-10", {
    calendarRules: { winter: { factor: 1 }, summer: { factor: 1 }, ramadan: { factor: 1 } },
  }), store);
  assert.equal(plan.baselineAssessment.feasible, false);
  assert.equal(plan.baselineAssessment.finishDate, null);
  assert.equal(plan.baselineAssessment.requiredCalendarDays, null);
  assert.equal(plan.baselineAssessment.overrunDays, null);
  assert.equal(plan.baselineAssessment.availableCalendarDays, 10);
  assert.match(plan.baselineAssessment.reason, /预测范围/);
  assert.deepEqual(plan.planOptions.map((option) => option.id), ["multi-crew-day"]);
  assert.equal(plan.workItems[0].requiredCrews, 5_000);
  assert.equal(plan.planOptions[0].finishDate, "2026-10-10");
  assert.equal(plan.summary.totalPersonDays, 250_000);
  assert.doesNotMatch(JSON.stringify(plan), /NaN|Infinity/);
});

test("缺工效的局部可行结果及全缺项结果均明确不是全项目工期结论", async () => {
  for (const workItems of [
    [{ activityId: "sample", quantity: 100, unit: "m²" }, { name: "未提供工效", quantity: 1, unit: "项" }],
    [{ name: "未提供工效", quantity: 1, unit: "项" }],
  ]) {
    const plan = await generateWorkforcePlan({
      project: { startDate: "2026-10-01", endDate: "2026-10-10" }, workItems,
    }, store);
    assert.equal(plan.summary.missingItems, 1);
    assert.equal(plan.summary.calculatedItems, workItems.length - 1);
    assert.equal(plan.baselineAssessment.isComplete, false);
    assert.equal(plan.baselineAssessment.assessedItems, workItems.length - 1);
    assert.equal(plan.baselineAssessment.missingItems, 1);
    assert.match(plan.baselineAssessment.reason, /仅含已匹配.*缺项未计入/);
    assert.match(plan.warnings.join(" "), /缺少或无法使用工效.*未计入排程/);
    assert.equal(plan.missingProductivity[0].startDate, undefined);
    if (workItems.length === 1) {
      assert.equal(plan.baselineAssessment.finishDate, null);
      assert.equal(plan.baselineAssessment.requiredCalendarDays, 0);
      assert.equal(plan.summary.totalPersonDays, 0);
      assert.deepEqual(plan.summary.tradePeak, {});
    }
  }
});

test("只有两类泵时双班不能缩短泵工期，多泵白班仍仅投入一个电工人日", async () => {
  const plan = await generateWorkforcePlan({
    project: { startDate: "2026-10-01", endDate: "2026-10-01" },
    workItems: [
      { activityId: "pump", quantity: 500, unit: "m³" },
      { activityId: "pump-large", quantity: 1600, unit: "m³" },
    ],
  }, store);
  assert.equal(plan.baselineAssessment.requiredCalendarDays, 2);
  assert.equal(plan.baselineAssessment.finishDate, "2026-10-02");
  assert.equal(plan.baselineAssessment.overrunDays, 1);
  assert.deepEqual(plan.planOptions.map((option) => option.id), ["multi-crew-day"]);
  assert.equal(plan.summary.tradePeak["电工"], 1);
  assert.equal(plan.summary.tradePersonDays["电工"], 1);
  assert.equal(plan.summary.totalPersonDays, 1);
  assert.equal(plan.summary.peakOnShiftHeadcount, 1);
  assert.ok(plan.workItems.every((item) => item.shiftsPerDay === 1 && item.equipmentOperatingHoursPerDay === 10));
});

test("前日正常比例不能吞掉后继当天的极小正比例，次日微量工程仍可顺序完成", async () => {
  const rates = [
    { id: "first", name: "钢筋绑扎/安装", category: "钢筋工", unit: "t", crew: { 钢筋工: 1 } },
    { id: "second", name: "筏板混凝土浇筑", category: "混凝土工", unit: "m³", crew: { 混凝土工: 1 } },
  ].map((definition) => ({ ...definition, mode: "crew_day", output: 1, status: "confirmed", equipment: [] }));
  const tinyStore = { find: async (id) => rates.find((definition) => definition.id === id) ?? null };
  const plan = await generateWorkforcePlan({
    project: {
      startDate: "2026-10-01", endDate: "2026-10-02",
      calendarRules: { ramadan: { mode: "custom", factor: 1e-20,
        ranges: [{ startDate: "2026-10-02", endDate: "2026-10-02" }] } },
    },
    workItems: [
      { activityId: "first", quantity: 1, unit: "t" },
      { activityId: "second", quantity: 1e-20, unit: "m³" },
    ],
  }, tinyStore);
  assert.deepEqual(plan.planOptions.map((option) => option.id), ["sequential"]);
  assert.equal(plan.baselineAssessment.feasible, true);
  assert.equal(plan.baselineAssessment.requiredCalendarDays, 2);
  assert.equal(plan.baselineAssessment.finishDate, "2026-10-02");
  assert.deepEqual(plan.workItems.map((item) => [item.startDay, item.endDay]), [[0, 0], [1, 1]]);
  assert.deepEqual(plan.workItems[1].dependsOnSequences, [1]);
  assert.equal(plan.workItems[1].activeShifts, 1);
  assert.equal(plan.summary.totalPersonDays, 2);
});

test("略超一个白班产能时必须计入实际开工的晚班，完成与人日使用一致相对精度", async () => {
  const plan = await generateWorkforcePlan(input(100.000000005, "2026-10-01"), store);
  assert.equal(plan.baselineAssessment.feasible, false);
  assert.equal(plan.baselineAssessment.requiredCalendarDays, 2);
  const option = byId(plan, "two-shift");
  const item = option.workItems[0];
  assert.equal(item.activeShifts, 2);
  assert.equal(item.lastDayShifts, 2);
  assert.equal(item.totalCrewRosters, 2);
  assert.equal(item.endDate, "2026-10-01");
  assert.deepEqual(item.crewPerShift, { 技工: 2, 普工: 3 });
  assert.deepEqual(item.peakCrew, { 技工: 4, 普工: 6 });
  assert.deepEqual(item.personDaysByTrade, { 技工: 4, 普工: 6 });
  assert.equal(option.summary.totalPersonDays, 10);
  assert.equal(option.summary.conservativePeakHeadcount, 10);
  assert.equal(option.summary.peakOnShiftHeadcount, 5);
});
