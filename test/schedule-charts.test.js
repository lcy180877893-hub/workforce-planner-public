import test from "node:test";
import assert from "node:assert/strict";
import { dateOffset, getTimelineRange, buildWorkforceDays, aggregateWorkforceDays } from "../public/schedule-charts.js";
import { generateWorkforcePlan } from "../src/planner.js";

const sampleProject = { startDate: "2026-10-01", endDate: "2027-05-31" };
const sampleItems = [
  { status: "calculated", startDate: "2026-10-01", endDate: "2026-10-03", crewPerShift: { 技工: 5 }, shiftsPerDay: 1 },
  { status: "calculated", startDate: "2026-10-04", endDate: "2026-10-04", crewPerShift: { 混凝土工: 9 }, shiftsPerDay: 1 },
];

test("最新记录的三天开挖和一天垫层形成5/5/5/9人数柱，总24人日", () => {
  const days = buildWorkforceDays(sampleItems);
  assert.deepEqual(days.map((day) => day.headcount), [5, 5, 5, 9]);
  assert.deepEqual(days.map((day) => day.onShiftHeadcount), [5, 5, 5, 9]);
  assert.equal(days.reduce((sum, day) => sum + day.personDays, 0), 24);
  assert.deepEqual(getTimelineRange(sampleProject, sampleItems), {
    startDate: "2026-10-01", endDate: "2026-10-04", durationDays: 4,
  });
  assert.deepEqual(getTimelineRange(sampleProject, sampleItems, { scope: "project" }), { ...sampleProject, durationDays: 243 });
});

test("单日零偏移横道可见，UTC跨月闰年不受本地时区影响", () => {
  const items = [{ startDate: "2028-02-29", endDate: "2028-02-29", peakCrew: { 木工: 3 } }];
  assert.equal(getTimelineRange({}, items).durationDays, 1);
  assert.equal(dateOffset("2028-03-01", "2028-02-28"), 2);
  assert.equal(dateOffset("2026-10-01", "2026-10-01"), 0);
  assert.equal(dateOffset("2026-09-30", "2026-10-01"), -1);
  assert.equal(dateOffset("2026-02-29", "2026-02-28"), null);
  assert.deepEqual(buildWorkforceDays(items).map((day) => day.headcount), [3]);
});

test("早晚两套班组以全日合计计数，最后未工作的晚班不虚增", () => {
  const days = buildWorkforceDays([{ startDate: "2026-10-01", endDate: "2026-10-03",
    shiftsPerDay: 2, lastDayShifts: 1, crewPerShift: { 技工: 2, 普工: 3 }, peakCrew: { 技工: 4, 普工: 6 } }]);
  assert.deepEqual(days.map((day) => day.headcount), [10, 10, 5]);
  assert.deepEqual(days.map((day) => day.onShiftHeadcount), [5, 5, 5]);
  assert.equal(days.reduce((sum, day) => sum + day.personDays, 0), 25);
});

test("早晚班仅有activeShifts的历史记录仍可识别最后早班", () => {
  const days = buildWorkforceDays([{ startDate: "2026-10-01", endDate: "2026-10-03",
    shiftsPerDay: 2, activeShifts: 5, crewPerShift: { 技工: 5 } }]);
  assert.deepEqual(days.map((day) => day.headcount), [10, 10, 5]);
});

test("单日只工作早班时不显示整套早晚班峰值", () => {
  const days = buildWorkforceDays([{ startDate: "2026-10-01", endDate: "2026-10-01", shiftsPerDay: 2,
    lastDayShifts: 1, crewPerShift: { 钢筋工: 4 }, peakCrew: { 钢筋工: 8 } }]);
  assert.equal(days[0].headcount, 4);
  assert.equal(days[0].onShiftHeadcount, 4);
});

test("多班组人员字段已经乘过班组数，不因requiredCrews再次倍乘", () => {
  const days = buildWorkforceDays([{ startDate: "2026-10-01", endDate: "2026-10-02",
    requiredCrews: 3, crewsPerShift: 3, shiftsPerDay: 1, crewPerShift: { 钢筋工: 12 }, peakCrew: { 钢筋工: 12 } }]);
  assert.deepEqual(days.map((day) => day.headcount), [12, 12]);
});

