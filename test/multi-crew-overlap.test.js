import test from "node:test";
import assert from "node:assert/strict";
import { buildScheduleOptions } from "../src/scheduler.js";
import { enumerateCalendarDays } from "../public/calendar.js";

const optionId = "multi-crew-day-overlap";
const singleId = "single-crew-day-overlap";
const project = { startDate: "2026-10-01", endDate: "2026-10-05" };

function item(itemId, sequence, options = {}) {
  return {
    definition: {
      id: itemId, name: itemId, mode: "crew_day", category: "钢筋工", output: 10,
      baseOutput: 10, crew: { 钢筋工: 4 }, status: "confirmed", ...options.definition,
    },
    result: {
      itemId, sequence, name: itemId, status: "calculated", quantity: 40,
      divisionId: `division-${sequence}`, division: `分部${sequence}`, divisionSequence: sequence,
      subitemId: `subitem-${sequence}`, hierarchyNumber: `${sequence}.1.1`,
      dependsOnSequences: [], dependencyReasons: [], ...options.result,
    },
  };
}

function run(prepared, parallelGroups = [], options = {}) {
  const currentProject = { ...project, ...options.project };
  const days = enumerateCalendarDays(currentProject);
  return buildScheduleOptions(prepared, days, days.reduce((sum, day) => sum + day.factor, 0),
    options.constraints ?? new Map(), { allowInterleaved: options.allowInterleaved ?? true, project: currentProject, parallelGroups });
}

const parallel = (...itemIds) => ({ itemIds, reason: "已确认工作面各自独立、各道工序配独立班组，可同时开展" });
const optionOf = (result) => result.options.find((option) => option.id === optionId);

test("单班白班搭接仍不足才增加整数多班组白班搭接，并保留原赶工方案", () => {
  const result = run([
    item("long", 1, { result: { quantity: 80 } }),
    item("short", 2, { result: { quantity: 10 } }),
  ], [parallel("long", "short")]);
  assert.equal(result.baselineAssessment.feasible, false);
  assert.equal(result.options.find((option) => option.id === singleId), undefined);
  assert.match(result.unavailable.find((option) => option.id === singleId).reason, /仍不能满足工期/);
  assert.deepEqual(result.options.map((option) => option.id), [optionId, "two-shift", "multi-crew-day"]);
  const option = optionOf(result);
  assert.equal(option.name, "多班组白班多工序搭接");
  assert.equal(option.staffingMode, optionId);
  assert.equal(option.shiftsPerDay, 1);
  assert.equal(option.hoursPerShift, 8);
  assert.match(option.description, /仍须现场核实.*条件性资源估算/);
  assert.deepEqual(option.workItems.map((entry) => [entry.crewsPerShift, entry.totalCrewRosters, entry.startDay, entry.endDay]), [[2, 2, 0, 3], [1, 1, 0, 0]]);
  assert.equal(option.finishDate, "2026-10-04");
  assert.equal(option.slackDays, 1);
  assert.equal(option.summary.conservativePeakHeadcount, 12);
  assert.equal(option.summary.peakOnShiftHeadcount, 12);
  assert.equal(option.summary.totalPersonDays, 36);
  assert.equal(option.summary.averageHeadcount, 7.2);
  assert.deepEqual(option.overlapBasis, [parallel("long", "short")]);
  assert.equal(option.overlapBasisTotal, 1);
  assert.equal(option.overlapBasisTruncated, false);
  for (const original of result.options.filter((entry) => entry.id !== optionId)) {
    assert.ok(original.workItems[0].endDay < original.workItems[1].startDay, "原早晚班及多班白班仍使用分部顺序而非新搭接图");
  }
});

test("顺序施工满足工期时只保留顺序施工", () => {
  const result = run([item("a", 1), item("b", 2)], [parallel("a", "b")], { project: { endDate: "2026-10-08" } });
  assert.deepEqual(result.options.map((option) => option.id), ["sequential"]);
  assert.deepEqual(result.unavailable, []);
});

test("单班白班搭接已经满足工期时不升级为多班搭接", () => {
  const result = run([item("a", 1), item("b", 2)], [parallel("a", "b")]);
  assert.ok(result.options.some((option) => option.id === singleId));
  assert.equal(optionOf(result), undefined);
  assert.equal(result.unavailable.some((option) => option.id === optionId), false);
});

test("缺少已审查平行工作面依据时多班组也不能默认搭接", () => {
  const work = [item("a", 1), item("b", 2)];
  for (const [groups, allowInterleaved] of [[[], true], [[parallel("a", "b")], false], [[{ itemIds: ["a", "b"], reason: "" }], true]]) {
    const result = run(work, groups, { allowInterleaved });
    assert.equal(optionOf(result), undefined);
    assert.match(result.unavailable.find((option) => option.id === optionId).reason, /缺少GPT明确确认.*不能仅因未设置前置/);
    assert.ok(result.options.some((option) => option.id === "multi-crew-day"));
  }
});

