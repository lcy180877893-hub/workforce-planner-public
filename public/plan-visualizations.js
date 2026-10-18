import { getTimelineRange, dateOffset, buildWorkforceDays, aggregateWorkforceDays } from "./schedule-charts.js";

const escape = (value) => String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
const number = (value) => new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 }).format(value ?? 0);
const isDayOverlap = (option) => ["single-crew-day-overlap", "multi-crew-day-overlap"].some((mode) => option?.id === mode || option?.staffingMode === mode);

export function normalizeChartView(value = {}) {
  return {
    scope: value.scope === "project" ? "project" : "active",
    granularity: ["day", "week", "month"].includes(value.granularity) ? value.granularity : "auto",
    zoom: [1, 2, 4].includes(Number(value.zoom)) ? Number(value.zoom) : 1,
  };
}

function controls(view, range) {
  return `<div class="schedule-chart-controls">
    <label>显示范围<select data-chart-control="scope" aria-label="图表显示范围"><option value="active"${view.scope === "active" ? " selected" : ""}>实际施工范围</option><option value="project"${view.scope === "project" ? " selected" : ""}>项目全部工期</option></select></label>
    <label>柱状图时间粒度<select data-chart-control="granularity" aria-label="柱状图时间粒度">${[["auto", "自动"], ["day", "按日"], ["week", "按周"], ["month", "按月"]].map(([value, label]) => `<option value="${value}"${view.granularity === value ? " selected" : ""}>${label}</option>`).join("")}</select></label>
    <div class="chart-zoom" role="group" aria-label="图表缩放"><button type="button" class="text-button" data-chart-zoom="${Math.max(1, view.zoom / 2)}"${view.zoom === 1 ? " disabled" : ""} aria-label="缩小图表">− 缩小</button><span aria-live="polite">${view.zoom}×</span><button type="button" class="text-button" data-chart-zoom="${Math.min(4, view.zoom * 2)}"${view.zoom === 4 ? " disabled" : ""} aria-label="放大图表">＋ 放大</button><button type="button" class="text-button" data-chart-zoom="1">适合窗口</button></div>
  </div><p class="source-rule chart-range-label">当前显示 ${escape(range.startDate)} 至 ${escape(range.endDate)} · ${number(range.durationDays)} 天；缩放仅改变显示，不改变施工日期或人员。</p>`;
}

function workforceMarkup(workItems, option, project, range, view) {
  const days = buildWorkforceDays(workItems, { ...option, project });
  const series = aggregateWorkforceDays(days, { ...range, granularity: view.granularity, maxBars: 36 });
  const bins = series.bins;
  const peak = Math.max(0, ...bins.map((bin) => bin.peakHeadcount));
  const totalPersonDays = bins.reduce((total, bin) => total + bin.personDays, 0);
  const chartWidth = Math.max(520, bins.length * 44) * view.zoom;
  const ceiling = Math.max(1, Math.ceil(peak));
  const grouped = series.granularity !== "day";
  const bars = bins.map((bin) => {
    const label = `${bin.startDate}${bin.startDate === bin.endDate ? "" : ` 至 ${bin.endDate}`}：${grouped ? "周期峰值 " : ""}${number(bin.peakHeadcount)} 人，${number(bin.personDays)} 人日`;
    const dateLabel = `${escape(bin.startDate.slice(5))}${bin.startDate === bin.endDate ? "" : `<br>—${escape(bin.endDate.slice(5))}`}`;
    return `<div class="workforce-column" data-start-date="${escape(bin.startDate)}" data-end-date="${escape(bin.endDate)}" data-headcount="${bin.peakHeadcount}" aria-label="${escape(label)}" title="${escape(label)}"><div class="workforce-mark"><div class="workforce-stick" style="height:${bin.peakHeadcount / ceiling * 100}%">${bins.length <= 36 ? `<span>${number(bin.peakHeadcount)}</span>` : ""}</div></div><span class="workforce-date">${dateLabel}</span></div>`;
  }).join("");
  return `<section class="workforce-chart" aria-label="劳动力柱状图">
    <div class="gantt-heading"><h3>劳动力柱状图</h3><p>全日配备峰值 ${number(peak)} 人 · ${number(totalPersonDays)} 人日（8小时/人日）</p></div>
    <p class="source-rule">${grouped ? "每根柱为该周期内每日人数的最大值，不是人数相加或平均值。" : isDayOverlap(option) ? "每根柱为当天同时施工的各工序独立白班班组人数之和，不是全项目只配一个班组。" : "每根柱为当天安排的各班人员合计，不是单班同时在岗人数。"} 完工后的空余工期不安排人员；仅含已测算工序。</p>
    <div class="schedule-chart-scroll"><div class="workforce-plot" style="min-width:${chartWidth}px" role="img" aria-label="${escape(`${series.metricLabel}，显示${range.startDate}至${range.endDate}，峰值${number(peak)}人，总${number(totalPersonDays)}人日`)}"><div class="workforce-y-axis"><span>人数</span><span>${number(ceiling)}</span><span>${number(ceiling / 2)}</span><span>0</span></div><div class="workforce-bars">${bars}</div></div></div>
    <details class="chart-data"><summary>查看柱状图数据</summary><div class="work-table-wrap"><table class="compact-table"><thead><tr><th>日期 / 周期</th><th>${grouped ? "周期峰值人数" : "每日配备人数"}</th><th>单班在岗峰值</th><th>人日</th></tr></thead><tbody>${bins.map((bin) => `<tr><td>${escape(bin.startDate)}${bin.startDate === bin.endDate ? "" : ` 至 ${escape(bin.endDate)}`}</td><td>${number(bin.peakHeadcount)}</td><td>${number(bin.peakOnShiftHeadcount)}</td><td>${number(bin.personDays)}</td></tr>`).join("")}</tbody></table></div></details>
  </section>`;
}

