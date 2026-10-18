import { DEFAULT_CALENDAR_RULES, resolveCalendarRules } from "./calendar.js";
import { renderScheduleVisualizations, normalizeChartView } from "./plan-visualizations.js";

// Authentication precedes event wiring, browser settings and every data read.
// An unavailable/anonymous public session must never fall back to private mode.
if (globalThis.WORKFORCE_PUBLIC_MODE === true) {
  await globalThis.workforcePublicSession?.ready;
  if (!globalThis.workforcePublicSession?.authenticated) await new Promise(() => {});
}

const state = {
  productivity: [],
  history: [],
  selectedHistoryId: null,
  historyPlan: null,
  lastPlan: null,
};

const qs = (selector, parent = document) => parent.querySelector(selector);
const qsa = (selector, parent = document) => [...parent.querySelectorAll(selector)];
const chartViews = new WeakMap();
let nextDivisionId = 0;
let nextSubitemId = 0;
let nextWorkItemId = 0;

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatNumber(value) {
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 3 }).format(value ?? 0);
}

function formatDateTime(value) {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function crewText(crew = {}) {
  return Object.entries(crew).map(([role, count]) => `${role}×${count}`).join("、") || "—";
}

const DEFAULT_RATIOS = Object.freeze({ winter: 100, summer: 70, ramadan: 50 });
const RATIO_STORAGE_KEY = "saudi-workforce-ratios-v1";
const DATE_STORAGE_KEY = "saudi-workforce-calendar-dates-v1";

async function api(path, options = {}) {
  if (globalThis.workforceUI) return globalThis.workforceUI.api(path, options);
  if (globalThis.WORKFORCE_PUBLIC_MODE === true) throw new Error("公开版连接层不可用，请重新打开页面；不会转入私有或模型 API 模式。");
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(options.headers ?? {}) },
    ...options,
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "请求失败");
  return body;
}

function settingsStorage() {
  if (globalThis.WORKFORCE_PUBLIC_MODE === true && !globalThis.workforceUI?.storage) throw new Error("公开版个人设置尚未就绪。");
  return globalThis.workforceUI?.storage ?? localStorage;
}

async function confirmAction(message) {
  return globalThis.workforceUI ? globalThis.workforceUI.confirm(message) : confirm(message);
}

function canMaintainProductivity() {
  return globalThis.WORKFORCE_PUBLIC_MODE !== true
    || (globalThis.workforcePublicSession?.account?.canEditProductivity === true
      && globalThis.workforcePublicSession.account.productivityScope === "personal");
}

function isPersonalProductivityMode() {
  return globalThis.WORKFORCE_PUBLIC_MODE === true;
}

function productivityScopeLabel(item) {
  if (!isPersonalProductivityMode()) return "";
  const personal = item.hasPersonalOverride === true || item.catalogScope === "personal";
  const label = item.hasPersonalOverride === true ? "个人修改" : personal ? "个人新增" : "共享默认";
  return `<small class="catalog-scope${personal ? " is-personal" : ""}">${label}</small>`;
}

function configureProductivityScope() {
  if (!isPersonalProductivityMode()) return;
  qs("#library-scope-note").textContent = "所有注册用户均可查看共享默认工效。你新增、修改的工效仅用于本人测算；“仅本人隐藏”不改变共享库、其他用户或已保存历史。缺失工效保持不可用、工作内容待补充，补齐后方可启用。";
  const note = qs("#productivity-scope-note");
  note.hidden = false;
  note.textContent = "个人工效版本：新增及修改只对当前登录账户生效，不会修改共享默认库或其他人的工效、历史。";
  qs("#productivity-form-title").textContent = "新增个人工效";
  qs("#save-productivity").textContent = "新增个人工效";
}

function orderedProductivity() {
  const divisionOrder = new Map();
  const subitemOrder = new Map();
  for (const item of state.productivity) {
    if (!Number.isFinite(item.hierarchyOrder)) continue;
    divisionOrder.set(item.division, Math.min(divisionOrder.get(item.division) ?? Infinity, item.hierarchyOrder));
    const key = `${item.division}\u0000${item.subitem}`;
    subitemOrder.set(key, Math.min(subitemOrder.get(key) ?? Infinity, item.hierarchyOrder));
  }
  return [...state.productivity].sort((left, right) => {
    const divisionDifference = (divisionOrder.get(left.division) ?? 10000)
      - (divisionOrder.get(right.division) ?? 10000);
    if (divisionDifference) return divisionDifference;
    if (left.division !== right.division) return left.division.localeCompare(right.division, "zh-CN");
    const leftKey = `${left.division}\u0000${left.subitem}`;
    const rightKey = `${right.division}\u0000${right.subitem}`;
    const subitemDifference = (subitemOrder.get(leftKey) ?? 10000)
      - (subitemOrder.get(rightKey) ?? 10000);
    if (subitemDifference) return subitemDifference;
    if (left.subitem !== right.subitem) return left.subitem.localeCompare(right.subitem, "zh-CN");
    return (left.hierarchyOrder ?? 10000) - (right.hierarchyOrder ?? 10000)
      || left.name.localeCompare(right.name, "zh-CN");
  });
}

function libraryDivisions() {
  return [...new Set(orderedProductivity().map((item) => item.division || "其他工程"))];
}

function librarySubitems(division) {
  return [...new Set(orderedProductivity()
    .filter((item) => item.division === division)
    .map((item) => item.subitem || "未分类分项"))];
}

function libraryActivities(division, subitem) {
  return orderedProductivity().filter((item) => item.division === division && item.subitem === subitem);
}

function selectOptions(values, placeholder) {
  return `<option value="" disabled>${placeholder}</option>${values.map((value) =>
    `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`).join("")}`;
}

function updateDivision(group, wanted = "") {
  const select = qs(".division-select", group);
  const divisions = libraryDivisions();
  if (!divisions.includes("其他工程")) divisions.push("其他工程");
  if (wanted && !divisions.includes(wanted)) divisions.push(wanted);
  select.innerHTML = selectOptions(divisions, "请选择分部工程");
  select.value = wanted && divisions.includes(wanted) ? wanted : "";
}

function updateSubitem(subitem, wanted = "") {
  const division = qs(".division-select", subitem.closest(".division-block")).value;
  const select = qs(".subitem-select", subitem);
  const subitems = librarySubitems(division);
  if (division && !subitems.includes("其他分项")) subitems.push("其他分项");
  if (division && wanted && !subitems.includes(wanted)) subitems.push(wanted);
  select.innerHTML = selectOptions(subitems, "请先选择分项工程");
  select.disabled = !division;
  select.value = wanted && subitems.includes(wanted) ? wanted : "";
}

function updateActivityOptions(row, wanted = "") {
  const division = qs(".division-select", row.closest(".division-block")).value;
  const subitem = qs(".subitem-select", row.closest(".subitem-block")).value;
  const select = qs(".activity-select", row);
  const items = libraryActivities(division, subitem);
  select.innerHTML = `<option value="" disabled>请选择工种 / 工序</option>${items.map((item) =>
    `<option value="${escapeHtml(item.id)}"${item.status === "unavailable" ? " disabled" : ""}>${escapeHtml(item.category)} · ${escapeHtml(item.name)}${item.status === "needs_validation" ? "（待核验）" : item.status === "unavailable" ? "（不可用）" : ""}</option>`).join("")}<option value="__missing__">其他工序（工效待补充）</option>`;
  select.disabled = !subitem;
  select.value = wanted === "__missing__" || items.some((item) => item.id === wanted && item.status !== "unavailable") ? wanted : "";
  updateRow(row);
}

function updateRow(row) {
  const select = qs(".activity-select", row);
  const missingName = qs(".missing-name", row);
  const unit = qs(".unit", row);
  const selected = state.productivity.find((item) => item.id === select.value);
  const missingSelected = select.value === "__missing__";
  missingName.hidden = !missingSelected;
  missingName.required = missingSelected;
  unit.readOnly = !missingSelected;
  unit.value = selected?.unit ?? "";
  unit.placeholder = missingSelected ? "自定义单位" : "";
}

function rebuildWorkRowOptions() {
  for (const group of qsa("#division-list > .division-block")) {
    updateDivision(group, qs(".division-select", group).value);
    for (const subitem of qsa(".subitem-list > .subitem-block", group)) {
      updateSubitem(subitem, qs(".subitem-select", subitem).value);
      for (const row of qsa(".work-rows tr", subitem)) {
        updateActivityOptions(row, qs(".activity-select", row).value);
      }
    }
  }
}