test("白班多工序搭接的同工种独立班组必须合并，不把单班组误解为全项目共用1组", () => {
  const items = [
    { startDate: "2026-10-01", endDate: "2026-10-03", requiredCrews: 1, crewsPerShift: 1, shiftsPerDay: 1,
      crewPerShift: { 钢筋工: 4, 杂工: 2 }, peakCrew: { 钢筋工: 4, 杂工: 2 } },
    { startDate: "2026-10-02", endDate: "2026-10-04", requiredCrews: 1, crewsPerShift: 1, shiftsPerDay: 1,
      crewPerShift: { 钢筋工: 3, 杂工: 2 }, peakCrew: { 钢筋工: 3, 杂工: 2 } },
  ];
  const before = structuredClone(items);
  const days = buildWorkforceDays(items, { id: "single-crew-day-overlap", staffingMode: "single-crew-day-overlap", shiftsPerDay: 1 });
  assert.deepEqual(days.map((day) => day.headcount), [6, 11, 11, 5]);
  assert.deepEqual(days.map((day) => day.onShiftHeadcount), [6, 11, 11, 5]);
  assert.deepEqual(days[1].roles, { 钢筋工: 7, 杂工: 4 });
  assert.equal(days.reduce((sum, day) => sum + day.personDays, 0), 33);
  const weeks = aggregateWorkforceDays(days, { granularity: "week" });
  assert.equal(weeks.peakHeadcount, 11);
  assert.equal(weeks.totalPersonDays, 33);
  assert.deepEqual(items, before);
});

test("多班组白班搭接汇总同工种各完整班组人数，不重复按班组数倍乘", () => {
  const items = [
    { startDate: "2026-10-01", endDate: "2026-10-03", requiredCrews: 3, crewsPerShift: 3, shiftsPerDay: 1,
      crewPerShift: { 钢筋工: 12, 杂工: 6 }, peakCrew: { 钢筋工: 12, 杂工: 6 } },
    { startDate: "2026-10-02", endDate: "2026-10-04", requiredCrews: 2, crewsPerShift: 2, shiftsPerDay: 1,
      crewPerShift: { 钢筋工: 6, 杂工: 4 }, peakCrew: { 钢筋工: 6, 杂工: 4 } },
  ];
  const before = structuredClone(items);
  const days = buildWorkforceDays(items, { id: "multi-crew-day-overlap", staffingMode: "multi-crew-day-overlap", shiftsPerDay: 1 });
  assert.deepEqual(days.map((day) => day.headcount), [18, 28, 28, 10]);
  assert.deepEqual(days.map((day) => day.onShiftHeadcount), [18, 28, 28, 10]);
  assert.deepEqual(days[1].roles, { 钢筋工: 18, 杂工: 10 });
  assert.equal(days.reduce((sum, day) => sum + day.personDays, 0), 84);
  assert.deepEqual(items, before);
});

test("旧历史仅有peakCrew时直接使用全日人数，不乘班组或重复乘班次", () => {
  const days = buildWorkforceDays([{ startDate: "2026-10-01", endDate: "2026-10-02", requiredCrews: 3,
    peakCrew: { 钢筋工: 12 } }], { shiftsPerDay: 2 });
  assert.deepEqual(days.map((day) => day.headcount), [12, 12]);
  assert.deepEqual(days.map((day) => day.onShiftHeadcount), [6, 6]);
});

test("缺失或不可用工效、无排程工序、无效日期不会生成虚假的劳动力", () => {
  const missing = [
    { status: "missing_productivity", startDate: "2026-10-01", endDate: "2026-10-31", peakCrew: { 测试工: 999 } },
    { status: "unit_mismatch", startDate: "2026-10-01", endDate: "2026-10-31", peakCrew: { 测试工: 999 } },
    { status: "unavailable", startDate: "2026-10-01", endDate: "2026-10-31", peakCrew: { 测试工: 999 } },
    { peakCrew: { 测试工: 999 } },
    { startDate: "2026-10-03", endDate: "2026-10-01", peakCrew: { 测试工: 999 } },
    { startDate: "2026-02-29", endDate: "2026-03-01", peakCrew: { 测试工: 999 } },
  ];
  assert.deepEqual(buildWorkforceDays(missing), []);
  assert.deepEqual(buildWorkforceDays([...sampleItems, ...missing]), buildWorkforceDays(sampleItems));
});

