import test from "node:test";
import assert from "node:assert/strict";
import { renderScheduleVisualizations, normalizeChartView } from "../public/plan-visualizations.js";

const workItems = [
  { sequence: 1, hierarchyNumber: "1.1.1", name: "基础开挖", status: "calculated", startDate: "2026-10-01", endDate: "2026-10-03", durationDays: 3, peakCrew: { 中籍: 1, 外籍技工: 2, 杂工: 2 }, crewPerShift: { 中籍: 1, 外籍技工: 2, 杂工: 2 }, shiftsPerDay: 1 },
  { sequence: 2, hierarchyNumber: "2.1.1", name: "基础垫层浇筑", status: "calculated", startDate: "2026-10-04", endDate: "2026-10-04", durationDays: 1, peakCrew: { 中籍: 1, 外籍技工: 2, 杂工: 6 }, crewPerShift: { 中籍: 1, 外籍技工: 2, 杂工: 6 }, shiftsPerDay: 1 },
];
const project = { startDate: "2026-10-01", endDate: "2027-05-31", durationDays: 243 };
const option = { id: "sequential", name: "顺序施工", staffingMode: "single-crew-day", finishDate: "2026-10-04", slackDays: 239, workItems };
const plan = { project };

test("图表默认实际4天范围，三天与一天横条为75%/25%，柱为5/5/5/9", () => {
  const html = renderScheduleVisualizations(plan, workItems, option);
  assert.match(html, /当前显示 2026-10-01 至 2026-10-04 · 4 天/);
  assert.match(html, /left:0%;width:75%/);
  assert.match(html, /left:75%;width:25%/);
  assert.deepEqual([...html.matchAll(/data-headcount="([\d.]+)"/g)].map((match) => Number(match[1])), [5, 5, 5, 9]);
  assert.match(html, /全日配备峰值 9 人 · 24 人日/);
  assert.match(html, /aria-label="劳动力柱状图"/);
  assert.match(html, /data-tick-date="2026-10-01" style="left:12.5%/);
  assert.match(html, /data-tick-date="2026-10-04" style="left:87.5%/);
});

test("项目全周期与日周月控制保持真实日期，缩放只加宽视图", () => {
  const before = JSON.stringify({ plan, workItems, option });
  const html = renderScheduleVisualizations(plan, workItems, option, { scope: "project", zoom: 4, granularity: "week" });
  assert.match(html, /2026-10-01 至 2027-05-31 · 243 天/);
  assert.match(html, /周期内每日人数的最大值/);
  assert.match(html, /min-width:2720px/);
  assert.match(html, /data-start-date="2026-10-04" data-end-date="2026-10-04"/);
  assert.equal(JSON.stringify({ plan, workItems, option }), before);
});

test("单日横道占满实际范围，不会因零天分母消失", () => {
  const html = renderScheduleVisualizations(plan, [workItems[1]], option);
  assert.match(html, /left:0%;width:100%/);
  assert.match(html, /2026-10-04 至 2026-10-04 · 1 天/);
  assert.doesNotMatch(html, /NaN|Infinity/);
});

test("工序、备注等不可信数据必须转义，不能插入可执行标记", () => {
  const html = renderScheduleVisualizations(plan, [{ ...workItems[0], name: '<img src=x onerror="alert(1)">', remark: '<script>bad()</script>' }], option);
  assert.doesNotMatch(html, /<img|<script>/);
  assert.match(html, /&lt;img/);
  assert.match(html, /&lt;script&gt;/);
});

test("无方案时给出旧记录提示，显示设置只接受有效选项", () => {
  assert.match(renderScheduleVisualizations(plan, [], null), /没有施工图表/);
  assert.deepEqual(normalizeChartView({ scope: "bad", granularity: "bad", zoom: 1000 }), { scope: "active", granularity: "auto", zoom: 1 });
  assert.deepEqual(normalizeChartView({ scope: "project", granularity: "month", zoom: "2" }), { scope: "project", granularity: "month", zoom: 2 });
});

test("横道人数按实际已安排班次显示，单日无晚班不显示两套人员", () => {
  const item = { ...workItems[1], shiftsPerDay: 2, lastDayShifts: 1, crewPerShift: { 技工: 4 }, peakCrew: { 技工: 8 } };
  const html = renderScheduleVisualizations(plan, [item], { ...option, shiftsPerDay: 2 });
  assert.match(html, /全日配备峰值4人/);
  assert.doesNotMatch(html, /全日配备峰值8人/);
});

test("旧记录只有日期偏移和无status时，柱状图与横道使用相同日期", () => {
  const item = { name: "旧工序", startDay: 2, endDay: 3, peakCrew: { 技工: 4 } };
  const html = renderScheduleVisualizations(plan, [item], { ...option, staffingMode: undefined });
  assert.match(html, /data-start-date="2026-10-03" data-end-date="2026-10-04"/);
  assert.match(html, /left:0%;width:100%/);
  assert.match(html, /此为旧版历史方案/);
});

test("白班多工序搭接横条实际重叠，柱状图合计独立班组且缩放不改日期或记录", () => {
  const items = [
    { ...workItems[0], crewsPerShift: 1, requiredCrews: 1 },
    { ...workItems[1], startDate: "2026-10-02", endDate: "2026-10-04", durationDays: 3,
      crewsPerShift: 1, requiredCrews: 1 },
  ];
  const overlap = { ...option, id: "single-crew-day-overlap", name: "单班组白班多工序搭接", staffingMode: "single-crew-day-overlap", shiftsPerDay: 1 };
  const before = JSON.stringify({ plan, items, overlap });
  for (const zoom of [1, 2, 4]) {
    const html = renderScheduleVisualizations(plan, items, overlap, { granularity: "day", zoom });
    assert.match(html, /施工横道图 · 单班组白班多工序搭接/);
    assert.match(html, /left:0%;width:75%/);
    assert.match(html, /left:25%;width:75%/);
    assert.match(html, /data-start-date="2026-10-02" data-end-date="2026-10-04"/);
    assert.deepEqual([...html.matchAll(/data-headcount="([\d.]+)"/g)].map((match) => Number(match[1])), [5, 14, 14, 9]);
    assert.match(html, /全日配备峰值 14 人 · 42 人日/);
    assert.match(html, /各工序独立白班班组人数之和/);
    assert.match(html, /不同工序各自配置白班班组并行施工/);
    assert.match(html, new RegExp(`min-width:${680 * zoom}px`));
  }
  assert.equal(JSON.stringify({ plan, items, overlap }), before);
});

test("多班组白班搭接横条和缩放保留真实日期，柱状图不再次乘已汇总班组数", () => {
  const items = [
    { ...workItems[0], crewsPerShift: 3, requiredCrews: 3, crewPerShift: { 钢筋工: 12 }, peakCrew: { 钢筋工: 12 } },
    { ...workItems[1], startDate: "2026-10-02", endDate: "2026-10-04", durationDays: 3,
      crewsPerShift: 2, requiredCrews: 2, crewPerShift: { 钢筋工: 6 }, peakCrew: { 钢筋工: 6 } },
  ];
  const overlap = { ...option, id: "multi-crew-day-overlap", name: "多班组白班多工序搭接", staffingMode: "multi-crew-day-overlap", shiftsPerDay: 1 };
  const before = JSON.stringify({ plan, items, overlap });
  for (const zoom of [1, 2, 4]) {
    const html = renderScheduleVisualizations(plan, items, overlap, { granularity: "day", zoom });
    assert.match(html, /施工横道图 · 多班组白班多工序搭接/);
    assert.match(html, /left:0%;width:75%/);
    assert.match(html, /left:25%;width:75%/);
    assert.match(html, /data-start-date="2026-10-02" data-end-date="2026-10-04"/);
    assert.deepEqual([...html.matchAll(/data-headcount="([\d.]+)"/g)].map((match) => Number(match[1])), [12, 18, 18, 6]);
    assert.match(html, /全日配备峰值 18 人 · 54 人日/);
    assert.match(html, /各工序独立白班班组人数之和/);
    assert.match(html, /不同工序各自配置白班班组并行施工/);
    assert.doesNotMatch(html, /每道工序各配 1 个/);
    assert.match(html, new RegExp(`min-width:${680 * zoom}px`));
  }
  assert.equal(JSON.stringify({ plan, items, overlap }), before);
});