function renumberWorkRows() {
  qsa("#division-list > .division-block").forEach((group, major) => {
    qs(".division-sequence", group).textContent = String(major + 1);
    qsa(".subitem-list > .subitem-block", group).forEach((subitem, minor) => {
      qs(".subitem-sequence", subitem).textContent = `${major + 1}.${minor + 1}`;
      qsa(".work-rows tr", subitem).forEach((row, small) => {
        qs(".work-sequence", row).textContent = `${major + 1}.${minor + 1}.${small + 1}`;
        qs(".remove-row", row).disabled = qsa(".work-rows tr", subitem).length === 1;
      });
      qs(".remove-subitem", subitem).disabled = qsa(".subitem-list > .subitem-block", group).length === 1;
    });
    qs(".remove-division", group).disabled = qsa("#division-list > .division-block").length === 1;
  });
}

function addWorkRow(subitem, defaults = {}) {
  const row = qs("#work-row-template").content.firstElementChild.cloneNode(true);
  row.dataset.itemId = `work-${++nextWorkItemId}`;
  if (defaults.itemId) {
    row.dataset.itemId = defaults.itemId;
    nextWorkItemId = Math.max(nextWorkItemId, Number(String(defaults.itemId).match(/^work-(\d+)$/)?.[1]) || 0);
  }
  qs(".work-rows", subitem).append(row);
  updateActivityOptions(row, defaults.activityId ?? "");
  qs(".quantity", row).value = defaults.quantity ?? "";
  qs(".missing-name", row).value = defaults.name ?? "";
  qs(".activity-select", row).addEventListener("change", () => updateRow(row));
  qs(".remove-row", row).addEventListener("click", () => {
    if (qsa(".work-rows tr", subitem).length > 1) {
      row.remove();
      renumberWorkRows();
    }
  });
  renumberWorkRows();
  updateRow(row);
  if (defaults.activityId === "__missing__") qs(".unit", row).value = defaults.unit ?? "";
  return row;
}

function addSubitem(group, defaults = {}) {
  const subitem = qs("#subitem-template").content.firstElementChild.cloneNode(true);
  subitem.dataset.subitemId = `subitem-${++nextSubitemId}`;
  if (defaults.subitemId) {
    subitem.dataset.subitemId = defaults.subitemId;
    nextSubitemId = Math.max(nextSubitemId, Number(String(defaults.subitemId).match(/^subitem-(\d+)$/)?.[1]) || 0);
  }
  qs(".subitem-list", group).append(subitem);
  updateSubitem(subitem, defaults.subitem ?? "");
  qs(".subitem-select", subitem).addEventListener("change", () => {
    qsa(".work-rows tr", subitem).forEach((row) => updateActivityOptions(row));
  });
  qs(".add-work-item", subitem).addEventListener("click", () => addWorkRow(subitem));
  qs(".remove-subitem", subitem).addEventListener("click", () => {
    if (qsa(".subitem-list > .subitem-block", group).length > 1) {
      subitem.remove();
      renumberWorkRows();
    }
  });
  for (const workItem of defaults.workItems?.length ? defaults.workItems : [defaults]) addWorkRow(subitem, workItem);
  renumberWorkRows();
  return subitem;
}

function addDivision(defaults = {}) {
  const group = qs("#division-template").content.firstElementChild.cloneNode(true);
  group.dataset.divisionId = `division-${++nextDivisionId}`;
  if (defaults.divisionId) {
    group.dataset.divisionId = defaults.divisionId;
    nextDivisionId = Math.max(nextDivisionId, Number(String(defaults.divisionId).match(/^division-(\d+)$/)?.[1]) || 0);
  }
  qs("#division-list").append(group);
  updateDivision(group, defaults.division ?? "");
  qs(".division-remark", group).value = defaults.divisionRemark ?? "";
  qs(".division-select", group).addEventListener("change", () => {
    qsa(".subitem-list > .subitem-block", group).forEach((subitem) => {
      updateSubitem(subitem);
      qsa(".work-rows tr", subitem).forEach((row) => updateActivityOptions(row));
    });
  });
  qs(".add-subitem", group).addEventListener("click", () => addSubitem(group));
  qs(".remove-division", group).addEventListener("click", () => {
    if (qsa("#division-list > .division-block").length > 1) {
      group.remove();
      renumberWorkRows();
    }
  });
  for (const subitem of defaults.subitems?.length ? defaults.subitems : [defaults]) addSubitem(group, subitem);
  renumberWorkRows();
  return group;
}

function ratioValues() {
  return {
    winter: Number(qs("#winter-percent").value),
    summer: Number(qs("#summer-percent").value),
    ramadan: Number(qs("#ramadan-percent").value),
  };
}

function calendarDateValues() {
  const mode = qs("#ramadan-mode").value;
  return {
    winter: { start: qs("#winter-start").value.trim(), end: qs("#winter-end").value.trim() },
    summer: { start: qs("#summer-start").value.trim(), end: qs("#summer-end").value.trim() },
    ramadan: {
      mode,
      ranges: mode === "custom" ? qsa("#ramadan-ranges .ramadan-range").map((row) => ({
        startDate: qs(".ramadan-start", row).value,
        endDate: qs(".ramadan-end", row).value,
      })) : [],
    },
  };
}

function updateRuleSummary() {
  const dates = calendarDateValues();
  const ratios = ratioValues();
  const ramadanText = dates.ramadan.mode === "auto"
    ? "斋月自动识别" : `斋月手动设置${dates.ramadan.ranges.length}段`;
  qs("#rule-period-summary").textContent = `冬季 ${dates.winter.start || "待填"}—${dates.winter.end || "待填"} · 夏季 ${dates.summer.start || "待填"}—${dates.summer.end || "待填"} · ${ramadanText}`;
  qs("#rule-factor-summary").textContent = `冬季${ratios.winter}% · 夏季${ratios.summer}% · 斋月${ratios.ramadan}%，斋月优先、不叠乘`;
}

function loadRatioSettings() {
  try {
    const saved = JSON.parse(settingsStorage().getItem(RATIO_STORAGE_KEY) || "null");
    if (saved && typeof saved === "object") {
      for (const type of Object.keys(DEFAULT_RATIOS)) {
        if (Number.isFinite(saved[type]) && saved[type] > 0 && saved[type] <= 200) {
          qs(`#${type}-percent`).value = saved[type];
        }
      }
    }
  } catch {
    // Browser storage may be unavailable; the displayed values remain usable.
  }
  updateRatioStatus(false);
}

function updateRatioStatus(persist = true) {
  const status = qs("#ratio-status");
  updateRuleSummary();
  if (!qs("#ratio-form").checkValidity()) {
    status.textContent = "比例须大于0%且不超过200%。";
    status.className = "hint is-error";
    return;
  }
  const values = ratioValues();
  const isDefault = Object.keys(DEFAULT_RATIOS).every((type) => values[type] === DEFAULT_RATIOS[type]);
  if (persist) {
    try {
      settingsStorage().setItem(RATIO_STORAGE_KEY, JSON.stringify(values));
    } catch {
      status.textContent = "比例已用于当前页面，但浏览器未允许保存；刷新后可能恢复默认。";
      status.className = "hint is-error";
      return;
    }
  }
  status.textContent = isDefault ? "当前使用默认比例。" : globalThis.workforceUI ? "自定义比例已保存到当前内嵌界面。" : "自定义比例已保存到当前浏览器。";
  status.className = "hint is-success";
  updateRuleSummary();
}

function addRamadanRange(values = {}, refreshStatus = true) {
  const row = qs("#ramadan-range-template").content.firstElementChild.cloneNode(true);
  qs(".ramadan-start", row).value = values.startDate ?? "";
  qs(".ramadan-end", row).value = values.endDate ?? "";
  qsa("input", row).forEach((input) => input.addEventListener("input", updateCalendarStatus));
  qs(".remove-ramadan-range", row).addEventListener("click", () => {
    row.remove();
    updateCalendarStatus();
  });
  qs("#ramadan-ranges").append(row);
  if (refreshStatus) updateCalendarStatus();
}

function setRamadanVisibility() {
  const custom = qs("#ramadan-mode").value === "custom";
  qs("#ramadan-custom-dates").hidden = !custom;
  if (custom && !qsa("#ramadan-ranges .ramadan-range").length) addRamadanRange({}, false);
  qsa("#ramadan-ranges input").forEach((input) => { input.disabled = !custom; });
}

