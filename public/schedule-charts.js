// Read-only projections of saved scheduling results. No scheduling decisions or
// productivity rates are recalculated here.
const CHART_DAY_MS = 86_400_000;
const CHART_MAX_DAYS = 36_600;

function chartDateValue(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== value) return null;
  return timestamp;
}

function chartDateString(value) {
  return new Date(value).toISOString().slice(0, 10);
}

function chartPositiveCount(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function chartRoles(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([, count]) => chartPositiveCount(count)));
}

function chartAddRole(target, role, count) {
  // Catalog role names are user-maintained. Treat even prototype-named roles
  // as plain data rather than inheriting Object.prototype or setting a prototype.
  const prior = Object.hasOwn(target, role) ? target[role] : 0;
  Object.defineProperty(target, role, { value: prior + count, enumerable: true, writable: true, configurable: true });
}

function chartRange(startDate, endDate) {
  const start = chartDateValue(startDate);
  const end = chartDateValue(endDate);
  if (start === null || end === null || end < start) return null;
  const durationDays = (end - start) / CHART_DAY_MS + 1;
  if (durationDays > CHART_MAX_DAYS) return null;
  return { startDate, endDate, durationDays };
}

function chartItemRange(item, project = {}) {
  if (!item || ["missing_productivity", "unit_mismatch", "unavailable"].includes(item.status)) return null;
  // Actual saved dates win over offsets, including historical results whose
  // startDay/endDay were measured from a different project range.
  if (item.startDate != null || item.endDate != null) return chartRange(item.startDate, item.endDate);
  const projectStart = chartDateValue(project.startDate);
  if (projectStart === null || !Number.isInteger(item.startDay) || !Number.isInteger(item.endDay)
    || item.startDay < 0 || item.endDay < item.startDay || item.endDay >= CHART_MAX_DAYS) return null;
  return chartRange(chartDateString(projectStart + item.startDay * CHART_DAY_MS),
    chartDateString(projectStart + item.endDay * CHART_DAY_MS));
}

export function dateOffset(date, startDate) {
  const value = chartDateValue(date);
  const start = chartDateValue(startDate);
  return value === null || start === null ? null : (value - start) / CHART_DAY_MS;
}

export function getTimelineRange(project = {}, workItems = [], { scope = "active" } = {}) {
  const projectRange = chartRange(project?.startDate, project?.endDate);
  const ranges = (Array.isArray(workItems) ? workItems : [])
    .map((item) => chartItemRange(item, project)).filter(Boolean);
  if (scope === "project" && projectRange) return projectRange;
  if (!ranges.length) return projectRange;
  return chartRange(ranges.reduce((start, range) => range.startDate < start ? range.startDate : start, ranges[0].startDate),
    ranges.reduce((end, range) => range.endDate > end ? range.endDate : end, ranges[0].endDate));
}

export function buildWorkforceDays(workItems = [], option = {}) {
  const project = option.project ?? {};
  const scheduled = (Array.isArray(workItems) ? workItems : []).map((item) => ({ item, range: chartItemRange(item, project) }))
    .filter(({ range }) => range);
  if (!scheduled.length) return [];
  const range = getTimelineRange(project, scheduled.map(({ item }) => item));
  if (!range) return [];
  const startTime = chartDateValue(range.startDate);
  const days = Array.from({ length: range.durationDays }, (_, index) => ({
    date: chartDateString(startTime + index * CHART_DAY_MS), headcount: 0, onShiftHeadcount: 0,
    personDays: 0, roles: {},
  }));
  const shiftRolesByDay = days.map(() => []);
  const pumpDays = new Set();
  for (const { item, range: itemRange } of scheduled) {
    const startIndex = dateOffset(itemRange.startDate, range.startDate);
    const endIndex = dateOffset(itemRange.endDate, range.startDate);
    const isEquipment = item.mode === "equipment_hour";
    if (isEquipment) {
      if (item.category === "降排水") {
        for (let index = startIndex; index <= endIndex; index += 1) pumpDays.add(index);
      }
      // Equipment units are not people. All pumps share one electrician below.
      continue;
    }
    const rawShifts = item.shiftsPerDay ?? option.shiftsPerDay ?? 1;
    const shifts = Number.isInteger(rawShifts) && rawShifts > 0 && rawShifts <= 24 ? rawShifts : 1;
    const hasPerShift = item.crewPerShift && typeof item.crewPerShift === "object" && !Array.isArray(item.crewPerShift);
    const perShift = hasPerShift ? chartRoles(item.crewPerShift)
      : Object.fromEntries(Object.entries(chartRoles(item.peakCrew)).map(([role, count]) => [role, count / shifts]));
    let lastDayShifts = shifts;
    if (Number.isInteger(item.lastDayShifts) && item.lastDayShifts > 0) {
      lastDayShifts = Math.min(shifts, item.lastDayShifts);
    } else if (Number.isInteger(item.activeShifts) && item.activeShifts > 0) {
      lastDayShifts = Math.max(1, Math.min(shifts, item.activeShifts - (itemRange.durationDays - 1) * shifts));
    }
    for (let index = startIndex; index <= endIndex; index += 1) {
      const shiftsWorked = index === endIndex ? lastDayShifts : shifts;
      for (let shift = 0; shift < shiftsWorked; shift += 1) {
        const roster = shiftRolesByDay[index][shift] ??= {};
        for (const [role, count] of Object.entries(perShift)) {
          chartAddRole(days[index].roles, role, count);
          chartAddRole(roster, role, count);
        }
      }
    }
  }
  for (const index of pumpDays) {
    chartAddRole(days[index].roles, "电工", 1);
    const dayShift = shiftRolesByDay[index][0] ??= {};
    chartAddRole(dayShift, "电工", 1);
  }
  return days.map((day, index) => {
    const headcount = Object.values(day.roles).reduce((sum, count) => sum + count, 0);
    const onShiftHeadcount = Math.max(0, ...shiftRolesByDay[index]
      .map((roster) => Object.values(roster).reduce((sum, count) => sum + count, 0)));
    return { ...day, headcount, onShiftHeadcount, personDays: headcount };
  });
}

