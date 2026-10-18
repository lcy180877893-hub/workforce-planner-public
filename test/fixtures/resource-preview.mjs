import { readFile, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import vm from "node:vm";
import { generateWorkforcePlan } from "../../src/planner.js";
import { buildProjectReviewContext } from "../../src/project-review.js";

const appUrl = new URL("../../public/app.js", import.meta.url);
const cssUrl = new URL("../../public/styles.css", import.meta.url);
const scheduleChartsUrl = new URL("../../public/schedule-charts.js", import.meta.url);
const planVisualizationsUrl = new URL("../../public/plan-visualizations.js", import.meta.url);

export async function loadUIRenderer() {
  const [appSource, scheduleChartsSource, planVisualizationsSource] = await Promise.all([
    readFile(appUrl, "utf8"), readFile(scheduleChartsUrl, "utf8"), readFile(planVisualizationsUrl, "utf8"),
  ]);
  const start = appSource.indexOf("const state =");
  const end = appSource.indexOf('qsa(".tab").forEach');
  if (start < 0 || end < start) throw new Error("UI renderer isolation boundaries changed");
  // Keep the real module implementations (and their separate lexical scopes)
  // when isolating app rendering from browser initialization. Stubbing chart
  // rendering would hide regressions in the production labels and semantics.
  const chartModule = scheduleChartsSource.replace(/^export /gm, "");
  const visualizationModule = planVisualizationsSource
    .replace(/^import \{[^\n]+\} from "\.\/schedule-charts\.js";\r?\n/m, "")
    .replace(/^export /gm, "");
  const source = `const { getTimelineRange, dateOffset, buildWorkforceDays, aggregateWorkforceDays } = (() => {
${chartModule}
return { getTimelineRange, dateOffset, buildWorkforceDays, aggregateWorkforceDays };
})();
const { renderScheduleVisualizations, normalizeChartView } = (() => {
${visualizationModule}
return { renderScheduleVisualizations, normalizeChartView };
})();
${appSource.slice(start, end)}`;
  const context = vm.createContext({ Intl, Date, Map });
  vm.runInContext(source, context);
  return {
    source,
    render(plan) {
      context.previewPlan = structuredClone(plan);
      return vm.runInContext("planMarkup(previewPlan)", context);
    },
    staffing(item, option, compact = false) {
      context.previewItem = structuredClone(item);
      context.previewOption = structuredClone(option);
      context.previewCompact = compact;
      return vm.runInContext("staffingText(previewItem, previewOption, previewCompact)", context);
    },
  };
}

export async function buildPreviewPlan(endDate = "2026-10-10") {
  const definitions = [
    { id: "preview-rebar", name: "钢筋绑扎/安装", category: "钢筋工", division: "主体结构工程", subitem: "钢筋工程", unit: "t", mode: "crew_day", output: 1, crew: { 中籍: 1, 外籍技工: 4, 杂工: 5 }, productivityUnit: "t/班组·8h", workContent: "示例钢筋绑扎安装", status: "confirmed", source: "隔离预览数据" },
    { id: "preview-pour", name: "混凝土浇筑", category: "混凝土工", division: "主体结构工程", subitem: "混凝土工程", unit: "m³", mode: "crew_day", output: 10, crew: { 中籍: 1, 外籍技工: 2, 杂工: 3 }, productivityUnit: "m³/班组·8h", workContent: "示例现浇混凝土浇筑", status: "confirmed", source: "隔离预览数据" },
    { id: "preview-finish", name: "砌体施工", category: "泥工", division: "建筑装饰装修工程", subitem: "砌体工程", unit: "m²", mode: "crew_day", output: 10, crew: { 外籍技工: 3, 杂工: 2 }, productivityUnit: "m²/班组·8h", workContent: "示例砌体施工", status: "confirmed", source: "隔离预览数据" },
  ];
  const store = { find: async (id) => structuredClone(definitions.find((item) => item.id === id) ?? null) };
  const input = {
    project: { name: "隔离预览 · 资源方案", context: "仅供界面验证的内存数据，不存测算历史；同一施工部位按钢筋、浇筑、砌体依次进行。", startDate: "2026-10-01", endDate },
    workItems: [
      { itemId: "preview-a", activityId: "preview-rebar", divisionId: "structure", subitemId: "steel", divisionRemark: "酒店A栋", quantity: 8, unit: "t" },
      { itemId: "preview-b", activityId: "preview-pour", divisionId: "structure", subitemId: "concrete", divisionRemark: "酒店A栋", quantity: 60, unit: "m³" },
      { itemId: "preview-c", activityId: "preview-finish", divisionId: "finish", subitemId: "masonry", divisionRemark: "酒店A栋", quantity: 40, unit: "m²" },
    ],
  };
  const context = await buildProjectReviewContext(input, store);
  const constructionReview = {
    fingerprint: context.fingerprint,
    summary: "同一工作面钢筋完成后浇筑，浇筑完成后再做砌体；各资源方案使用同一技术前置。",
    reviewedItemIds: input.workItems.map((item) => item.itemId),
    itemDecisions: input.workItems.map((item, index) => ({ itemId: item.itemId, sequenceStatus: "determined", reason: ["本次输入的首项工作，按已具备条件估算", "对应钢筋完成后方可浇筑", "对应结构工作完成后方可进行砌体施工"][index] })),
    dependencies: [
      { beforeItemId: "preview-a", afterItemId: "preview-b", reason: "同一工作面的钢筋绑扎完成后浇筑" },
      { beforeItemId: "preview-b", afterItemId: "preview-c", reason: "对应结构工作完成后再进行砌体施工" },
    ],
    parallelGroups: [], assumptions: ["只验证页面显示，不表示可直接用于现场实施"], questions: [],
  };
  return generateWorkforcePlan({ ...input, constructionReview }, store);
}

export async function buildResourcePreviewHtml() {
  const [renderer, css, tightPlan, roomyPlan] = await Promise.all([
    loadUIRenderer(), readFile(cssUrl, "utf8"), buildPreviewPlan(), buildPreviewPlan("2026-10-31"),
  ]);
  const plans = { tight: tightPlan, roomy: roomyPlan };
  const safeJson = JSON.stringify(plans).replaceAll("<", "\\u003c");
  const safeSource = renderer.source.replaceAll("</script", "<\\/script");
  return `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>隔离预览 · 劳动力资源方案</title><style>${css}</style></head><body><main><section class="panel"><h1>劳动力方案 · 隔离界面预览</h1><p>仅使用内存工效、项目和审查；不连接生产 API、模型或历史库。下方按钮可切换实际渲染的资源方案。</p></section><section class="panel"><h2>工期不足：增配方案</h2><div id="tight-preview">${renderer.render(tightPlan)}</div></section><section class="panel"><h2>工期足够：顺序施工</h2><div id="roomy-preview">${renderer.render(roomyPlan)}</div></section></main><script>${safeSource}\nconst resourcePreviewPlans = ${safeJson}; for (const key of ["tight", "roomy"]) { const container = qs("#" + key + "-preview"); container.addEventListener("click", (event) => { const button = event.target.closest(".plan-option[data-option-id]"); if (button) choosePlanOption(container, resourcePreviewPlans[key], button.dataset.optionId); }); }</script></body></html>`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outputPath = resolve(process.argv[2] || ".preview/resource-plan.html");
  const workspaceRoot = fileURLToPath(new URL("../../", import.meta.url));
  if (!outputPath.startsWith(workspaceRoot)) throw new Error("Preview output must remain inside workspace");
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, await buildResourcePreviewHtml(), "utf8");
  console.log(`Isolated resource preview generated: ${outputPath}`);
}