function loadCalendarSettings() {
  try {
    const saved = JSON.parse(settingsStorage().getItem(DATE_STORAGE_KEY) || "null");
    if (saved) {
      const valid = resolveCalendarRules(saved);
      qs("#winter-start").value = valid.winter.start;
      qs("#winter-end").value = valid.winter.end;
      qs("#summer-start").value = valid.summer.start;
      qs("#summer-end").value = valid.summer.end;
      qs("#ramadan-mode").value = valid.ramadan.mode;
      valid.ramadan.ranges.forEach((range) => addRamadanRange(range, false));
    }
  } catch {
    // Invalid or unavailable browser storage leaves the default calendar in place.
  }
  setRamadanVisibility();
  updateCalendarStatus(false);
}

function updateCalendarStatus(persist = true) {
  const status = qs("#calendar-status");
  updateRuleSummary();
  if (!qs("#calendar-form").checkValidity()) {
    status.textContent = "请填写有效的冬夏季月日和斋月起止日期。";
    status.className = "hint is-error";
    return false;
  }
  const dates = calendarDateValues();
  try {
    resolveCalendarRules(dates);
    if (persist) {
      try {
        settingsStorage().setItem(DATE_STORAGE_KEY, JSON.stringify(dates));
      } catch {
        status.textContent = "时间规则已用于当前页面，但浏览器未允许保存；刷新后可能恢复默认。";
        status.className = "hint is-error";
        return true;
      }
    }
    const isDefault = dates.winter.start === DEFAULT_CALENDAR_RULES.winter.start
      && dates.winter.end === DEFAULT_CALENDAR_RULES.winter.end
      && dates.summer.start === DEFAULT_CALENDAR_RULES.summer.start
      && dates.summer.end === DEFAULT_CALENDAR_RULES.summer.end
      && dates.ramadan.mode === "auto";
    status.textContent = isDefault ? "当前使用默认时间规则。" : globalThis.workforceUI ? "自定义时间已保存到当前内嵌界面。" : "自定义时间已保存到当前浏览器。";
    status.className = "hint is-success";
    return true;
  } catch (error) {
    status.textContent = error.message;
    status.className = "hint is-error";
    return false;
  }
}

function collectCalendarRules() {
  const dates = calendarDateValues();
  const ratios = ratioValues();
  const customRatios = Object.keys(DEFAULT_RATIOS).some((type) => ratios[type] !== DEFAULT_RATIOS[type]);
  const customDates = dates.winter.start !== DEFAULT_CALENDAR_RULES.winter.start
    || dates.winter.end !== DEFAULT_CALENDAR_RULES.winter.end
    || dates.summer.start !== DEFAULT_CALENDAR_RULES.summer.start
    || dates.summer.end !== DEFAULT_CALENDAR_RULES.summer.end
    || dates.ramadan.mode !== "auto";
  if (!customDates && !customRatios) return undefined;
  return {
    winter: { ...dates.winter, factor: ratios.winter / 100 },
    summer: { ...dates.summer, factor: ratios.summer / 100 },
    ramadan: { ...dates.ramadan, factor: ratios.ramadan / 100 },
  };
}

function collectPlan() {
  const form = qs("#plan-form");
  const groups = qsa("#division-list > .division-block");
  const workItems = groups.flatMap((group) => qsa(".subitem-list > .subitem-block", group)
    .flatMap((subitem) => qsa(".work-rows tr", subitem).map((row) => {
      const selection = qs(".activity-select", row).value;
      const activityId = selection && selection !== "__missing__" ? selection : undefined;
      return {
        itemId: row.dataset.itemId,
        divisionId: group.dataset.divisionId,
        subitemId: subitem.dataset.subitemId,
        division: qs(".division-select", group).value,
        divisionRemark: qs(".division-remark", group).value.trim(),
        subitem: qs(".subitem-select", subitem).value,
        activityId,
        name: selection === "__missing__" ? qs(".missing-name", row).value : undefined,
        quantity: Number(qs(".quantity", row).value),
        unit: qs(".unit", row).value || undefined,
      };
    })));
  return {
    project: {
      name: "工程项目测算",
      context: form.elements.context.value.trim(),
      startDate: form.elements.startDate.value,
      endDate: form.elements.endDate.value,
      calendarRules: collectCalendarRules(),
    },
    workItems,
  };
}

function captureEmbeddedDraft() {
  const form = qs("#plan-form");
  return {
    context: form.elements.context.value,
    startDate: form.elements.startDate.value,
    endDate: form.elements.endDate.value,
    ratios: ratioValues(),
    dates: calendarDateValues(),
    divisions: qsa("#division-list > .division-block").map((group) => ({
      divisionId: group.dataset.divisionId,
      division: qs(".division-select", group).value,
      divisionRemark: qs(".division-remark", group).value,
      subitems: qsa(".subitem-list > .subitem-block", group).map((subitem) => ({
        subitemId: subitem.dataset.subitemId,
        subitem: qs(".subitem-select", subitem).value,
        workItems: qsa(".work-rows tr", subitem).map((row) => ({
          itemId: row.dataset.itemId,
          activityId: qs(".activity-select", row).value,
          quantity: qs(".quantity", row).value,
          name: qs(".missing-name", row).value,
          unit: qs(".unit", row).value,
        })),
      })),
    })),
  };
}

function restoreEmbeddedDraft(draft) {
  if (!draft || !Array.isArray(draft.divisions) || !draft.divisions.length) return false;
  const form = qs("#plan-form");
  form.elements.context.value = draft.context ?? "";
  form.elements.startDate.value = draft.startDate ?? "";
  form.elements.endDate.value = draft.endDate ?? "";
  qs("#division-list").replaceChildren();
  for (const group of draft.divisions) addDivision(group);
  if (draft.ratios) settingsStorage().setItem(RATIO_STORAGE_KEY, JSON.stringify(draft.ratios));
  if (draft.dates) settingsStorage().setItem(DATE_STORAGE_KEY, JSON.stringify(draft.dates));
  qs("#ramadan-ranges").replaceChildren();
  loadRatioSettings();
  loadCalendarSettings();
  return true;
}

function objectRows(object, suffix = "") {
  const entries = Object.entries(object ?? {}).sort((a, b) => b[1] - a[1]);
  if (!entries.length) return `<tr><td colspan="2" class="muted">暂无</td></tr>`;
  return entries
    .map(([key, value]) => `<tr><td>${escapeHtml(key)}</td><td><strong>${formatNumber(value)}${suffix}</strong></td></tr>`)
    .join("");
}

function scopeText(item) {
  return [item.divisionRemark, item.remark].filter(Boolean).join(" · ");
}

function isResourcePlan(option) {
  return Boolean(option?.staffingMode) || isDayOverlap(option);
}

function isSingleCrewDayOverlap(option) {
  return option?.id === "single-crew-day-overlap" || option?.staffingMode === "single-crew-day-overlap";
}

function isDayOverlap(option) {
  return isSingleCrewDayOverlap(option) || option?.id === "multi-crew-day-overlap" || option?.staffingMode === "multi-crew-day-overlap";
}

function shiftText(option) {
  return `${formatNumber(option.shiftsPerDay ?? 1)} 班/日 · 每班 ${formatNumber(option.hoursPerShift ?? 8)} 小时`;
}

function staffingText(item, option, compact = false) {
  if (item.requiredEquipment) return crewText(item.requiredEquipment);
  if (!isResourcePlan(option)) {
    return item.requiredCrews ? `${item.requiredCrews} 个班组 · ${crewText(item.peakCrew)}` : crewText(item.peakCrew);
  }
  const shifts = item.shiftsPerDay ?? option.shiftsPerDay ?? 1;
  const crews = item.crewsPerShift ?? item.requiredCrews ?? (isSingleCrewDayOverlap(option) ? 1 : undefined);
  const perShift = item.crewPerShift ?? item.peakCrew;
  const configuration = crews ? `${formatNumber(crews)} 组/班 × ${formatNumber(shifts)} 班/日` : `${formatNumber(shifts)} 班/日`;
  if (compact) return `${configuration} · 全日配备 ${crewText(item.peakCrew)}`;
  return `${configuration} · 每班 ${crewText(perShift)}${shifts > 1 ? `；早晚两班合计 ${crewText(item.peakCrew)}（两套人员）` : ""}`;
}