test("多班组搭接仍严格保留钢筋完成后次日浇筑的FS前置", () => {
  const work = [
    item("steel", 1, { result: { quantity: 80 } }),
    item("pour", 2, { result: { quantity: 20, dependsOnSequences: [1], dependencyReasons: [{ sequence: 1, reason: "同部位钢筋完成后才浇筑" }] } }),
    item("external", 3, { result: { quantity: 80 } }),
  ];
  const option = optionOf(run(work, [parallel("steel", "external"), parallel("pour", "external")]));
  assert.ok(option);
  const [steel, pour, external] = option.workItems;
  assert.equal(pour.startDay, steel.endDay + 1);
  assert.deepEqual(pour.dependsOnSequences, [1]);
  assert.deepEqual(pour.dependencyReasons, work[1].result.dependencyReasons);
  assert.ok(external.startDay <= steel.endDay);
  assert.ok(option.workItems.some((entry) => entry.crewsPerShift > 1));
  assert.ok(option.workItems.every((entry) => Number.isSafeInteger(entry.crewsPerShift) && entry.shiftsPerDay === 1 && entry.hoursPerShift === 8));
});

test("多班组搭接的平行许可仍不传递，未授权AC对不得因AB和BC同时施工", () => {
  const work = ["a", "b", "c"].map((id, index) => item(id, index + 1, { result: { quantity: 80 } }));
  const option = optionOf(run(work, [parallel("a", "b"), parallel("b", "c")], { project: { endDate: "2026-10-06" } }));
  assert.ok(option);
  const [a, b, c] = option.workItems;
  assert.ok(a.endDay < c.startDay);
  assert.equal(b.startDay, a.startDay);
  assert.ok(option.overlapBasis.every((basis) => JSON.stringify(basis.itemIds) !== JSON.stringify(["a", "c"])));
  assert.ok(option.workItems.every((entry) => entry.endDay < 6));
});

test("明确分部完成限制不因多班组搭接被放松，未真实重叠的顺序赶工不冒称搭接", () => {
  const result = run([item("a", 1), item("b", 2)], [parallel("a", "b")], {
    project: { endDate: "2026-10-04" },
    constraints: new Map([["division-2", { afterDivisionId: "division-1", afterLabel: "1 · 分部1" }]]),
  });
  assert.equal(optionOf(result), undefined);
  assert.match(result.unavailable.find((option) => option.id === optionId).reason, /未形成实际多班组工序搭接.*顺序赶工/);
  for (const option of result.options) {
    assert.ok(option.workItems[0].endDay < option.workItems[1].startDay);
    assert.equal(option.divisionSchedule[1].afterDivision, "1 · 分部1");
  }
});

test("某分部受已选分项完成限制时，只等相应目标且保存限制标识", () => {
  const work = [
    item("a", 1, { result: { quantity: 80 } }),
    item("a2", 2, { result: { quantity: 10, divisionId: "division-1", divisionSequence: 1 } }),
    item("b", 3, { result: { quantity: 40 } }),
    item("independent", 4, { result: { quantity: 80 } }),
  ];
  const result = run(work, [parallel("a", "a2", "independent"), parallel("b", "independent"), parallel("a2", "b")], {
    constraints: new Map([["division-3", { afterDivisionId: "division-1", afterSubitemId: "subitem-1", afterLabel: "1.1 · 目标分项" }]]),
  });
  const option = optionOf(result);
  assert.ok(option);
  const [a, , b] = option.workItems;
  assert.ok(b.startDay > a.endDay);
  assert.equal(option.divisionSchedule.find((division) => division.divisionId === "division-3").afterDivision, "1.1 · 目标分项");
});

test("增加泵数量仍按每台10小时产能，所有搭接泵共配1名电工", () => {
  const pump = (id, sequence, output, quantity) => item(id, sequence, {
    definition: { mode: "equipment_hour", category: "降排水", output, baseOutput: output * 10, crew: {}, equipment: [id] },
    result: { quantity },
  });
  const option = optionOf(run([pump("pump70", 1, 25, 2000), pump("pump140", 2, 80, 800)], [parallel("pump70", "pump140")], { project: { endDate: "2026-10-04" } }));
  assert.ok(option);
  assert.deepEqual(option.summary.equipmentPeak, { pump70: 2, pump140: 1 });
  assert.deepEqual(option.summary.tradePeak, { 电工: 1 });
  assert.deepEqual(option.summary.tradePeakPerShift, { 电工: 1 });
  assert.deepEqual(option.summary.tradePersonDays, { 电工: 4 });
  assert.equal(option.summary.totalPersonDays, 4);
  assert.deepEqual(option.workItems.map((entry) => [entry.requiredUnitsRaw, entry.equipmentOperatingHoursPerDay, entry.shiftsPerDay, entry.durationDays]), [[2, 10, 1, 4], [1, 10, 1, 1]]);
});