function ganttMarkup(workItems, option, project, range, view) {
  const duration = range.durationDays;
  const fractions = duration <= 5 ? Array.from({ length: duration }, (_, i) => duration === 1 ? 0 : i / (duration - 1)) : [0, 0.25, 0.5, 0.75, 1];
  const ticks = [...new Set(fractions.map((fraction) => Math.round((duration - 1) * fraction)))].map((offset) => {
    const date = new Date(`${range.startDate}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() + offset);
    const text = date.toISOString().slice(0, 10);
    const alignment = duration > 5 && offset === 0 ? 0 : duration > 5 && offset === duration - 1 ? 100 : 50;
    return `<span data-tick-date="${text}" style="left:${(offset + 0.5) / duration * 100}%;transform:translateX(-${alignment}%)">${text}</span>`;
  }).join("");
  const rows = workItems.map((item, index) => {
    const start = dateOffset(item.startDate, range.startDate);
    const end = dateOffset(item.endDate, range.startDate);
    const scheduled = (!item.status || item.status === "calculated") && start != null && end != null;
    const left = scheduled ? Math.max(0, Math.min(100, start / duration * 100)) : 0;
    const width = scheduled ? Math.max(0, Math.min(100 - left, (end - Math.max(0, start) + 1) / duration * 100)) : 0;
    const count = Math.max(0, ...buildWorkforceDays([item], { ...option, project }).map((day) => day.headcount));
    const label = `${item.startDate} 至 ${item.endDate} · ${item.durationDays ?? end - start + 1}天 · 全日配备峰值${number(count)}人`;
    return `<div class="gantt-row"><div class="gantt-name"><strong>${escape(item.hierarchyNumber ?? item.sequence ?? index + 1)} · ${escape(item.name)}</strong>${[item.divisionRemark, item.remark].filter(Boolean).length ? `<span class="scope-label">${escape([item.divisionRemark, item.remark].filter(Boolean).join(" · "))}</span>` : ""}</div><div class="gantt-track">${scheduled ? `<div class="gantt-bar" style="left:${left}%;width:${width}%" data-start-date="${escape(item.startDate)}" data-end-date="${escape(item.endDate)}" title="${escape(label)}" aria-label="${escape(label)}"><span>${number(count)}人</span></div>` : '<span class="gantt-unscheduled">待补充工效，未排程</span>'}</div><div class="gantt-dates">${scheduled ? `${escape(item.startDate)}<br>至 ${escape(item.endDate)}` : "—"}</div></div>`;
  }).join("");
  return `<section class="gantt-card"><div class="gantt-heading"><h3>施工横道图${option.staffingMode || isDayOverlap(option) ? ` · ${escape(option.name)}` : ""}</h3><p>计划完工：${escape(option.finishDate || "暂无")} · 工期余量：${number(option.slackDays)}天</p></div><div class="schedule-chart-scroll"><div class="gantt-inner" style="min-width:${680 * view.zoom}px"><div class="gantt-axis"><span>工序</span><div class="gantt-ticks">${ticks}</div><span>计划日期</span></div>${rows}</div></div><p class="gantt-footnote">默认按实际施工日期展开，可切换至全部工期并放大。横条按日历天显示，早晚班不在日内细分；日期和施工前置关系不会因缩放改变。${isDayOverlap(option) ? "横条日期重叠表示不同工序各自配置白班班组并行施工，允许搭接的条件和依据见本次施工逻辑判断；并非忽略技术前置或共用一套人员。" : option.staffingMode ? "" : "此为旧版历史方案，按原测算安排显示。"}</p></section>`;
}

export function renderScheduleVisualizations(plan, workItems, option, settings = {}) {
  if (!option) return '<div class="notice">此历史记录生成于排程功能启用前，没有施工图表。</div>';
  const view = normalizeChartView(settings);
  const displayItems = workItems.map((item) => {
    if (item.startDate != null || item.endDate != null || !Number.isInteger(item.startDay) || !Number.isInteger(item.endDay)) return item;
    const projectStart = new Date(`${plan.project.startDate}T00:00:00Z`);
    if (!Number.isFinite(projectStart.getTime()) || item.startDay < 0 || item.endDay < item.startDay) return item;
    const date = (offset) => new Date(projectStart.getTime() + offset * 86400000).toISOString().slice(0, 10);
    return { ...item, startDate: date(item.startDay), endDate: date(item.endDay) };
  });
  const range = getTimelineRange(plan.project, displayItems, view);
  if (!range) return '<div class="notice">没有可排程的工序，补齐工效后再显示施工图表。</div>';
  return `<section class="schedule-visualizations" aria-label="劳动力及施工图表"><h3>劳动力与施工图表</h3>${controls(view, range)}${workforceMarkup(displayItems, option, plan.project, range, view)}${ganttMarkup(displayItems, option, plan.project, range, view)}</section>`;
}