function baselineMarkup(plan) {
  const baseline = plan.baselineAssessment;
  if (!baseline) return "";
  const missingItems = baseline.missingItems ?? plan.missingProductivity?.length ?? 0;
  const partial = baseline.isComplete === false || missingItems > 0;
  const details = [
    `可用工期 ${formatNumber(baseline.availableCalendarDays ?? plan.project.durationDays)} 天`,
    partial ? `仅评估已计入工序，${formatNumber(missingItems)} 项工效待补充` : "",
    baseline.requiredCalendarDays != null ? `顺序单白班预计需 ${formatNumber(baseline.requiredCalendarDays)} 天` : "",
    baseline.finishDate ? `预计完工 ${baseline.finishDate}` : "",
    baseline.overrunDays > 0 ? `超出 ${formatNumber(baseline.overrunDays)} 天` : "",
  ].filter(Boolean).map(escapeHtml).join(" · ");
  return `<section class="result-card baseline-assessment">
    <h3>工期判断 · 顺序施工 / 单班组白班</h3>
    <p><span class="status ${baseline.feasible ? "good" : "warn"}">${partial ? (baseline.feasible ? "已计入部分可满足" : "已计入部分不足") : (baseline.feasible ? "工期足够" : "工期不足")}</span> ${escapeHtml(baseline.reason || (baseline.feasible ? "单班组白班可按期完成，无需增加班次或班组。" : "在满足技术前置的前提下，比较增加班次、增加班组或有条件的多工序搭接方案。"))}</p>
    <p class="source-rule">${details}</p>
  </section>`;
}

function workflowMarkup(plan, workItems) {
  const workflow = plan.workflow;
  if (workflow?.mode !== "gpt") return `<div class="notice">此方案为旧版规则测算，未包含GPT对全项目的逐项施工逻辑判断。</div>`;
  const byId = new Map(workItems.map((item) => [item.itemId, item]));
  const label = (id) => {
    const item = byId.get(id);
    return item ? `${item.hierarchyNumber ?? item.sequence} · ${item.name}${scopeText(item) ? `〔${scopeText(item)}〕` : ""}` : id;
  };
  return `<section class="result-card workflow-review">
    <h3>本次项目施工逻辑判断 · GPT</h3>
    <p>${escapeHtml(workflow.summary)}</p>
    ${plan.project.context ? `<p class="muted">项目说明：${escapeHtml(plan.project.context)}</p>` : ""}
    <div class="work-table-wrap"><table class="compact-table"><thead><tr><th>工序及施工部位</th><th>逐项判断依据</th></tr></thead><tbody>
      ${(workflow.itemDecisions ?? []).map((decision) => `<tr><td>${escapeHtml(label(decision.itemId))}</td><td>${escapeHtml(decision.reason)}</td></tr>`).join("")}
    </tbody></table></div>
    ${(workflow.dependencies ?? []).length ? `<h4>必须满足的先后顺序</h4><ul>${workflow.dependencies.map((edge) => `<li>${escapeHtml(label(edge.beforeItemId))} → ${escapeHtml(label(edge.afterItemId))}：${escapeHtml(edge.reason)}</li>`).join("")}</ul>` : ""}
    ${(workflow.parallelGroups ?? []).length ? `<h4>技术上允许并行的工作</h4><ul>${workflow.parallelGroups.map((group) => `<li>${group.itemIds.map((id) => escapeHtml(label(id))).join("、")}：${escapeHtml(group.reason)}</li>`).join("")}</ul><p class="muted">此处仅说明技术上允许并行，不等于已经安排同时开工；实际日期以所选方案和横道图为准。</p>` : ""}
    ${(workflow.assumptions ?? []).length ? `<h4>本次采用的假设</h4><ul>${workflow.assumptions.map((text) => `<li>${escapeHtml(text)}</li>`).join("")}</ul>` : ""}
    ${(workflow.questions ?? []).length ? `<h4>待核对事项</h4><ul>${workflow.questions.map((text) => `<li>${escapeHtml(text)}</li>`).join("")}</ul>` : ""}
  </section>`;
}

function overlapBasisMarkup(option, workItems) {
  if (!isDayOverlap(option)) return "";
  const byId = new Map(workItems.map((item) => [item.itemId, item]));
  const label = (id) => {
    const item = byId.get(id);
    return item ? `${item.hierarchyNumber ?? item.sequence} · ${item.name}${scopeText(item) ? `〔${scopeText(item)}〕` : ""}` : id;
  };
  const savedBasis = Array.isArray(option.overlapBasis) ? option.overlapBasis : [];
  const basis = savedBasis.slice(0, 200);
  const hasTotal = Number.isSafeInteger(option.overlapBasisTotal) && option.overlapBasisTotal >= savedBasis.length;
  const total = hasTotal ? option.overlapBasisTotal : savedBasis.length;
  const truncated = option.overlapBasisTruncated === true || total > basis.length;
  const truncationNotice = truncated ? `<p class="notice">仅列前 ${formatNumber(basis.length)} 组，${hasTotal || savedBasis.length > basis.length ? `实际共 ${formatNumber(total)} 组` : "实际总组数未保存"}；完整允许搭接依据及日期见施工逻辑判断与横道图。</p>` : "";
  return `<section class="result-card overlap-basis">
    <h3>实际搭接工序与依据</h3>
    <p class="source-rule">以下仅列本方案日期实际重叠的工序；技术上允许并行的其他工作不等于已经安排同时开工。</p>
    ${truncationNotice}
    ${basis.length ? `<ul>${basis.map((entry) => `<li>${(Array.isArray(entry?.itemIds) ? entry.itemIds : []).map((id) => escapeHtml(label(id))).join("、")}：${escapeHtml(entry?.reason)}</li>`).join("")}</ul>` : `<p class="muted">此记录未附单独的搭接依据；请结合已保存的施工逻辑判断及日期核对，不据此另行推定可并行条件。</p>`}
  </section>`;
}

