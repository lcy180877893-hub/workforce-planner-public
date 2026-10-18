export const DEFAULT_CALENDAR_RULES = Object.freeze({
  winter: { start: "10-01", end: "05-31", factor: 1 },
  summer: { start: "06-01", end: "09-30", factor: 0.7 },
  ramadan: { mode: "auto", ranges: [], factor: 0.5 },
});

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const hijriMonthFormatter = new Intl.DateTimeFormat(
  "en-US-u-ca-islamic-umalqura-nu-latn",
  { month: "numeric", timeZone: "UTC" },
);

function invalid(message) {
  const error = new Error(message);
  error.statusCode = 400;
  throw error;
}

function round(value, digits = 2) {
  const scale = 10 ** digits;
  return Math.round((value + Number.EPSILON) * scale) / scale;
}

function parseDate(value, label) {
  const text = String(value ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) invalid(`${label}必须使用 YYYY-MM-DD 格式`);
  const date = new Date(`${text}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== text) {
    invalid(`${label}不是有效日期`);
  }
  return date;
}

function parseMonthDay(value, label) {
  const text = String(value ?? "").trim();
  if (!/^\d{2}-\d{2}$/.test(text)) invalid(`${label}须填写为 MM-DD，例如 06-01`);
  parseDate(`2000-${text}`, label);
  return text;
}

function parseFactor(value, label) {
  const factor = Number(value);
  if (value === "" || value === null || value === undefined || !Number.isFinite(factor) || factor <= 0 || factor > 2) {
    invalid(`${label}工效比例须大于0%且不超过200%`);
  }
  return factor;
}

function annualRangeIncludes(monthDay, range) {
  return range.start <= range.end
    ? monthDay >= range.start && monthDay <= range.end
    : monthDay >= range.start || monthDay <= range.end;
}

function validateSeasonCoverage(winter, summer) {
  for (const year of [2000, 2001]) {
    for (
      let time = Date.UTC(year, 0, 1);
      time < Date.UTC(year + 1, 0, 1);
      time += MS_PER_DAY
    ) {
      const monthDay = new Date(time).toISOString().slice(5, 10);
      const matches = Number(annualRangeIncludes(monthDay, winter)) + Number(annualRangeIncludes(monthDay, summer));
      if (matches !== 1) invalid("冬季与夏季日期须互不重叠，并覆盖全年所有日期");
    }
  }
}

function ruleObject(value, label) {
  if (value === undefined) return {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    invalid(`${label}规则格式不正确`);
  }
  return value;
}

export function resolveCalendarRules(input) {
  if (input !== undefined && (input === null || typeof input !== "object" || Array.isArray(input))) {
    invalid("自定义日历规则格式不正确");
  }
  const custom = input !== undefined;
  const winterInput = ruleObject(input?.winter, "冬季");
  const summerInput = ruleObject(input?.summer, "夏季");
  const ramadanInput = ruleObject(input?.ramadan, "斋月");
  const winter = {
    start: parseMonthDay(winterInput.start ?? DEFAULT_CALENDAR_RULES.winter.start, "冬季开始日期"),
    end: parseMonthDay(winterInput.end ?? DEFAULT_CALENDAR_RULES.winter.end, "冬季结束日期"),
    factor: parseFactor(winterInput.factor ?? DEFAULT_CALENDAR_RULES.winter.factor, "冬季"),
  };
  const summer = {
    start: parseMonthDay(summerInput.start ?? DEFAULT_CALENDAR_RULES.summer.start, "夏季开始日期"),
    end: parseMonthDay(summerInput.end ?? DEFAULT_CALENDAR_RULES.summer.end, "夏季结束日期"),
    factor: parseFactor(summerInput.factor ?? DEFAULT_CALENDAR_RULES.summer.factor, "夏季"),
  };
  validateSeasonCoverage(winter, summer);

  const mode = ramadanInput.mode ?? DEFAULT_CALENDAR_RULES.ramadan.mode;
  if (!["auto", "custom"].includes(mode)) invalid("斋月日期方式必须选择自动识别或手动填写");
  const ranges = mode === "custom" ? ramadanInput.ranges : [];
  if (mode === "custom" && (!Array.isArray(ranges) || !ranges.length)) {
    invalid("请至少填写一段斋月起止日期");
  }
  const normalizedRanges = ranges.map((range, index) => {
    const startDate = parseDate(range?.startDate, `第${index + 1}段斋月开始日期`);
    const endDate = parseDate(range?.endDate, `第${index + 1}段斋月结束日期`);
    if (endDate < startDate) invalid(`第${index + 1}段斋月结束日期不能早于开始日期`);
    return { startDate: range.startDate, endDate: range.endDate };
  });
  return {
    source: custom ? "custom" : "default",
    winter,
    summer,
    ramadan: {
      mode,
      ranges: normalizedRanges,
      factor: parseFactor(ramadanInput.factor ?? DEFAULT_CALENDAR_RULES.ramadan.factor, "斋月"),
    },
  };
}

function isRamadan(date, rules) {
  if (rules.mode === "custom") {
    const day = date.toISOString().slice(0, 10);
    return rules.ranges.some((range) => day >= range.startDate && day <= range.endDate);
  }
  const month = hijriMonthFormatter.formatToParts(date).find((part) => part.type === "month")?.value;
  return Number(month) === 9;
}

function describeRules(rules) {
  const percent = (factor) => `${round(factor * 100, 2)}%`;
  const ramadanDates = rules.ramadan.mode === "auto"
    ? "按沙特乌姆古拉历自动识别"
    : rules.ramadan.ranges.map((range) => `${range.startDate}至${range.endDate}`).join("、");
  return `冬季每年${rules.winter.start}至${rules.winter.end}（${percent(rules.winter.factor)}）；夏季每年${rules.summer.start}至${rules.summer.end}（${percent(rules.summer.factor)}）；斋月${ramadanDates}（${percent(rules.ramadan.factor)}），斋月优先覆盖冬夏季。`;
}

export function enumerateCalendarDays(project) {
  const start = parseDate(project.startDate, "项目开工日期");
  const end = parseDate(project.endDate, "项目完工日期");
  if (end < start) invalid("项目完工日期不能早于开工日期");
  const calendarRules = resolveCalendarRules(project.calendarRules);
  const days = [];
  for (let time = start.getTime(); time <= end.getTime(); time += MS_PER_DAY) {
    const date = new Date(time);
    const type = isRamadan(date, calendarRules.ramadan)
      ? "ramadan"
      : annualRangeIncludes(date.toISOString().slice(5, 10), calendarRules.summer)
        ? "summer"
        : "winter";
    days.push({ date: date.toISOString().slice(0, 10), type, factor: calendarRules[type].factor });
  }
  return days;
}

export function calculateCalendar(project) {
  const calendarRules = resolveCalendarRules(project.calendarRules);
  const days = enumerateCalendarDays(project);
  const periodDays = { winter: 0, summer: 0, ramadan: 0 };
  for (const day of days) periodDays[day.type] += 1;
  const durationDays = Object.values(periodDays).reduce((sum, days) => sum + days, 0);
  const effectiveDays = Object.entries(periodDays).reduce(
    (sum, [type, days]) => sum + days * calendarRules[type].factor,
    0,
  );
  return {
    startDate: project.startDate,
    endDate: project.endDate,
    durationDays,
    periodDays,
    effectiveDays: round(effectiveDays, 4),
    weightedFactor: round(effectiveDays / durationDays, 4),
    calendarRules,
    seasonRule: describeRules(calendarRules),
  };
}
