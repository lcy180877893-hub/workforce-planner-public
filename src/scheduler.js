import { enumerateCalendarDays } from "../public/calendar.js";

const SCENARIOS = {
  sequential: { id: "sequential", staffingMode: "single-crew-day", name: "顺序施工", shiftsPerDay: 1, hoursPerShift: 8, description: "每道工序配置1个白班班组，按分部顺序及实际技术前置施工。" },
  singleCrewOverlap: { id: "single-crew-day-overlap", staffingMode: "single-crew-day-overlap", name: "单班组白班多工序搭接", shiftsPerDay: 1, hoursPerShift: 8, description: "每道工序各配1个8小时白班班组，仅在GPT已确认独立工作面和可平行条件的工序之间搭接；不增加单项班组或跳过技术前置。" },
  multiCrewOverlap: { id: "multi-crew-day-overlap", staffingMode: "multi-crew-day-overlap", name: "多班组白班多工序搭接", shiftsPerDay: 1, hoursPerShift: 8, description: "单班组白班搭接仍不足时，在同一已确认可平行条件和技术前置下反算各工序的整数白班班组；新增班组所需的工作面、人员、设备和材料供应能力仍须现场核实，本方案为条件性资源估算。" },
  twoShift: { id: "two-shift", staffingMode: "two-shift", name: "单班组早晚班", shiftsPerDay: 2, hoursPerShift: 8, description: "每道工序早、晚班各1个班组，两套人员；不改变施工先后顺序。" },
  multiCrew: { id: "multi-crew-day", staffingMode: "multi-crew-day", name: "多班组白班", shiftsPerDay: 1, hoursPerShift: 8, description: "按工期反算每道工序所需的整数白班班组，不靠跨分部穿插赶工。" },
};
const MAX_RESOURCE_UNITS = 1_000_000;
const MAX_BASELINE_FORECAST_DAYS = 36_600;
const MAX_SAVED_OVERLAP_BASIS = 200;

function technicalOrder(entries, dependencies) {
  const pending = entries.filter((entry) => entry.definition);
  const ordered = [];
  const completed = new Set();
  while (pending.length) {
    const index = pending.findIndex((entry) => [...(dependencies?.get(entry.result.sequence) ?? entry.result.dependsOnSequences ?? [])]
      .every((sequence) => completed.has(sequence)));
    if (index < 0) {
      const error = new Error("工序技术前后置存在循环或缺少可排程工效，无法生成施工顺序");
      error.statusCode = 400;
      throw error;
    }
    const [entry] = pending.splice(index, 1);
    ordered.push(entry);
    completed.add(entry.result.sequence);
  }
  return ordered;
}