test("逐日季节和斋月比例用于多班搭接，人数与人日可直接用于柱状图", () => {
  const currentProject = {
    startDate: "2026-09-29", endDate: "2026-10-03",
    calendarRules: { ramadan: { mode: "custom", ranges: [{ startDate: "2026-10-02", endDate: "2026-10-02" }], factor: 0.5 } },
  };
  const option = optionOf(run([
    item("long", 1, { result: { quantity: 60 } }),
    item("short", 2, { result: { quantity: 20 } }),
  ], [parallel("long", "short")], { project: currentProject }));
  assert.ok(option);
  assert.equal(option.finishDate, "2026-10-03");
  assert.deepEqual(option.workItems.map((entry) => [entry.crewsPerShift, entry.durationDays, entry.effectiveDays]), [[2, 5, 3.9], [1, 3, 2.4]]);
  assert.equal(option.summary.totalPersonDays, 52);
  assert.equal(option.summary.conservativePeakHeadcount, 12);
  assert.equal(option.summary.averageHeadcount, 10.4);
  assert.equal(option.workItems.reduce((sum, entry) => sum + Object.values(entry.personDaysByTrade).reduce((value, count) => value + count, 0), 0), option.summary.totalPersonDays);
});

test("极小的正工程量仍计算为正工时并按整数班组反算，不被误当零工程量", () => {
  const work = [
    item("long", 1, { result: { quantity: 1e-300 } , definition: { output: 1e-300, baseOutput: 1e-300 } }),
    item("short", 2, { result: { quantity: 1e-300 }, definition: { output: 1e-300, baseOutput: 1e-300 } }),
  ];
  // A half-efficiency day needs two units (or two shifts) per item. This also
  // exercises tiny finite values without treating positive work as zero.
  const result = run(work, [parallel("long", "short")], { project: { endDate: project.startDate, calendarRules: { winter: { factor: 0.5 } } } });
  assert.ok(optionOf(result));
  assert.deepEqual(optionOf(result).workItems.map((entry) => entry.crewsPerShift), [2, 2]);
  assert.ok(optionOf(result).workItems.every((entry) => entry.startDay === 0 && entry.endDay === 0));
});

test("搭接整数班组遵守有限资源上界，超上界时明确失败而不输出虚假可行方案", () => {
  const work = (quantity) => [item("long", 1, { result: { quantity } }), item("short", 2, { result: { quantity: 10 } })];
  const options = { project: { endDate: project.startDate } };
  const atLimit = optionOf(run(work(10_000_000), [parallel("long", "short")], options));
  assert.ok(atLimit);
  assert.deepEqual(atLimit.workItems.map((entry) => entry.crewsPerShift), [1_000_000, 1]);
  assert.throws(() => run(work(10_000_010), [parallel("long", "short")], options), /所有班组方案均无法满足.*所需资源超出测算范围/);
});

test("500项多班搭接保存至多200条配对依据，准确记录总数且不截断工程量", () => {
  const work = Array.from({ length: 500 }, (_, index) => item(`work-${index + 1}`, index + 1, { result: { quantity: 20 } }));
  const groups = [parallel(...work.map((entry) => entry.result.itemId))];
  const originalWork = structuredClone(work);
  const originalGroups = structuredClone(groups);
  const option = optionOf(run(work, groups, { project: { endDate: project.startDate } }));
  assert.ok(option);
  assert.equal(option.workItems.length, 500);
  assert.equal(option.divisionSchedule.length, 500);
  assert.equal(option.summary.calculatedItems, 500);
  assert.equal(option.summary.conservativePeakHeadcount, 4000);
  assert.equal(option.summary.totalPersonDays, 4000);
  assert.equal(option.overlapBasis.length, 200);
  assert.equal(option.overlapBasisTotal, 124750);
  assert.equal(option.overlapBasisTruncated, true);
  assert.ok(option.workItems.every((entry) => entry.crewsPerShift === 2 && entry.startDay === 0 && entry.endDay === 0));
  assert.ok(Buffer.byteLength(JSON.stringify(option), "utf8") < 1_000_000);
  assert.deepEqual(work, originalWork);
  assert.deepEqual(groups, originalGroups);
});

test("有限资源无法容纳FS日历最短链时给出不可用而不放松顺序", () => {
  const work = [item("a", 1), item("b", 2, { result: { dependsOnSequences: [1] } }), item("independent", 3)];
  assert.throws(() => run(work, [parallel("a", "independent"), parallel("b", "independent")], { project: { endDate: project.startDate } }), /无法满足.*无法容纳必须逐日完成的施工顺序/);
});