function planMarkup(plan) {
  const option = plan.planOptions?.find((item) => item.id === plan.selectedOptionId) ?? plan.planOptions?.[0];
  const summary = option?.summary ?? plan.summary;
  const workItems = option?.workItems ?? plan.workItems;
  const resourcePlan = isResourcePlan(option);
  const hasLegacyOverlap = plan.planOptions?.some((candidate) => !isResourcePlan(candidate) && ["balanced", "early-overlap"].includes(candidate.id));
  const choices = plan.planOptions?.length ? `<div class="plan-options" role="group" aria-label="选择劳动力方案">
    ${plan.planOptions.map((candidate) => `<button type="button" class="plan-option ${candidate.id === option.id ? "is-selected" : ""}" data-option-id="${escapeHtml(candidate.id)}" aria-pressed="${candidate.id === option.id}">
      <strong>${escapeHtml(candidate.name)}${!isResourcePlan(candidate) && ["balanced", "early-overlap"].includes(candidate.id) ? "（旧版历史）" : ""}</strong><span>${escapeHtml(candidate.description)}${isResourcePlan(candidate) ? `<br>${escapeHtml(shiftText(candidate))}` : ""}</span>
      <small>计划完工 ${escapeHtml(candidate.finishDate || "—")} · ${isResourcePlan(candidate) ? "全日配备峰值" : "峰值"} ${formatNumber(candidate.summary.conservativePeakHeadcount)}人 · ${formatNumber(candidate.summary.totalPersonDays)}人日</small>
    </button>`).join("")}
  </div>` : "";
  const orderedItems = [...workItems]
    .filter((item) => item.status === "calculated" && item.startDay != null)
    .sort((left, right) => left.startDay - right.startDay || left.sequence - right.sequence);
  const bySequence = new Map(workItems.map((item) => [item.sequence, item.hierarchyNumber ?? item.sequence]));
  const divisionMarkup = option?.divisionSchedule?.length ? `<div class="result-card" style="margin-top:18px">
    <h3>分部施工顺序</h3>
    <p class="source-rule">编号用于对照工程量；以下按实际开工时间排列。${resourcePlan ? "各方案均须满足技术前置；顺序施工及不搭接的增班、增班组方案按顺序推进，多工序搭接仅在确认具备条件时允许并行，实际安排以所选方案日期为准。" : "此处保留原历史方案的施工安排。"}</p>
    <ol class="planned-sequence">${[...option.divisionSchedule].sort((a, b) => String(a.startDate || "9999").localeCompare(String(b.startDate || "9999")) || a.divisionSequence - b.divisionSequence).map((group) => `<li><strong>${escapeHtml(group.divisionSequence)} · ${escapeHtml(group.division)}${group.divisionRemark ? `<span class="scope-label">${escapeHtml(group.divisionRemark)}</span>` : ""}</strong><span>${escapeHtml(group.startDate || "未排程")} 至 ${escapeHtml(group.endDate || "未完成")}</span>${group.afterDivision ? `<small>原方案等待条件：${escapeHtml(group.afterDivision)}</small>` : ""}</li>`).join("")}</ol>
  </div>` : "";
  const sequenceMarkup = orderedItems.length ? `<div class="result-card" style="margin-top:18px">
    <h3>测算施工顺序</h3>
    <p class="source-rule">按所选方案的计划开工时间排列；三级编号用于对照工程量，不要求录入时先排技术顺序。</p>
    <ol class="planned-sequence">${orderedItems.map((item) => `<li>
      <strong>${escapeHtml(item.hierarchyNumber ?? item.sequence)} · ${escapeHtml(item.name)}${scopeText(item) ? `<span class="scope-label">${escapeHtml(scopeText(item))}</span>` : ""}</strong>
      <span>${escapeHtml(item.startDate)} 至 ${escapeHtml(item.endDate)}</span>
      ${(item.dependsOnSequences ?? []).length ? `<small>须等 ${item.dependsOnSequences.map((sequence) => escapeHtml(bySequence.get(sequence) ?? sequence)).join("、")} 完成后开始</small>` : ""}
    </li>`).join("")}</ol>
  </div>` : "";
  const itemRows = workItems
    .map((item, index) => {
      let details = item.reason;
      if (item.status === "calculated") {
        details = staffingText(item, option);
      }
      return `<tr>
        <td>${escapeHtml(item.hierarchyNumber ?? item.sequence ?? index + 1)}</td>
        <td>${escapeHtml(item.name)}${item.division && item.subitem ? `<small class="item-path">${escapeHtml(item.division)} / ${escapeHtml(item.subitem)}</small>` : ""}</td>
        <td>${escapeHtml(scopeText(item) || "—")}</td>
        <td>${formatNumber(item.quantity)} ${escapeHtml(item.unit)}</td>
        <td>${escapeHtml(item.productivity ?? "—")}</td>
        <td>${escapeHtml(details)}</td>
        <td>${item.startDate ? `${escapeHtml(item.startDate)} 至 ${escapeHtml(item.endDate)}<br>${formatNumber(item.durationDays)}天` : "—"}</td>
        <td><span class="status ${item.status === "calculated" ? "good" : "warn"}">${item.status === "calculated" ? "已测算" : "待补充"}</span></td>
      </tr>`;
    })
    .join("");

  return `
    ${hasLegacyOverlap ? `<div class="notice">此记录含旧版穿插方案，仅保留供历史查阅；新测算不再生成均衡穿插或提前穿插方案，旧记录未被改写。</div>` : ""}
    ${baselineMarkup(plan)}
    <button class="secondary chart-jump" type="button" data-chart-jump>查看劳动力柱状图与横道图 ↓</button>
    ${choices}
    ${resourcePlan ? `<p class="source-rule staffing-rule">按每班 ${formatNumber(option.hoursPerShift ?? 8)} 小时工效测算。${isDayOverlap(option) ? `${isSingleCrewDayOverlap(option) ? "每道工序各配 1 个独立白班班组，不是全项目共用一个班组" : "每道工序按明细所列整数个独立白班班组配置，每日仅 1 班；多个班组为多套完整人员"}；同时施工时各工序人员相加，不重复借用同一套人员。仅在施工前置已满足、且工作面及资源条件允许时搭接，不以任意比例提前开工。${isSingleCrewDayOverlap(option) ? "" : "增配班组须有足够独立工作面和机械供应能力；工效按班组数线性估算，仅为测算假设，不代表现场组织或工程审批已通过。"}` : option.shiftsPerDay > 1 ? "早晚班各配一套完整人员，不是同一人员连续工作；全日配备人数为各班人员合计，单班在岗人数另列。人日按实际配置的完整班次累计，不因两班作业减半。早晚班暂采用相同的单班工效，实际班次限制和夜间工效需按项目条件核对。" : "每道工序按所列白班班组配置；人数与人日按实际施工日期累计，不因工期压缩而任意减少。"}</p>` : ""}
    <div class="metrics">
      <div class="metric"><span>综合工效系数</span><strong>${formatNumber(plan.project.weightedFactor)}</strong></div>
      <div class="metric"><span>日历天数 / 等效生产天数</span><strong>${formatNumber(plan.project.durationDays)} / ${formatNumber(plan.project.effectiveDays)}</strong></div>
      <div class="metric"><span>${resourcePlan ? "总人日（8小时/人日）" : "总人日"}</span><strong>${formatNumber(summary.totalPersonDays)}</strong></div>
      ${resourcePlan ? `<div class="metric"><span>日均配备人数（各班合计）</span><strong>${formatNumber(summary.averageHeadcount)}</strong></div><div class="metric"><span>全日配备峰值（各班合计）</span><strong>${formatNumber(summary.conservativePeakHeadcount)}</strong></div><div class="metric"><span>单班在岗峰值</span><strong>${formatNumber(summary.peakOnShiftHeadcount)}</strong></div>` : `<div class="metric"><span>平均人数 / 计划峰值</span><strong>${formatNumber(summary.averageHeadcount)} / ${formatNumber(summary.conservativePeakHeadcount)}</strong></div>`}
    </div>
    <div class="calendar-rule-summary">
      <strong>采用日历规则</strong>
      <p>${escapeHtml(plan.project.seasonRule ?? "按当次项目日历测算")}</p>
      <small>冬季 ${formatNumber(plan.project.periodDays?.winter)} 天 · 夏季 ${formatNumber(plan.project.periodDays?.summer)} 天 · 斋月 ${formatNumber(plan.project.periodDays?.ramadan)} 天</small>
    </div>
    ${workflowMarkup(plan, workItems)}
    ${overlapBasisMarkup(option, workItems)}
    ${divisionMarkup}
    ${sequenceMarkup}
    <div class="result-grid">
      <div class="result-card">
        <h3>${resourcePlan ? "各工种全日配备峰值（各班合计）" : "各工种高峰配置"}</h3>
        <table class="compact-table"><tbody>${objectRows(summary.tradePeak, "人")}</tbody></table>
      </div>
      ${resourcePlan ? `<div class="result-card"><h3>各工种单班在岗峰值</h3><table class="compact-table"><tbody>${objectRows(summary.tradePeakPerShift, "人")}</tbody></table></div>` : ""}
      <div class="result-card">
        <h3>各工种人日</h3>
        <table class="compact-table"><tbody>${objectRows(summary.tradePersonDays, "")}</tbody></table>
      </div>
    </div>
    <div class="result-card" style="margin-top:18px">
      <h3>分项测算明细</h3>
      <div class="work-table-wrap">
        <table class="compact-table">
          <thead><tr><th>序号</th><th>工种 / 工序</th><th>备注</th><th>工程量</th><th>采用工效</th><th>建议配置</th><th>计划时间</th><th>状态</th></tr></thead>
          <tbody>${itemRows}</tbody>
        </table>
      </div>
    </div>
    ${renderScheduleVisualizations(plan, workItems, option, chartViews.get(plan))}
    ${Object.keys(summary.equipmentPeak ?? {}).length ? `
      <div class="result-card" style="margin-top:18px">
        <h3>机械设备峰值</h3>
        <table class="compact-table"><tbody>${objectRows(summary.equipmentPeak, "台")}</tbody></table>
      </div>` : ""}
    ${(plan.unavailableOptions ?? []).length ? `<div class="notice"><strong>未提供的方案</strong><ul>${plan.unavailableOptions.map((candidate) => `<li>${escapeHtml(candidate.name)}：${escapeHtml(candidate.reason)}</li>`).join("")}</ul></div>` : ""}
    ${(plan.warnings ?? []).length ? `<div class="notice"><ul>${plan.warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join("")}</ul></div>` : ""}
  `;
}

function renderPlan(plan) {
  state.lastPlan = plan;
  qs("#result-content").innerHTML = planMarkup(plan);
  qs("#result-history-note").textContent = plan.history
    ? `本次方案已保存到测算历史，记录时间：${formatDateTime(plan.history.createdAt)}。`
    : "";
  qs("#results").hidden = false;
  qs("#results").scrollIntoView({ behavior: "smooth", block: "start" });
}

function choosePlanOption(container, plan, optionId) {
  const option = plan?.planOptions?.find((candidate) => candidate.id === optionId);
  if (!option) return;
  plan.selectedOptionId = option.id;
  plan.summary = option.summary;
  plan.workItems = option.workItems;
  container.innerHTML = planMarkup(plan);
}

function updateScheduleCharts(container, plan, changes, focusSelector) {
  if (!plan) return;
  chartViews.set(plan, normalizeChartView({ ...chartViews.get(plan), ...changes }));
  const option = plan.planOptions?.find((item) => item.id === plan.selectedOptionId) ?? plan.planOptions?.[0];
  const charts = qs(".schedule-visualizations", container);
  if (!charts) return;
  charts.outerHTML = renderScheduleVisualizations(plan, option?.workItems ?? plan.workItems, option, chartViews.get(plan));
  if (focusSelector) qs(focusSelector, container)?.focus({ preventScroll: true });
}