test("优先采用实际日期，只有缺少日期的旧结果才以项目开始日换算offset", () => {
  const items = [{ startDate: "2026-10-05", endDate: "2026-10-05", startDay: 0, endDay: 4, peakCrew: { 工人: 3 } }];
  assert.deepEqual(getTimelineRange(sampleProject, items), { startDate: "2026-10-05", endDate: "2026-10-05", durationDays: 1 });
  const legacy = [{ startDay: 1, endDay: 2, peakCrew: { 工人: 3 } }];
  assert.deepEqual(buildWorkforceDays(legacy, { project: sampleProject }).map((day) => day.date), ["2026-10-02", "2026-10-03"]);
});

test("活动范围内的空档保留为零人，而不是压缩或虚构施工日", () => {
  const days = buildWorkforceDays([
    { startDate: "2026-10-01", endDate: "2026-10-01", peakCrew: { 工人: 2 } },
    { startDate: "2026-10-03", endDate: "2026-10-03", peakCrew: { 工人: 3 } },
  ]);
  assert.deepEqual(days.map((day) => day.headcount), [2, 0, 3]);
});

test("按日图可展示整个项目范围，实际完工后明确为零人", () => {
  const aggregated = aggregateWorkforceDays(buildWorkforceDays(sampleItems), {
    ...sampleProject, granularity: "day",
  });
  assert.equal(aggregated.bins.length, 243);
  assert.deepEqual(aggregated.bins.slice(0, 5).map((bin) => bin.peakHeadcount), [5, 5, 5, 9, 0]);
  assert.equal(aggregated.totalPersonDays, 24);
  assert.equal(aggregated.peakHeadcount, 9);
});

test("按周聚合显示人数峰值不是人数相加，也不使用平均值冒充配备人数", () => {
  const aggregated = aggregateWorkforceDays(buildWorkforceDays(sampleItems), { granularity: "week" });
  assert.equal(aggregated.bins.length, 1);
  assert.equal(aggregated.bins[0].peakHeadcount, 9);
  assert.equal(aggregated.bins[0].personDays, 24);
  assert.equal(aggregated.bins[0].days, 4);
  assert.equal(aggregated.metricLabel, "周期峰值人数");
});

test("按月聚合按实际日历分组，跨月部分周期不漏算", () => {
  const days = buildWorkforceDays([{ startDate: "2026-10-30", endDate: "2026-11-02", peakCrew: { 工人: 3 } }]);
  const aggregated = aggregateWorkforceDays(days, { granularity: "month" });
  assert.deepEqual(aggregated.bins.map((bin) => [bin.startDate, bin.endDate, bin.peakHeadcount, bin.personDays]), [
    ["2026-10-30", "2026-10-31", 3, 6], ["2026-11-01", "2026-11-02", 3, 6],
  ]);
});

test("自动聚合限制长工期柱数，仍保留真实峰值和独立人日", () => {
  const days = buildWorkforceDays(sampleItems);
  const aggregated = aggregateWorkforceDays(days, { startDate: "2026-10-01", endDate: "2040-12-31", maxBars: 45 });
  assert.ok(aggregated.bins.length <= 45);
  assert.equal(aggregated.granularity, "month");
  assert.equal(aggregated.peakHeadcount, 9);
  assert.equal(aggregated.totalPersonDays, 24);
  assert.equal(aggregated.bins[0].peakHeadcount, 9);
});