function divisionOrder(entries, constraints, allowInterleaved = false) {
  const groups = new Map();
  for (const entry of entries) {
    if (!entry.definition) continue;
    const divisionId = entry.result.divisionId;
    if (!groups.has(divisionId)) groups.set(divisionId, {
      divisionId, division: entry.result.division, entries: [], prerequisites: new Set(),
    });
    groups.get(divisionId).entries.push(entry);
  }
  const bySequence = new Map(entries.map((entry) => [entry.result.sequence, entry]));
  for (const group of groups.values()) {
    for (const entry of group.entries) {
      for (const sequence of entry.result.dependsOnSequences ?? []) {
        const predecessor = bySequence.get(sequence);
        if (predecessor && predecessor.result.divisionId !== group.divisionId) {
          group.prerequisites.add(predecessor.result.divisionId);
        }
      }
    }
    const constraint = constraints.get(group.divisionId);
    if (constraint) {
      if (!groups.has(constraint.afterDivisionId)) {
        const error = new Error(`分部 ${group.entries[0].result.divisionSequence} 的限制目标存在缺少可用工效的工序，无法判断何时全部完成`);
        error.statusCode = 400;
        throw error;
      }
      group.prerequisites.add(constraint.afterDivisionId);
    }
  }
  const ordered = [];
  const completed = new Set();
  const pending = [...groups.values()];
  if (allowInterleaved) {
    // A valid task graph can span divisions in both directions (e.g. structural
    // work and electrical embeds). Keep those divisions in one scheduling stage,
    // with task dependencies deciding their actual order.
    const indices = new Map();
    const low = new Map();
    const stack = [];
    const onStack = new Set();
    const components = [];
    let next = 0;
    function visit(id) {
      indices.set(id, next);
      low.set(id, next++);
      stack.push(id);
      onStack.add(id);
      for (const prerequisite of groups.get(id).prerequisites) {
        if (!indices.has(prerequisite)) {
          visit(prerequisite);
          low.set(id, Math.min(low.get(id), low.get(prerequisite)));
        } else if (onStack.has(prerequisite)) low.set(id, Math.min(low.get(id), indices.get(prerequisite)));
      }
      if (low.get(id) === indices.get(id)) {
        const component = [];
        let member;
        do {
          member = stack.pop();
          onStack.delete(member);
          component.push(groups.get(member));
        } while (member !== id);
        component.sort((a, b) => a.entries[0].result.divisionSequence - b.entries[0].result.divisionSequence);
        components.push(component);
      }
    }
    for (const id of groups.keys()) if (!indices.has(id)) visit(id);
    const owner = new Map(components.flatMap((component, index) => component.map((group) => [group.divisionId, index])));
    const remaining = components.map((component, id) => ({ id, component,
      prerequisites: new Set(component.flatMap((group) => [...group.prerequisites].map((key) => owner.get(key))).filter((key) => key !== id)),
      first: Math.min(...component.map((group) => group.entries[0].result.divisionSequence)),
    })).sort((a, b) => a.first - b.first);
    let stage = 0;
    while (remaining.length) {
      const index = remaining.findIndex((component) => [...component.prerequisites].every((id) => completed.has(id)));
      if (index < 0) throw new Error("无法排列项目施工阶段");
      const [component] = remaining.splice(index, 1);
      for (const group of component.component) ordered.push({ ...group, stage });
      completed.add(component.id);
      stage += 1;
    }
    return ordered;
  }
  while (pending.length) {
    const index = pending.findIndex((group) => [...group.prerequisites].every((id) => completed.has(id)));
    if (index < 0) {
      const error = new Error("分部限制或技术前置形成循环，无法确定分部施工顺序；请核查分部划分和限制");
      error.statusCode = 400;
      throw error;
    }
    const [group] = pending.splice(index, 1);
    ordered.push({ ...group, stage: ordered.length });
    completed.add(group.divisionId);
  }
  return ordered;
}