function handleChartClick(event, container, plan) {
  if (event.target.closest("[data-chart-jump]")) {
    qs(".schedule-visualizations", container)?.scrollIntoView({ behavior: "instant", block: "start" });
    return true;
  }
  const zoom = event.target.closest("[data-chart-zoom]");
  if (!zoom) return false;
  updateScheduleCharts(container, plan, { zoom: Number(zoom.dataset.chartZoom) }, '[data-chart-zoom]:not([disabled])');
  return true;
}

function handleChartChange(event, container, plan) {
  const control = event.target.closest("[data-chart-control]");
  if (!control) return;
  updateScheduleCharts(container, plan, { [control.dataset.chartControl]: control.value }, `[data-chart-control="${control.dataset.chartControl}"]`);
}

function renderHistory(filter = "") {
  const needle = filter.trim().toLowerCase();
  const records = state.history.filter((record) => [
    record.createdAt,
    formatDateTime(record.createdAt),
    record.project.name,
    record.project.startDate,
    record.project.endDate,
    ...record.workItemNames,
    ...(record.workItemRemarks ?? []),
    ...Object.keys(record.summary.tradePeak),
  ].join(" ").toLowerCase().includes(needle));
  qs("#history-rows").innerHTML = records.length
    ? records.map((record) => {
      const summary = record.summary;
      const trades = Object.entries(summary.tradePeak)
        .map(([role, count]) => `${escapeHtml(role)} ${formatNumber(count)}人`)
        .join("、") || "暂无已测算人员";
      return `<tr>
        <td>${escapeHtml(formatDateTime(record.createdAt))}</td>
        <td>${escapeHtml(record.project.startDate)} 至 ${escapeHtml(record.project.endDate)}</td>
        <td>${formatNumber(summary.calculatedItems)} 项已测算${summary.missingItems ? `，${formatNumber(summary.missingItems)} 项待补充` : ""}</td>
        <td><strong class="history-primary">${summary.peakOnShiftHeadcount != null ? "全日配备峰值" : "峰值"} ${formatNumber(summary.conservativePeakHeadcount)} 人 · ${formatNumber(summary.totalPersonDays)} 人日</strong>${summary.peakOnShiftHeadcount != null ? `<span class="history-trades">单班在岗峰值 ${formatNumber(summary.peakOnShiftHeadcount)} 人</span>` : ""}<span class="history-trades">${trades}</span></td>
        <td class="row-actions">
          <button class="text-button view-history" type="button" data-id="${escapeHtml(record.id)}">查看</button>
          <button class="text-button danger delete-history" type="button" data-id="${escapeHtml(record.id)}">删除</button>
        </td>
      </tr>`;
    }).join("")
    : `<tr><td colspan="5" class="empty-state">${state.history.length ? "没有匹配的测算记录" : "暂无测算历史。生成劳动力方案后会自动保存。"}</td></tr>`;
}

async function refreshHistory() {
  const response = await api("/api/workforce-history");
  state.history = response.items;
  if (state.selectedHistoryId && !state.history.some((record) => record.id === state.selectedHistoryId)) {
    state.selectedHistoryId = null;
    qs("#history-detail").hidden = true;
  }
  qs("#history-message").textContent = `共 ${state.history.length} 条测算记录，按最近测算时间排序。`;
  qs("#history-message").className = "hint";
  renderHistory(qs("#history-search").value);
}

function showHistoryError(error) {
  qs("#history-message").textContent = error.message;
  qs("#history-message").className = "hint is-error";
}

function showHistoryRecord(record) {
  state.selectedHistoryId = record.id;
  state.historyPlan = record.plan;
  qs("#history-detail-meta").textContent = `测算时间：${formatDateTime(record.createdAt)} · 项目施工时间：${record.plan.project.startDate} 至 ${record.plan.project.endDate}`;
  qs("#history-detail-content").innerHTML = planMarkup(state.historyPlan);
  qs("#history-detail").hidden = false;
  qs("#history-detail").scrollIntoView({ behavior: "smooth", block: "start" });
}

function refreshLibraryActivityFilter(wanted = "") {
  const division = qs("#library-division-filter").value;
  const subitem = qs("#library-subitem-filter").value;
  const select = qs("#library-activity-filter");
  const activities = libraryActivities(division, subitem);
  select.innerHTML = `<option value="">全部工种 / 工序</option>${activities.map((item) =>
    `<option value="${escapeHtml(item.id)}">${escapeHtml(item.category)} · ${escapeHtml(item.name)}</option>`).join("")}`;
  select.disabled = !subitem;
  select.value = activities.some((item) => item.id === wanted) ? wanted : "";
}

