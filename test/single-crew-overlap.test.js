import test from "node:test";
import assert from "node:assert/strict";
import { buildScheduleOptions } from "../src/scheduler.js";
import { enumerateCalendarDays } from "../public/calendar.js";

const project = { startDate: "2026-10-01", endDate: "2026-10-06" };
const optionId = "single-crew-day-overlap";

function item(itemId, sequence, options = {}) {
  const definition = {
    id: itemId, name: itemId, mode: "crew_day", category: "钢筋工", output: 10,
    baseOutput: 10, crew: { 钢筋工: 4 }, status: "confirmed", ...options.definition,
  };
  return {
    definition,
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

const parallel = (...itemIds) => ({ itemIds, reason: "本次资料明确各工作面独立，班组、材料和作业空间各自配置，可同时施工" });
const overlapOf = (result) => result.options.find((option) => option.id === optionId);

test("短工期优先比较经审查的单班白班搭接，保持每项1组并相加独立班组人员", () => {
  const result = run([item("a", 1), item("b", 2)], [parallel("a", "b")]);
  assert.equal(result.baselineAssessment.feasible, false);
  assert.equal(result.baselineAssessment.requiredCalendarDays, 8);
  assert.deepEqual(result.options.map((option) => option.id), [optionId, "two-shift", "multi-crew-day"]);
  const overlap = overlapOf(result);
  assert.equal(overlap.staffingMode, optionId);
  assert.equal(overlap.shiftsPerDay, 1);
  assert.equal(overlap.hoursPerShift, 8);
  assert.equal(overlap.finishDate, "2026-10-04");
  assert.equal(overlap.slackDays, 2);
  assert.deepEqual(overlap.workItems.map((entry) => [entry.crewsPerShift, entry.shiftsPerDay, entry.hoursPerShift, entry.totalCrewRosters]), [[1, 1, 8, 1], [1, 1, 8, 1]]);
  assert.deepEqual(overlap.workItems.map((entry) => [entry.startDay, entry.endDay, entry.durationDays]), [[0, 3, 4], [0, 3, 4]]);
  assert.equal(overlap.summary.conservativePeakHeadcount, 8);
  assert.equal(overlap.summary.peakOnShiftHeadcount, 8);
  assert.equal(overlap.summary.totalPersonDays, 32);
  assert.deepEqual(overlap.overlapBasis, [parallel("a", "b")]);
  assert.equal(overlap.overlapBasisTotal, 1);
  assert.equal(overlap.overlapBasisTruncated, false);
  assert.deepEqual(overlap.divisionSchedule.map((division) => [division.startDate, division.endDate]), [["2026-10-01", "2026-10-04"], ["2026-10-01", "2026-10-04"]]);
  for (const originalOption of result.options.filter((option) => option.id !== optionId)) {
    assert.ok(originalOption.workItems[0].endDay < originalOption.workItems[1].startDay, "既有早晚班和多班组方案仍按原分部顺序");
  }
});

test("白班顺序施工工期足够时仍只输出顺序施工，不额外提供搭接", () => {
  const result = run([item("a", 1), item("b", 2)], [parallel("a", "b")], { project: { endDate: "2026-10-08" } });
  assert.deepEqual(result.options.map((option) => option.id), ["sequential"]);
  assert.deepEqual(result.unavailable, []);
  assert.equal(result.options[0].workItems[1].startDate, "2026-10-05");
});

test("钢筋完成后次日才能浇筑，独立工作面搭接不改变FS前置或制造固定养护等待", () => {
  const work = [
    item("steel", 1),
    item("pour", 2, { result: { quantity: 20, dependsOnSequences: [1], dependencyReasons: [{ sequence: 1, reason: "本部位钢筋验收完成后才能浇筑" }] } }),
    item("external", 3),
  ];
  const result = run(work, [parallel("steel", "external"), parallel("pour", "external")]);
  const overlap = overlapOf(result);
  assert.ok(overlap);
  const [steel, pour, external] = overlap.workItems;
  assert.equal(steel.endDate, "2026-10-04");
  assert.equal(pour.startDate, "2026-10-05");
  assert.equal(pour.endDate, "2026-10-06");
  assert.deepEqual(pour.dependsOnSequences, [1]);
  assert.deepEqual(pour.dependencyReasons, work[1].result.dependencyReasons);
  assert.equal(external.startDate, steel.startDate);
  assert.deepEqual(overlap.overlapBasis, [parallel("steel", "external")], "仅保存实际发生时间重叠的配对依据");
});

test("同一工序的工程量不能靠搭接变快，单项白班本身超期则明确不可用", () => {
  const result = run([
    item("long", 1, { result: { quantity: 80 } }),
    item("short", 2, { result: { quantity: 10 } }),
  ], [parallel("long", "short")], { project: { endDate: "2026-10-05" } });
  assert.equal(overlapOf(result), undefined);
  assert.match(result.unavailable.find((option) => option.id === optionId).reason, /1个白班班组仍不能满足.*未增加班组/);
  assert.ok(result.options.some((option) => option.id === "two-shift"));
});

test("没有明确平行依据或未完成GPT审查时，不把无前置关系当作可搭接", () => {
  for (const [groups, allowInterleaved] of [[[], true], [[parallel("a", "b")], false]]) {
    const result = run([item("a", 1), item("b", 2)], groups, { allowInterleaved });
    assert.equal(overlapOf(result), undefined);
    assert.match(result.unavailable.find((option) => option.id === optionId).reason, /缺少GPT明确确认.*不能仅因未设置前置/);
  }
});

test("平行许可不传递：AB和BC的许可不意味着AC可同时施工", () => {
  const work = ["a", "b", "c"].map((id, index) => item(id, index + 1, { result: { quantity: 30 } }));
  const result = run(work, [parallel("a", "b"), parallel("b", "c")]);
  const overlap = overlapOf(result);
  assert.ok(overlap);
  const [a, b, c] = overlap.workItems;
  assert.equal(a.startDay, b.startDay);
  assert.ok(a.endDay < c.startDay);
  assert.equal(overlap.finishDate, "2026-10-06");
  assert.equal(overlap.summary.conservativePeakHeadcount, 8);
  assert.deepEqual(overlap.overlapBasis, [parallel("a", "b")]);
});

test("同一分组3项逐对许可时允许各自班组同时施工，不全项目共用一支班组", () => {
  const work = ["a", "b", "c"].map((id, index) => item(id, index + 1, { result: { quantity: 30 } }));
  const overlap = overlapOf(run(work, [parallel("a", "b", "c")], { project: { endDate: "2026-10-03" } }));
  assert.ok(overlap);
  assert.deepEqual(overlap.workItems.map((entry) => entry.startDay), [0, 0, 0]);
  assert.equal(overlap.summary.conservativePeakHeadcount, 12);
  assert.equal(overlap.summary.totalPersonDays, 36);
  assert.deepEqual(overlap.overlapBasis.map((basis) => basis.itemIds), [["a", "b"], ["a", "c"], ["b", "c"]]);
});

test("明确的分部完成限制优先于平行许可，不因新增搭接方案被移除", () => {
  const work = [item("a", 1, { result: { quantity: 30 } }), item("b", 2, { result: { quantity: 30 } })];
  const result = run(work, [parallel("a", "b")], {
    project: { endDate: "2026-10-04" },
    constraints: new Map([["division-2", { afterDivisionId: "division-1", afterLabel: "1 · 分部1" }]]),
  });
  assert.equal(overlapOf(result), undefined);
  assert.match(result.unavailable.find((option) => option.id === optionId).reason, /仍不能满足工期/);
  for (const option of result.options) {
    assert.ok(option.workItems[0].endDay < option.workItems[1].startDay);
    assert.equal(option.divisionSchedule[1].afterDivision, "1 · 分部1");
  }
});

test("降排水搭接不增加单台日产能，全部泵仍只共配一个电工", () => {
  const pump = (id, sequence, output, quantity) => item(id, sequence, {
    definition: { mode: "equipment_hour", category: "降排水", output, baseOutput: output * 10, crew: {}, equipment: [id] },
    result: { quantity },
  });
  const result = run([pump("pump70", 1, 25, 500), pump("pump140", 2, 80, 1600)], [parallel("pump70", "pump140")], { project: { endDate: "2026-10-03" } });
  const overlap = overlapOf(result);
  assert.ok(overlap);
  assert.deepEqual(overlap.summary.equipmentPeak, { pump70: 1, pump140: 1 });
  assert.deepEqual(overlap.summary.tradePeak, { 电工: 1 });
  assert.deepEqual(overlap.summary.tradePersonDays, { 电工: 2 });
  assert.equal(overlap.summary.totalPersonDays, 2);
  for (const entry of overlap.workItems) {
    assert.equal(entry.requiredUnitsRaw, 1);
    assert.equal(entry.equipmentOperatingHoursPerDay, 10);
    assert.equal(entry.shiftsPerDay, 1);
    assert.equal(entry.durationDays, 2);
  }
});

test("逐日季节和斋月比例继续生效，柱状图与横道图所需日期人数保持一致", () => {
  const currentProject = {
    startDate: "2026-09-29", endDate: "2026-10-03",
    calendarRules: { ramadan: { mode: "custom", ranges: [{ startDate: "2026-10-02", endDate: "2026-10-02" }], factor: 0.5 } },
  };
  const days = enumerateCalendarDays(currentProject);
  assert.deepEqual(days.map((day) => day.factor), [0.7, 0.7, 1, 0.5, 1]);
  const work = [item("a", 1, { result: { quantity: 30 } }), item("b", 2, { result: { quantity: 30 } })];
  const overlap = overlapOf(run(work, [parallel("a", "b")], { project: currentProject }));
  assert.ok(overlap);
  assert.equal(overlap.finishDate, "2026-10-03");
  assert.equal(overlap.summary.totalPersonDays, 40);
  assert.equal(overlap.summary.averageHeadcount, 8);
  for (const entry of overlap.workItems) {
    assert.equal(entry.startDate, days[entry.startDay].date);
    assert.equal(entry.endDate, days[entry.endDay].date);
    assert.equal(entry.durationDays, entry.endDay - entry.startDay + 1);
    assert.equal(entry.activeShifts, entry.durationDays);
    assert.equal(entry.effectiveDays, 3.9);
    assert.deepEqual(entry.peakCrew, { 钢筋工: 4 });
    assert.deepEqual(entry.personDaysByTrade, { 钢筋工: 20 });
  }
});

test("传入的工程量和依赖结果不被新增方案排程修改", () => {
  const work = [item("a", 1), item("b", 2)];
  const snapshot = structuredClone(work);
  run(work, [parallel("a", "b")]);
  assert.deepEqual(work, snapshot);
});

test("日历和调整顺序即便能缩短排程，也不能在没有实际重叠时冒称搭接方案", () => {
  // The A/C divisions interleave technically (A1 -> C1 -> A2), while B is
  // independent. B/A2 have permission, but conservative unapproved-pair order
  // places B before C1, so there is no actual overlap to substantiate this option.
  const work = [
    item("a1", 1, { result: { quantity: 5 } }),
    item("b", 2, { result: { quantity: 1 } }),
    item("c", 3, { result: { quantity: 1, dependsOnSequences: [1] } }),
    item("a2", 4, { result: { quantity: 10, divisionId: "division-1", divisionSequence: 1, dependsOnSequences: [3] } }),
  ];
  const result = run(work, [parallel("b", "a2")], {
    project: {
      endDate: "2026-10-04",
      calendarRules: {
        winter: { factor: 2 },
        ramadan: { mode: "custom", ranges: [{ startDate: "2026-10-03", endDate: "2026-10-03" }], factor: 0.1 },
      },
    },
  });
  assert.equal(result.baselineAssessment.feasible, false);
  assert.equal(overlapOf(result), undefined);
  assert.match(result.unavailable.find((option) => option.id === optionId).reason, /未形成实际工序搭接.*单纯调整顺序/);
});

test("500项全平行时保存前200条配对依据及准确总数，不截断完整排程或原平行许可", () => {
  const work = Array.from({ length: 500 }, (_, index) => item(`work-${index + 1}`, index + 1, { result: { quantity: 1 } }));
  const groups = [parallel(...work.map((entry) => entry.result.itemId))];
  const originalGroups = structuredClone(groups);
  const overlap = overlapOf(run(work, groups, { project: { endDate: project.startDate } }));
  assert.ok(overlap);
  assert.equal(overlap.workItems.length, 500);
  assert.equal(overlap.divisionSchedule.length, 500);
  assert.equal(overlap.summary.calculatedItems, 500);
  assert.equal(overlap.summary.conservativePeakHeadcount, 2000);
  assert.equal(overlap.overlapBasis.length, 200);
  assert.equal(overlap.overlapBasisTotal, 124750);
  assert.equal(overlap.overlapBasisTruncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(overlap), "utf8") < 1_000_000, "保存的方案应保持小于1MB而不是展开全部124750条依据");
  assert.deepEqual(groups, originalGroups);
  assert.ok(overlap.workItems.every((entry) => entry.startDay === 0 && entry.endDay === 0));
});