function round(value, digits = 2) {
  const factor = 10 ** digits;
  if (!Number.isFinite(value * factor)) return value;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function add(target, key, value) {
  target[key] = (target[key] ?? 0) + value;
}

function staffing(definition, teams) {
  if (definition.mode === "equipment_hour") {
    return {
      dailyOutput: definition.output * 10 * teams,
      people: {},
      equipment: { [definition.equipment?.[0] ?? definition.name]: teams },
    };
  }
  if (definition.mode === "role_productivity") {
    const targetOutput = definition.baseOutput * teams;
    const people = Object.fromEntries(
      Object.entries(definition.roleProductivity).map(([role, rate]) => [role, Math.ceil(targetOutput / rate - 1e-12)]),
    );
    return {
      dailyOutput: Math.min(...Object.entries(people).map(([role, count]) => count * definition.roleProductivity[role])),
      people,
      equipment: {},
    };
  }
  return {
    dailyOutput: definition.output * teams,
    people: Object.fromEntries(Object.entries(definition.crew).map(([role, count]) => [role, count * teams])),
    equipment: {},
  };
}

function invalidSchedule(message) {
  const error = new Error(message);
  error.statusCode = 400;
  throw error;
}

// The original resource options retain the same division stages. The reviewed
// overlap option separately removes only those artificial whole-stage edges.
function scheduleGraph(prepared, constraints, allowInterleaved, includeDivisionStages = true) {
  technicalOrder(prepared);
  const divisions = divisionOrder(prepared, constraints, allowInterleaved);
  const stages = new Map();
  for (const group of divisions) stages.set(group.stage, [...(stages.get(group.stage) ?? []), ...group.entries]);
  const dependencies = new Map(prepared.filter((entry) => entry.definition)
    .map((entry) => [entry.result.sequence, new Set(entry.result.dependsOnSequences ?? [])]));
  for (const group of divisions) {
    const preceding = includeDivisionStages ? stages.get(group.stage - 1) ?? [] : [];
    const constraint = constraints.get(group.divisionId);
    const targets = constraint ? prepared.filter((entry) =>
      entry.result.divisionId === constraint.afterDivisionId
      && (!constraint.afterSubitemId || entry.result.subitemId === constraint.afterSubitemId)
      && (!constraint.afterItemId || entry.result.itemId === constraint.afterItemId)) : [];
    if (constraint && (!targets.length || targets.some((entry) => !entry.definition))) {
      invalidSchedule("分部限制目标存在缺少可用工效的工序，无法判断何时全部完成");
    }
    for (const entry of group.entries) {
      const required = dependencies.get(entry.result.sequence);
      for (const previous of [...preceding, ...targets]) required.add(previous.result.sequence);
    }
  }
  return { divisions, dependencies, ordered: technicalOrder(prepared, dependencies) };
}

function reviewedOverlapGraph(prepared, constraints, allowInterleaved, parallelGroups) {
  // Absence of an FS edge does not establish that two workfaces can overlap.
  // Permission is pairwise: [A,B] plus [B,C] never authorizes [A,C].
  if (!allowInterleaved || !Array.isArray(parallelGroups)) return null;
  const graph = scheduleGraph(prepared, constraints, allowInterleaved, false);
  const byId = new Map(graph.ordered.map((entry) => [String(entry.result.itemId || `item-${entry.result.sequence}`), entry]));
  const pairKey = (a, b) => JSON.stringify(a < b ? [a, b] : [b, a]);
  const allowedPairs = new Set();
  const overlapBasis = new Map();
  for (const group of parallelGroups) {
    if (!Array.isArray(group?.itemIds) || group.itemIds.length < 2
      || typeof group.reason !== "string" || !group.reason.trim()
      || new Set(group.itemIds).size !== group.itemIds.length
      || group.itemIds.some((id) => !byId.has(id))) continue;
    for (let first = 0; first < group.itemIds.length; first += 1) {
      for (let second = first + 1; second < group.itemIds.length; second += 1) {
        const key = pairKey(byId.get(group.itemIds[first]).result.sequence, byId.get(group.itemIds[second]).result.sequence);
        allowedPairs.add(key);
        if (!overlapBasis.has(key)) overlapBasis.set(key, { itemIds: [group.itemIds[first], group.itemIds[second]], reason: group.reason.trim() });
      }
    }
  }
  if (!allowedPairs.size) return null;
  // Start from a valid topological order of all technical and explicit division
  // targets. Serializing uncertain pairs only forward in that order cannot form
  // a cycle or weaken a known predecessor. This deliberately conservative order
  // is not a claim of a globally optimal workface arrangement.
  for (let first = 0; first < graph.ordered.length; first += 1) {
    for (let second = first + 1; second < graph.ordered.length; second += 1) {
      const before = graph.ordered[first].result.sequence;
      const after = graph.ordered[second].result.sequence;
      if (!allowedPairs.has(pairKey(before, after))) graph.dependencies.get(after).add(before);
    }
  }
  graph.ordered = technicalOrder(prepared, graph.dependencies);
  graph.overlapBasis = overlapBasis;
  return graph;
}

function actualOverlapBasis(graph, schedule) {
  const scheduledById = new Map(schedule.workItems.map((item) => [String(item.itemId || `item-${item.sequence}`), item]));
  // Keep history/tool responses bounded without changing the complete schedule
  // or the underlying compact workflow.parallelGroups permission.
  const overlapBasis = [];
  let overlapBasisTotal = 0;
  for (const basis of graph.overlapBasis.values()) {
    const [first, second] = basis.itemIds.map((id) => scheduledById.get(id));
    if (!first || !second || first.startDay > second.endDay || second.startDay > first.endDay) continue;
    overlapBasisTotal += 1;
    if (overlapBasis.length < MAX_SAVED_OVERLAP_BASIS) overlapBasis.push(basis);
  }
  return { overlapBasis, overlapBasisTotal, overlapBasisTruncated: overlapBasisTotal > overlapBasis.length };
}

function capacityPrefix(days) {
  const prefix = [0];
  prefix.lostIncrements = false;
  for (const day of days) {
    const next = prefix.at(-1) + day.factor;
    if (next === prefix.at(-1)) prefix.lostIncrements = true;
    prefix.push(next);
  }
  return prefix;
}

function capacityBetween(prefix, days, start, end) {
  const delta = prefix[end] - prefix[start];
  if (!prefix.lostIncrements && delta > Number.EPSILON * (Math.abs(prefix[end]) + Math.abs(prefix[start])) * 8) return delta;
  let capacity = 0;
  for (let index = start; index < end; index += 1) capacity += days[index].factor;
  return capacity;
}

function firstCapacityDay(prefix, days, start, target) {
  // Relative tolerance does not turn a tiny positive quantity into zero work.
  const enough = (end) => capacityBetween(prefix, days, start, end + 1) >= target * (1 - 1e-12);
  if (start >= prefix.length - 1 || !enough(prefix.length - 2)) return null;
  let lower = start;
  let upper = prefix.length - 2;
  while (lower < upper) {
    const middle = Math.floor((lower + upper) / 2);
    if (enough(middle)) upper = middle;
    else lower = middle + 1;
  }
  return lower;
}

function staffingUnits(value) {
  const units = Math.max(1, Math.ceil(value - 1e-12));
  if (!Number.isSafeInteger(units) || units > MAX_RESOURCE_UNITS) {
    invalidSchedule("所需班组或设备数量超出可测算范围，请核查工程量、工效比例及可用工作面");
  }
  return units;
}

function simulate(prepared, days, graph, scenario, units = new Map(), details = true) {
  const prefix = capacityPrefix(days);
  const bySequence = new Map();
  for (const original of graph.ordered) {
    const teams = staffingUnits(units.get(original.result.sequence) ?? 1);
    const team = staffing(original.definition, teams);
    const shifts = original.definition.mode === "equipment_hour" ? 1 : scenario.shiftsPerDay;
    if (!Number.isFinite(team.dailyOutput) || team.dailyOutput <= 0
      || Object.values(team.people).some((count) => !Number.isFinite(count) || count <= 0)) {
      invalidSchedule("班组产能或人员数量无效，请核查工效");
    }
    const predecessors = [...graph.dependencies.get(original.result.sequence)].map((sequence) => bySequence.get(sequence));
    if (predecessors.some((entry) => !entry || entry.endIndex === null)) return { feasible: false };
    const startIndex = Math.max(0, ...predecessors.map((entry) => entry.endIndex + 1));
    const equivalent = original.result.quantity / team.dailyOutput;
    const endIndex = firstCapacityDay(prefix, days, startIndex, equivalent / shifts);
    if (endIndex === null) return { feasible: false };
    const priorCapacity = capacityBetween(prefix, days, startIndex, endIndex) * shifts;
    const lastDayShifts = Math.max(1, Math.min(shifts,
      Math.ceil((equivalent * (1 - 1e-12) - priorCapacity) / days[endIndex].factor)));
    bySequence.set(original.result.sequence, {
      ...original, teams, staffing: team, shifts, startIndex, endIndex, lastDayShifts,
      activeDays: endIndex - startIndex + 1,
      activeShifts: (endIndex - startIndex) * shifts + lastDayShifts,
      effectiveDays: priorCapacity + days[endIndex].factor * lastDayShifts,
    });
  }
  const scheduled = [...bySequence.values()];
  const finishIndex = scheduled.length ? Math.max(...scheduled.map((entry) => entry.endIndex)) : null;
  if (!details) return { feasible: true, finishIndex };

  const tradePeak = {};
  const tradePeakPerShift = {};
  const tradePersonDays = {};
  const equipmentPeak = {};
  let peakHeadcount = 0;
  let peakOnShiftHeadcount = 0;
  for (let dayIndex = 0; dayIndex <= (finishIndex ?? -1); dayIndex += 1) {
    const dailyPeople = {};
    const dailyEquipment = {};
    const shiftPeople = Array.from({ length: scenario.shiftsPerDay }, () => ({}));
    let dewateringActive = false;
    for (const entry of scheduled) {
      if (dayIndex < entry.startIndex || dayIndex > entry.endIndex) continue;
      const shiftsWorked = dayIndex === entry.endIndex ? entry.lastDayShifts : entry.shifts;
      for (let shift = 0; shift < shiftsWorked; shift += 1) {
        for (const [role, count] of Object.entries(entry.staffing.people)) {
          add(dailyPeople, role, count);
          add(shiftPeople[shift], role, count);
        }
      }
      for (const [name, count] of Object.entries(entry.staffing.equipment)) add(dailyEquipment, name, count);
      if (entry.definition.mode === "equipment_hour" && entry.definition.category === "降排水") dewateringActive = true;
    }
    // The user's pump rule is one electrician for all pumps together, not per pump or labor shift.
    if (dewateringActive) {
      add(dailyPeople, "电工", 1);
      add(shiftPeople[0], "电工", 1);
    }
    for (const [role, count] of Object.entries(dailyPeople)) {
      add(tradePersonDays, role, count);
      tradePeak[role] = Math.max(tradePeak[role] ?? 0, count);
    }
    for (const people of shiftPeople) {
      for (const [role, count] of Object.entries(people)) tradePeakPerShift[role] = Math.max(tradePeakPerShift[role] ?? 0, count);
      peakOnShiftHeadcount = Math.max(peakOnShiftHeadcount, Object.values(people).reduce((sum, count) => sum + count, 0));
    }
    for (const [name, count] of Object.entries(dailyEquipment)) equipmentPeak[name] = Math.max(equipmentPeak[name] ?? 0, count);
    peakHeadcount = Math.max(peakHeadcount, Object.values(dailyPeople).reduce((sum, count) => sum + count, 0));
  }

  const workItems = prepared.map((original) => {
    if (!original.definition) return { ...original.result };
    const entry = bySequence.get(original.result.sequence);
    const crewPerShift = entry.staffing.people;
    const peakCrew = Object.fromEntries(Object.entries(crewPerShift).map(([role, count]) => [role, count * entry.shifts]));
    return {
      ...entry.result,
      ...(entry.definition.mode === "equipment_hour"
        ? { requiredEquipment: entry.staffing.equipment, requiredUnitsRaw: entry.teams, equipmentOperatingHoursPerDay: 10 }
        : entry.definition.mode === "role_productivity"
          ? { roleProductivity: entry.definition.roleProductivity }
          : {
            requiredCrews: entry.teams, totalCrewRosters: entry.teams * entry.shifts,
            standardCrewSize: Object.values(entry.definition.crew).reduce((sum, count) => sum + count, 0),
          }),
      crewsPerShift: entry.teams,
      shiftsPerDay: entry.shifts,
      hoursPerShift: entry.definition.mode === "equipment_hour" ? null : 8,
      crewPerShift,
      peakCrew,
      personDaysByTrade: Object.fromEntries(Object.entries(crewPerShift).map(([role, count]) => [role, round(count * entry.activeShifts)])),
      startDate: days[entry.startIndex].date,
      endDate: days[entry.endIndex].date,
      startDay: entry.startIndex,
      endDay: entry.endIndex,
      durationDays: entry.activeDays,
      activeShifts: entry.activeShifts,
      lastDayShifts: entry.lastDayShifts,
      effectiveDays: round(entry.effectiveDays),
    };
  });
  const divisionSchedule = graph.divisions.map((group) => {
    const entries = group.entries.map((entry) => bySequence.get(entry.result.sequence));
    return {
      divisionId: group.divisionId, division: group.division,
      divisionRemark: group.entries[0].result.divisionRemark || "",
      divisionSequence: group.entries[0].result.divisionSequence,
      afterDivision: null,
      startDate: days[Math.min(...entries.map((entry) => entry.startIndex))].date,
      endDate: days[Math.max(...entries.map((entry) => entry.endIndex))].date,
    };
  });
  const totalPersonDays = Object.values(tradePersonDays).reduce((sum, count) => sum + count, 0);
  if (!Number.isFinite(totalPersonDays)) invalidSchedule("总人日超出可测算范围，请核查输入");
  return {
    feasible: true,
    finishDate: finishIndex === null ? null : days[finishIndex].date,
    slackDays: finishIndex === null ? null : days.length - finishIndex - 1,
    workItems, divisionSchedule,
    summary: {
      calculatedItems: scheduled.length, missingItems: prepared.length - scheduled.length,
      totalPersonDays: round(totalPersonDays), averageHeadcount: round(totalPersonDays / days.length),
      conservativePeakHeadcount: round(peakHeadcount), peakOnShiftHeadcount: round(peakOnShiftHeadcount),
      tradePeak: Object.fromEntries(Object.entries(tradePeak).map(([role, count]) => [role, round(count)])),
      tradePeakPerShift: Object.fromEntries(Object.entries(tradePeakPerShift).map(([role, count]) => [role, round(count)])),
      tradePersonDays: Object.fromEntries(Object.entries(tradePersonDays).map(([role, count]) => [role, round(count)])),
      equipmentPeak,
    },
  };
}

function baselineAssessment(prepared, days, graph, baseline, project) {
  let finishDate = baseline.finishDate ?? null;
  let requiredCalendarDays = baseline.feasible ? (finishDate
    ? Math.round((Date.parse(finishDate) - Date.parse(days[0].date)) / 86_400_000) + 1 : 0) : null;
  if (!baseline.feasible && project) {
    const rules = project.calendarRules ?? {};
    const minFactor = Math.min(rules.winter?.factor ?? 1, rules.summer?.factor ?? 0.7, rules.ramadan?.factor ?? 0.5);
    const equivalent = graph.ordered.reduce((sum, entry) => sum + entry.result.quantity / staffing(entry.definition, 1).dailyOutput, 0);
    const bound = Math.ceil(equivalent / minFactor) + graph.ordered.length;
    if (Number.isSafeInteger(bound) && bound <= MAX_BASELINE_FORECAST_DAYS) {
      const endTime = Date.parse(days[0].date) + Math.max(days.length, bound) * 86_400_000;
      const end = new Date(endTime).toISOString().slice(0, 10);
      if (/^\d{4}-\d{2}-\d{2}$/.test(end)) {
        const extended = enumerateCalendarDays({ ...project, endDate: end });
        const forecast = simulate(prepared, extended, graph, SCENARIOS.sequential, new Map(), false);
        if (forecast.feasible) {
          finishDate = extended[forecast.finishIndex]?.date ?? null;
          requiredCalendarDays = forecast.finishIndex === null ? 0 : forecast.finishIndex + 1;
        }
      }
    }
  }
  const overrunDays = requiredCalendarDays === null ? null : Math.max(0, requiredCalendarDays - days.length);
  const partial = prepared.some((entry) => !entry.definition) ? "（仅含已匹配可用工效的工序，缺项未计入）" : "";
  const reason = baseline.feasible ? "每道工序1个白班班组可在项目施工时间内完成" + partial
    : requiredCalendarDays === null
      ? "每道工序1个白班班组无法满足工期；基准完工日期超出有限预测范围，未编造完工时间" + partial
      : "每道工序1个白班班组需" + requiredCalendarDays + "个日历天，超出项目工期" + overrunDays + "天" + partial;
  return { feasible: baseline.feasible, finishDate, requiredCalendarDays, availableCalendarDays: days.length, overrunDays, reason,
    assessedItems: graph.ordered.length, missingItems: prepared.length - graph.ordered.length,
    isComplete: prepared.length === graph.ordered.length };
}

function smallestDayCrewSchedule(prepared, days, effectiveDays, graph, scenario = SCENARIOS.multiCrew) {
  const limits = new Map(graph.ordered.map((entry) => [entry.result.sequence, MAX_RESOURCE_UNITS]));
  if (!simulate(prepared, days, graph, scenario, limits, false).feasible) {
    invalidSchedule("即使增加白班班组或设备，当前工期仍无法容纳必须逐日完成的施工顺序，或所需资源超出测算范围");
  }
  const allocation = (scale) => new Map(graph.ordered.map((entry) => [entry.result.sequence,
    staffingUnits(Math.min(MAX_RESOURCE_UNITS, entry.result.quantity / entry.definition.baseOutput / effectiveDays * scale))]));
  let lower = 0;
  let upper = 1;
  let selected;
  while (true) {
    let units;
    try { units = allocation(upper); } catch (error) {
      if (error.statusCode !== 400) throw error;
      units = limits;
    }
    if (simulate(prepared, days, graph, scenario, units, false).feasible) {
      selected = units;
      break;
    }
    lower = upper;
    upper *= 2;
    if (!Number.isFinite(upper)) invalidSchedule("无法反算有效班组数量，请核查工期与工效");
  }
  // Proportional search followed by per-task reductions avoids adding crews to
  // short tasks unnecessarily. This is a feasible heuristic, not a global optimum.
  for (let iteration = 0; iteration < 32; iteration += 1) {
    const middle = (lower + upper) / 2;
    let units;
    try { units = allocation(middle); } catch { lower = middle; continue; }
    if (simulate(prepared, days, graph, scenario, units, false).feasible) {
      upper = middle;
      selected = units;
    } else lower = middle;
  }
  for (const entry of graph.ordered) {
    let min = 1;
    let max = selected.get(entry.result.sequence);
    while (min < max) {
      const middle = Math.floor((min + max) / 2);
      const trial = new Map(selected).set(entry.result.sequence, middle);
      if (simulate(prepared, days, graph, scenario, trial, false).feasible) max = middle;
      else min = middle + 1;
    }
    selected.set(entry.result.sequence, min);
  }
  return simulate(prepared, days, graph, scenario, selected);
}

export function buildScheduleOptions(prepared, days, effectiveDays, constraints = new Map(), { allowInterleaved = false, project, parallelGroups = [] } = {}) {
  const graph = scheduleGraph(prepared, constraints, allowInterleaved);
  const baseline = simulate(prepared, days, graph, SCENARIOS.sequential);
  const assessment = baselineAssessment(prepared, days, graph, baseline, project);
  const addConstraintLabels = (schedule) => ({
    ...schedule,
    divisionSchedule: schedule.divisionSchedule.map((group) => ({ ...group, afterDivision: constraints.get(group.divisionId)?.afterLabel ?? null })),
  });
  if (baseline.feasible) {
    return { options: [{ ...SCENARIOS.sequential, ...addConstraintLabels(baseline) }], unavailable: [], baselineAssessment: assessment };
  }
  const options = [];
  const unavailable = [{ id: "sequential", name: "顺序施工", reason: assessment.reason }];
  const overlapGraph = reviewedOverlapGraph(prepared, constraints, allowInterleaved, parallelGroups);
  if (!overlapGraph) {
    for (const scenario of [SCENARIOS.singleCrewOverlap, SCENARIOS.multiCrewOverlap]) unavailable.push({ id: scenario.id, name: scenario.name,
      reason: "缺少GPT明确确认的可平行工序及独立工作面依据，不能仅因未设置前置就默认搭接；请补充条件并重新判断" });
  } else {
    const overlap = simulate(prepared, days, overlapGraph, SCENARIOS.singleCrewOverlap);
    if (overlap.feasible) {
      const basis = actualOverlapBasis(overlapGraph, overlap);
      if (basis.overlapBasisTotal) options.push({ ...SCENARIOS.singleCrewOverlap, ...addConstraintLabels(overlap), ...basis });
      else unavailable.push({ id: SCENARIOS.singleCrewOverlap.id, name: SCENARIOS.singleCrewOverlap.name,
        reason: "已确认的平行条件受到技术前置或分部完成限制，排程中未形成实际工序搭接，未将单纯调整顺序冒称为搭接方案" });
    } else {
      unavailable.push({ id: SCENARIOS.singleCrewOverlap.id, name: SCENARIOS.singleCrewOverlap.name,
        reason: "按已确认可平行条件搭接后，每道工序1个白班班组仍不能满足工期；未增加班组、拆分工程量或放松技术前置，未明确可平行的工序仍顺序施工" });
      try {
        const multiOverlap = smallestDayCrewSchedule(prepared, days, effectiveDays, overlapGraph, SCENARIOS.multiCrewOverlap);
        const basis = actualOverlapBasis(overlapGraph, multiOverlap);
        if (basis.overlapBasisTotal && multiOverlap.workItems.some((entry) => entry.crewsPerShift > 1)) {
          options.push({ ...SCENARIOS.multiCrewOverlap, ...addConstraintLabels(multiOverlap), ...basis });
        } else unavailable.push({ id: SCENARIOS.multiCrewOverlap.id, name: SCENARIOS.multiCrewOverlap.name,
          reason: "增加班组后仍受技术前置或分部完成限制，未形成实际多班组工序搭接，未将顺序赶工冒称为搭接方案" });
      } catch (error) {
        if (error.statusCode !== 400) throw error;
        unavailable.push({ id: SCENARIOS.multiCrewOverlap.id, name: SCENARIOS.multiCrewOverlap.name, reason: error.message });
      }
    }
  }
  const twoShift = simulate(prepared, days, graph, SCENARIOS.twoShift);
  if (twoShift.feasible) options.push({ ...SCENARIOS.twoShift, ...addConstraintLabels(twoShift) });
  else unavailable.push({ id: "two-shift", name: "单班组早晚班", reason: "早晚班各1个班组仍不能满足工期；未跳过前置顺序，设备仍按原日运转时数计算" });
  try {
    options.push({ ...SCENARIOS.multiCrew, ...addConstraintLabels(smallestDayCrewSchedule(prepared, days, effectiveDays, graph)) });
  } catch (error) {
    if (error.statusCode !== 400) throw error;
    unavailable.push({ id: "multi-crew-day", name: "多班组白班", reason: error.message });
  }
  if (!options.length) invalidSchedule("所有班组方案均无法满足项目施工时间。" + unavailable.map((option) => option.reason).join("；"));
  return { options, unavailable, baselineAssessment: assessment };
}