function refreshLibrarySubitemFilter(wanted = "", activityWanted = "") {
  const division = qs("#library-division-filter").value;
  const select = qs("#library-subitem-filter");
  const subitems = librarySubitems(division);
  select.innerHTML = `<option value="">全部分项</option>${subitems.map((name) =>
    `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join("")}`;
  select.disabled = !division;
  select.value = subitems.includes(wanted) ? wanted : "";
  refreshLibraryActivityFilter(activityWanted);
}

function refreshLibraryDivisionFilter() {
  const select = qs("#library-division-filter");
  const wantedDivision = select.value;
  const wantedSubitem = qs("#library-subitem-filter").value;
  const wantedActivity = qs("#library-activity-filter").value;
  const divisions = libraryDivisions();
  select.innerHTML = `<option value="">全部分部</option>${divisions.map((name) =>
    `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join("")}`;
  select.value = divisions.includes(wantedDivision) ? wantedDivision : "";
  refreshLibrarySubitemFilter(wantedSubitem, wantedActivity);
}

function renderLibrary() {
  const division = qs("#library-division-filter").value;
  const subitem = qs("#library-subitem-filter").value;
  const activityId = qs("#library-activity-filter").value;
  const needle = qs("#library-search").value.trim().toLowerCase();
  const items = orderedProductivity()
    .filter((item) => !division || item.division === division)
    .filter((item) => !subitem || item.subitem === subitem)
    .filter((item) => !activityId || item.id === activityId)
    .filter((item) => [item.division, item.subitem, item.category, item.name, item.crewText, item.productivityUnit, item.workContent]
      .join(" ").toLowerCase().includes(needle));
  qs("#library-count").textContent = `显示 ${items.length} / ${state.productivity.length} 条工效`;
  qs("#library-rows").innerHTML = items.length
    ? items
      .map(
        (item) => `<tr>
          <td>${escapeHtml(item.division)}</td>
          <td>${escapeHtml(item.subitem)}</td>
          <td>${escapeHtml(item.name)}${productivityScopeLabel(item)}</td>
          <td><strong>${escapeHtml(item.category)}</strong></td>
          <td>${escapeHtml(item.crewText || crewText(item.crew))}</td>
          <td class="number-cell">${Number.isFinite(item.output) && item.output > 0 ? formatNumber(item.output) : "待补充"}</td>
          <td>${escapeHtml(item.productivityUnit || "待补充")}</td>
          <td class="work-content">${escapeHtml(item.workContent || (isPersonalProductivityMode() ? "待补充" : "—"))}</td>
          <td><span class="status ${item.status === "confirmed" ? "good" : "warn"}">${item.status === "confirmed" ? "可用" : item.status === "unavailable" ? "不可用" : "待核验"}</span></td>
          <td class="row-actions">${canMaintainProductivity() ? `
            <button class="text-button edit-productivity" type="button" data-id="${escapeHtml(item.id)}">${isPersonalProductivityMode() ? "修改个人版本" : "修改"}</button>
            <button class="text-button danger delete-productivity" type="button" data-id="${escapeHtml(item.id)}">${isPersonalProductivityMode() ? "仅本人隐藏" : "删除"}</button>
            ` : '<span class="muted">当前账户只读</span>'}
          </td>
        </tr>`,
      )
      .join("")
    : `<tr><td colspan="10" class="empty-state">没有匹配的工效条目</td></tr>`;
}

function setNewHierarchyInput(input, visible) {
  input.hidden = !visible;
  input.required = visible;
  if (!visible) input.value = "";
}

function refreshFormSubitems(wanted = "") {
  const division = qs("#form-division").value;
  const select = qs("#form-subitem");
  const subitems = division === "__new__" ? [] : librarySubitems(division);
  select.innerHTML = `<option value="" disabled>请选择分项工程</option>${subitems.map((name) =>
    `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join("")}<option value="__new__">＋ 新增分项工程</option>`;
  select.disabled = !division;
  select.value = wanted && (wanted === "__new__" || subitems.includes(wanted)) ? wanted : division === "__new__" ? "__new__" : "";
  setNewHierarchyInput(qs("#form-new-subitem"), select.value === "__new__");
}

function refreshFormDivisions(wanted = "", subitemWanted = "") {
  const select = qs("#form-division");
  const divisions = libraryDivisions();
  select.innerHTML = `<option value="" disabled>请选择分部工程</option>${divisions.map((name) =>
    `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join("")}<option value="__new__">＋ 新增分部工程</option>`;
  select.value = wanted && (wanted === "__new__" || divisions.includes(wanted)) ? wanted : "";
  setNewHierarchyInput(qs("#form-new-division"), select.value === "__new__");
  refreshFormSubitems(subitemWanted);
}

function formHierarchy() {
  return {
    division: (qs("#form-division").value === "__new__"
      ? qs("#form-new-division").value : qs("#form-division").value).trim(),
    subitem: (qs("#form-subitem").value === "__new__"
      ? qs("#form-new-subitem").value : qs("#form-subitem").value).trim(),
  };
}

function normalizeRole(role) {
  const normalized = role.trim().replaceAll("中方技术员", "中籍");
  return normalized === "外籍" ? "外籍技工" : normalized;
}

function parseCrewConfiguration(text) {
  const crew = {};
  const parts = text.includes(":") || text.includes("：")
    ? text.split(/[，,]/)
    : text.split("+");
  for (const rawPart of parts.map((item) => item.trim()).filter(Boolean)) {
    const colonParts = rawPart.split(/[:：]/).map((item) => item.trim());
    let role;
    let count;
    if (colonParts.length === 2) {
      role = normalizeRole(colonParts[0]);
      count = Number(colonParts[1]);
    } else {
      const part = rawPart.replace(/\s+/g, "");
      const roleFirst = part.match(/^([^\d]+)(\d+(?:\.\d+)?)$/);
      const numberFirst = part.match(/^(\d+(?:\.\d+)?)([^\d]+)$/);
      role = normalizeRole(roleFirst?.[1] ?? numberFirst?.[2] ?? "");
      count = Number(roleFirst?.[2] ?? numberFirst?.[1]);
    }
    if (!role || !Number.isFinite(count) || count <= 0) {
      throw new Error(`无法识别班组配置“${rawPart}”`);
    }
    crew[role] = (crew[role] ?? 0) + count;
  }
  if (!Object.keys(crew).length) throw new Error("请填写班组配置");
  return {
    crew,
    crewText: Object.entries(crew).map(([role, count]) => `${role}${count}`).join(" + "),
  };
}

function syncProductivityFormRequirements() {
  const form = qs("#productivity-form");
  const required = form.elements.status.value !== "unavailable";
  for (const name of ["crewText", "output", "productivityUnit"]) form.elements[name].required = required;
  if (isPersonalProductivityMode() && form.dataset.productivityMode === "role_productivity") form.elements.output.required = false;
}

function resetProductivityForm() {
  const form = qs("#productivity-form");
  form.reset();
  form.elements.id.value = "";
  delete form.dataset.productivityMode;
  delete form.dataset.roleProductivity;
  delete form.dataset.productivityPreservedFields;
  form.elements.status.value = "confirmed";
  syncProductivityFormRequirements();
  refreshFormDivisions();
  qs("#productivity-form-title").textContent = isPersonalProductivityMode() ? "新增个人工效" : "新增工效";
  qs("#save-productivity").textContent = isPersonalProductivityMode() ? "新增个人工效" : "新增工效";
  qs("#cancel-edit").hidden = true;
}

function beginEdit(item) {
  const form = qs("#productivity-form");
  form.elements.id.value = item.id;
  // Editing an existing public entry must not silently turn a pump-hour or
  // role-based record into a crew-day record. The private form keeps its old mode.
  if (isPersonalProductivityMode()) {
    form.dataset.productivityMode = item.mode || "crew_day";
    form.dataset.roleProductivity = JSON.stringify(item.roleProductivity ?? {});
    // Preserve editable data that this compact form does not display. Never
    // copy account, permissions or server provenance into the write request.
    form.dataset.productivityPreservedFields = JSON.stringify({
      notes: item.notes ?? "", equipment: item.equipment ?? [], source: item.source ?? "后续补充",
    });
  }
  refreshFormDivisions(item.division || "其他工程", item.subitem || "未分类分项");
  form.elements.category.value = item.category;
  form.elements.name.value = item.name;
  form.elements.crewText.value = item.crewText || crewText(item.crew);
  form.elements.output.value = item.output ?? "";
  form.elements.productivityUnit.value = item.productivityUnit ?? "";
  form.elements.workContent.value = item.workContent ?? "";
  form.elements.status.value = item.status ?? "confirmed";
  syncProductivityFormRequirements();
  qs("#productivity-form-title").textContent = isPersonalProductivityMode() ? "修改个人工效版本" : "修改工效";
  qs("#save-productivity").textContent = isPersonalProductivityMode() ? "保存个人修改" : "保存修改";
  qs("#cancel-edit").hidden = false;
  qs("#save-message").textContent = "";
  qs(".sticky-card").scrollIntoView({ behavior: "smooth", block: "start" });
}

async function refreshProductivity() {
  state.productivity = (await api("/api/productivity")).items;
  refreshLibraryDivisionFilter();
  refreshFormDivisions(qs("#form-division").value, qs("#form-subitem").value);
  renderLibrary();
  rebuildWorkRowOptions();
}

function productivityFormPayload(form) {
  const productivityUnit = form.elements.productivityUnit.value.trim();
  const crewConfiguration = form.elements.crewText.value.trim()
    ? parseCrewConfiguration(form.elements.crewText.value)
    : { crew: {}, crewText: "" };
  const preserved = isPersonalProductivityMode() && form.elements.id.value
    ? JSON.parse(form.dataset.productivityPreservedFields || "{}") : {};
  return {
    ...preserved,
    ...formHierarchy(),
    category: form.elements.category.value,
    name: form.elements.name.value,
    unit: productivityUnit.split("/")[0].trim(),
    mode: isPersonalProductivityMode() ? form.dataset.productivityMode || "crew_day" : "crew_day",
    ...(isPersonalProductivityMode() && form.dataset.productivityMode === "role_productivity"
      ? { roleProductivity: JSON.parse(form.dataset.roleProductivity || "{}") } : {}),
    crew: crewConfiguration.crew,
    crewText: crewConfiguration.crewText,
    output: form.elements.output.value === "" ? null : Number(form.elements.output.value),
    productivityUnit,
    workContent: form.elements.workContent.value,
    source: preserved.source ?? "人工新增工效",
    status: form.elements.status.value,
  };
}

qsa(".tab").forEach((button) => {
  button.addEventListener("click", () => {
    qsa(".tab").forEach((item) => item.classList.toggle("is-active", item === button));
    qsa(".tab-panel").forEach((panel) => panel.classList.toggle("is-active", panel.id === button.dataset.tab));
    if (button.dataset.tab === "history") refreshHistory().catch(showHistoryError);
  });
});

qs("#add-division").addEventListener("click", () => addDivision());
qs("#ratio-form").addEventListener("submit", (event) => event.preventDefault());
qsa("#ratio-form input").forEach((input) => input.addEventListener("input", () => updateRatioStatus()));
qs("#reset-ratios").addEventListener("click", () => {
  for (const [type, value] of Object.entries(DEFAULT_RATIOS)) qs(`#${type}-percent`).value = value;
  updateRatioStatus();
});
qs("#calendar-form").addEventListener("submit", (event) => event.preventDefault());
qsa("#calendar-form input").forEach((input) => input.addEventListener("input", updateCalendarStatus));
qs("#ramadan-mode").addEventListener("change", () => {
  setRamadanVisibility();
  updateCalendarStatus();
});
qs("#add-ramadan-range").addEventListener("click", () => addRamadanRange());
qs("#reset-calendar").addEventListener("click", () => {
  qs("#winter-start").value = DEFAULT_CALENDAR_RULES.winter.start;
  qs("#winter-end").value = DEFAULT_CALENDAR_RULES.winter.end;
  qs("#summer-start").value = DEFAULT_CALENDAR_RULES.summer.start;
  qs("#summer-end").value = DEFAULT_CALENDAR_RULES.summer.end;
  qs("#ramadan-mode").value = "auto";
  qs("#ramadan-ranges").replaceChildren();
  setRamadanVisibility();
  updateCalendarStatus();
});

qs("#plan-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!qs("#ratio-form").checkValidity()) {
    qs('.tab[data-tab="ratios"]').click();
    qs("#ratio-form").reportValidity();
    return;
  }
  if (!qs("#calendar-form").checkValidity()) {
    qs('.tab[data-tab="ratios"]').click();
    qs("#calendar-form").reportValidity();
    return;
  }
  try {
    resolveCalendarRules(collectCalendarRules());
  } catch (error) {
    qs('.tab[data-tab="ratios"]').click();
    qs("#calendar-status").textContent = error.message;
    qs("#calendar-status").className = "hint is-error";
    return;
  }
  const button = event.submitter;
  button.disabled = true;
  button.textContent = "GPT正在判断全项目顺序并测算…";
  qs("#plan-message").className = "hint";
  qs("#plan-message").textContent = "正在判断施工顺序并核对单班组白班工期；不足时比较早晚班、多班组白班及有条件的单班组白班搭接；单班组搭接仍不足时，再核对多班组白班搭接，请稍候。";
  try {
    if (globalThis.workforceUI) {
      await globalThis.workforceUI.requestPlan(collectPlan());
      return;
    }
    if (globalThis.WORKFORCE_PUBLIC_MODE === true) throw new Error("公开版测算连接层不可用，未调用模型 API。");
    const plan = await api("/api/workforce-plan", { method: "POST", body: JSON.stringify(collectPlan()) });
    renderPlan(plan);
    qs("#plan-message").textContent = plan.history ? "已完成施工逻辑判断与劳动力测算，结果已保存。" : "已完成施工逻辑判断与劳动力测算。";
  } catch (error) {
    qs("#plan-message").className = "hint is-error";
    qs("#plan-message").textContent = error.message;
  } finally {
    button.disabled = false;
    button.textContent = "生成劳动力方案";
  }
});