test("所有泵共用一名电工且不把水泵台数算成人数，普通电工班组另计", () => {
  const days = buildWorkforceDays([
    { startDate: "2026-10-01", endDate: "2026-10-02", category: "降排水", mode: "equipment_hour",
      requiredEquipment: { 小泵: 8 }, crewPerShift: {}, shiftsPerDay: 1 },
    { startDate: "2026-10-01", endDate: "2026-10-01", category: "降排水", mode: "equipment_hour",
      requiredEquipment: { 大泵: 12 }, crewPerShift: {}, shiftsPerDay: 1 },
    { startDate: "2026-10-01", endDate: "2026-10-01", category: "吊装", mode: "equipment_hour",
      requiredEquipment: { 吊车: 1 }, crewPerShift: {} },
    { startDate: "2026-10-01", endDate: "2026-10-01", crewPerShift: { 电工: 2 }, shiftsPerDay: 2, lastDayShifts: 2 },
  ], { shiftsPerDay: 2 });
  assert.deepEqual(days.map((day) => day.headcount), [5, 1]);
  assert.deepEqual(days.map((day) => day.onShiftHeadcount), [3, 1]);
  assert.deepEqual(days.map((day) => day.roles), [{ 电工: 5 }, { 电工: 1 }]);
});

test("展示投影与权威排程的双班、多班组、共享降排水电工汇总一致", async () => {
  const definitions = [
    { id: "labour", name: "普通作业", category: "测试", mode: "crew_day", output: 100, crew: { 技工: 2, 普工: 3 }, unit: "m²" },
    { id: "pump", name: "小泵", category: "降排水", mode: "equipment_hour", output: 25, crew: {}, equipment: ["水泵"], unit: "m³" },
    { id: "pump2", name: "大泵", category: "降排水", mode: "equipment_hour", output: 80, crew: {}, equipment: ["大泵"], unit: "m³" },
  ].map((item) => ({ ...item, status: "confirmed" }));
  const store = { find: async (id) => definitions.find((item) => item.id === id) ?? null };
  for (const includePumps of [false, true]) {
    const plan = await generateWorkforcePlan({
      project: { startDate: "2026-10-01", endDate: "2026-10-06" },
      workItems: [
        { activityId: "labour", quantity: 1100, unit: "m²" },
        ...(includePumps ? [{ activityId: "pump", quantity: 1250, unit: "m³" },
          { activityId: "pump2", quantity: 4000, unit: "m³" }] : []),
      ],
    }, store);
    for (const option of plan.planOptions) {
      const days = buildWorkforceDays(option.workItems, { ...option, project: plan.project });
      assert.equal(Math.max(...days.map((day) => day.headcount)), option.summary.conservativePeakHeadcount);
      assert.equal(Math.max(...days.map((day) => day.onShiftHeadcount)), option.summary.peakOnShiftHeadcount);
      assert.equal(days.reduce((sum, day) => sum + day.personDays, 0), option.summary.totalPersonDays);
      for (const role of Object.keys(option.summary.tradePersonDays)) {
        assert.equal(days.reduce((sum, day) => sum + (day.roles[role] ?? 0), 0), option.summary.tradePersonDays[role]);
      }
    }
  }
});

test("图表投影不修改历史对象、工序人员或输入每日数据", () => {
  const items = structuredClone(sampleItems);
  const before = structuredClone(items);
  const days = buildWorkforceDays(items);
  const priorDays = structuredClone(days);
  getTimelineRange(sampleProject, items);
  aggregateWorkforceDays(days, { granularity: "week" });
  assert.deepEqual(items, before);
  assert.deepEqual(days, priorDays);
});

test("用户维护的工种名称作为普通数据，不受对象原型同名属性影响", () => {
  const roles = JSON.parse('{"__proto__":2,"constructor":3,"toString":4}');
  const days = buildWorkforceDays([{ startDate: "2026-10-01", endDate: "2026-10-01", crewPerShift: roles }]);
  assert.equal(days[0].headcount, 9);
  assert.equal(days[0].roles.__proto__, 2);
  assert.equal(days[0].roles.constructor, 3);
  assert.equal(Object.getPrototypeOf(days[0].roles), Object.prototype);
});

test("空数据和无效范围安全返回空图；无排程时横道范围可回退到项目日期", () => {
  assert.deepEqual(buildWorkforceDays([]), []);
  assert.equal(getTimelineRange({}, []), null);
  assert.deepEqual(getTimelineRange(sampleProject, []), { ...sampleProject, durationDays: 243 });
  assert.deepEqual(aggregateWorkforceDays([]).bins, []);
  assert.deepEqual(aggregateWorkforceDays([], { startDate: "2026-10-04", endDate: "2026-10-01" }).bins, []);
});