function chartMonthEnd(timestamp, months = 1) {
  const date = new Date(timestamp);
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + months);
  return date.getTime() - CHART_DAY_MS;
}

export function aggregateWorkforceDays(days = [], {
  startDate, endDate, granularity = "auto", maxBars = 45,
} = {}) {
  const validDays = (Array.isArray(days) ? days : []).filter((day) => chartDateValue(day?.date) !== null);
  const dates = validDays.map((day) => day.date).sort();
  const range = chartRange(startDate ?? dates[0], endDate ?? dates.at(-1));
  const empty = { granularity: "day", bins: [], metricLabel: "每日人数", totalPersonDays: 0, peakHeadcount: 0 };
  if (!range) return empty;
  const limit = Number.isInteger(maxBars) && maxBars > 0 ? maxBars : 45;
  let selected = ["day", "week", "month"].includes(granularity) ? granularity : "auto";
  let monthStep = 1;
  if (selected === "auto") {
    selected = range.durationDays <= limit ? "day" : Math.ceil(range.durationDays / 7) <= limit ? "week" : "month";
    if (selected === "month") {
      const first = new Date(chartDateValue(range.startDate));
      const last = new Date(chartDateValue(range.endDate));
      const months = (last.getUTCFullYear() - first.getUTCFullYear()) * 12 + last.getUTCMonth() - first.getUTCMonth() + 1;
      monthStep = Math.max(1, Math.ceil(months / limit));
    }
  }
  const byDate = new Map(validDays.map((day) => [day.date, day]));
  const bins = [];
  const endTime = chartDateValue(range.endDate);
  let cursor = chartDateValue(range.startDate);
  let totalPersonDays = 0;
  let peakHeadcount = 0;
  while (cursor <= endTime) {
    const binEnd = Math.min(endTime, selected === "month" ? chartMonthEnd(cursor, monthStep)
      : cursor + (selected === "week" ? 6 : 0) * CHART_DAY_MS);
    const bin = { startDate: chartDateString(cursor), endDate: chartDateString(binEnd),
      label: "", peakHeadcount: 0, peakOnShiftHeadcount: 0, personDays: 0, days: 0 };
    for (let time = cursor; time <= binEnd; time += CHART_DAY_MS) {
      const day = byDate.get(chartDateString(time));
      const headcount = chartPositiveCount(day?.headcount);
      const personDays = day?.personDays == null ? headcount : chartPositiveCount(day.personDays);
      bin.peakHeadcount = Math.max(bin.peakHeadcount, headcount);
      bin.peakOnShiftHeadcount = Math.max(bin.peakOnShiftHeadcount, chartPositiveCount(day?.onShiftHeadcount));
      bin.personDays += personDays;
      bin.days += 1;
    }
    bin.label = bin.startDate === bin.endDate ? bin.startDate : `${bin.startDate}—${bin.endDate}`;
    bins.push(bin);
    totalPersonDays += bin.personDays;
    peakHeadcount = Math.max(peakHeadcount, bin.peakHeadcount);
    cursor = binEnd + CHART_DAY_MS;
  }
  return { granularity: selected, bins, metricLabel: selected === "day" ? "每日人数" : "周期峰值人数",
    totalPersonDays, peakHeadcount };
}