qs("#result-content").addEventListener("click", (event) => {
  if (handleChartClick(event, qs("#result-content"), state.lastPlan)) return;
  const button = event.target.closest(".plan-option[data-option-id]");
  if (button) choosePlanOption(qs("#result-content"), state.lastPlan, button.dataset.optionId);
});

qs("#history-detail-content").addEventListener("click", (event) => {
  if (handleChartClick(event, qs("#history-detail-content"), state.historyPlan)) return;
  const button = event.target.closest(".plan-option[data-option-id]");
  if (button) choosePlanOption(qs("#history-detail-content"), state.historyPlan, button.dataset.optionId);
});

qs("#result-content").addEventListener("change", (event) => handleChartChange(event, qs("#result-content"), state.lastPlan));
qs("#history-detail-content").addEventListener("change", (event) => handleChartChange(event, qs("#history-detail-content"), state.historyPlan));

qs("#history-search").addEventListener("input", (event) => renderHistory(event.target.value));
qs("#close-history-detail").addEventListener("click", () => {
  qs("#history-detail").hidden = true;
  state.selectedHistoryId = null;
  state.historyPlan = null;
});
qs("#history-rows").addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-id]");
  if (!button) return;
  const record = state.history.find((item) => item.id === button.dataset.id);
  if (!record) return;
  button.disabled = true;
  try {
    if (button.classList.contains("view-history")) {
      const response = await api(`/api/workforce-history/${encodeURIComponent(record.id)}`);
      showHistoryRecord(response.record);
      return;
    }
    if (!button.classList.contains("delete-history")) return;
    if (!await confirmAction(`确定删除 ${formatDateTime(record.createdAt)} 的测算记录吗？删除后无法从历史中恢复。`)) return;
    await api(`/api/workforce-history/${encodeURIComponent(record.id)}`, { method: "DELETE" });
    if (state.selectedHistoryId === record.id) {
      state.selectedHistoryId = null;
      state.historyPlan = null;
      qs("#history-detail").hidden = true;
    }
    await refreshHistory();
  } catch (error) {
    showHistoryError(error);
  } finally {
    button.disabled = false;
  }
});

qs("#download-json").addEventListener("click", () => {
  if (!state.lastPlan) return;
  if (globalThis.workforceUI) {
    globalThis.workforceUI.showJson(state.lastPlan);
    return;
  }
  const blob = new Blob([JSON.stringify(state.lastPlan, null, 2)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `劳动力方案_${state.lastPlan.project.startDate}_${state.lastPlan.project.endDate}.json`;
  link.click();
  URL.revokeObjectURL(link.href);
});

qs("#library-division-filter").addEventListener("change", () => {
  refreshLibrarySubitemFilter();
  renderLibrary();
});
qs("#library-subitem-filter").addEventListener("change", () => {
  refreshLibraryActivityFilter();
  renderLibrary();
});
qs("#library-activity-filter").addEventListener("change", renderLibrary);
qs("#library-search").addEventListener("input", renderLibrary);
qs("#clear-library-filters").addEventListener("click", () => {
  qs("#library-division-filter").value = "";
  qs("#library-search").value = "";
  refreshLibrarySubitemFilter();
  renderLibrary();
});
qs("#form-division").addEventListener("change", () => {
  setNewHierarchyInput(qs("#form-new-division"), qs("#form-division").value === "__new__");
  refreshFormSubitems();
});
qs("#form-subitem").addEventListener("change", () => {
  setNewHierarchyInput(qs("#form-new-subitem"), qs("#form-subitem").value === "__new__");
});
qs("#cancel-edit").addEventListener("click", () => {
  resetProductivityForm();
  qs("#save-message").textContent = "";
});

qs("#library-rows").addEventListener("click", async (event) => {
  if (!canMaintainProductivity()) return;
  const button = event.target.closest("button[data-id]");
  if (!button) return;
  const item = state.productivity.find((entry) => entry.id === button.dataset.id);
  if (!item) return;
  if (button.classList.contains("edit-productivity")) {
    beginEdit(item);
    return;
  }
  if (!button.classList.contains("delete-productivity")) return;
  const confirmation = isPersonalProductivityMode()
    ? `确定仅对本人隐藏“${item.name}”吗？该工效将不再供你后续测算选择；共享库、其他用户和已保存历史不受影响。`
    : `确定删除“${item.name}”吗？删除后该工效将不再参与劳动力测算。`;
  if (!await confirmAction(confirmation)) return;
  button.disabled = true;
  try {
    await api(`/api/productivity/${encodeURIComponent(item.id)}`, { method: "DELETE" });
    if (qs("#productivity-form").elements.id.value === item.id) resetProductivityForm();
    await refreshProductivity();
  } catch (error) {
    if (globalThis.workforceUI) globalThis.workforceUI.notify(error.message);
    else alert(error.message);
    button.disabled = false;
  }
});

qs("#productivity-form").elements.status.addEventListener("change", syncProductivityFormRequirements);

qs("#productivity-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!canMaintainProductivity()) {
    qs("#save-message").textContent = "当前连接尚未启用个人工效编辑，请刷新后重试；不会修改共享工效库。";
    return;
  }
  const form = event.currentTarget;
  const message = qs("#save-message");
  const button = event.submitter;
  button.disabled = true;
  try {
    const payload = productivityFormPayload(form);
    const id = form.elements.id.value;
    const result = await api(id ? `/api/productivity/${encodeURIComponent(id)}` : "/api/productivity", {
      method: id ? "PUT" : "POST",
      body: JSON.stringify(payload),
    });
    resetProductivityForm();
    message.className = "hint is-success";
    message.textContent = isPersonalProductivityMode()
      ? `已保存个人工效：${result.saved.name}。仅本人后续测算采用，不影响共享库、其他用户及已保存历史。`
      : `已保存：${result.saved.name}`;
    await refreshProductivity();
  } catch (error) {
    message.className = "hint is-error";
    message.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

try {
  configureProductivityScope();
  if (!canMaintainProductivity()) qs("#productivity-maintenance").hidden = true;
  await refreshProductivity();
  addDivision();
  loadRatioSettings();
  loadCalendarSettings();
  const gptStatus = await api("/api/gpt-status");
  qs("#gpt-status").textContent = gptStatus.message;
  qs("#gpt-status").className = gptStatus.configured ? "hint is-success" : "hint is-error";
  if (globalThis.workforceUI) await globalThis.workforceUI.initialize({
    captureDraft: captureEmbeddedDraft,
    restoreDraft: restoreEmbeddedDraft,
    collectPlan,
    renderPlan,
    refreshHistory,
    refreshProductivity,
    showHistoryRecord,
  });
} catch (error) {
  if (globalThis.WORKFORCE_PUBLIC_MODE !== true || globalThis.workforcePublicSession?.authenticated) {
    document.body.innerHTML = `<main><section class="panel"><h1>启动失败</h1><p>${escapeHtml(error.message)}</p></section></main>`;
  }
}
