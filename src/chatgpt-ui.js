import { readFile } from "node:fs/promises";

// A versioned URI prevents ChatGPT from retaining an incompatible old bundle.
export const WORKFORCE_UI_URI = "ui://workforce/planner-v0.18.0.html";
export const CLOUD_WORKFORCE_UI_URI = "ui://workforce/public-planner-v0.19.1-rc.1.html";
export const WORKFORCE_UI_MIME = "text/html;profile=mcp-app";

export const uiResourceMetadata = Object.freeze({
  ui: {
    prefersBorder: false,
    csp: { connectDomains: [], resourceDomains: [], frameDomains: [] },
  },
  "openai/widgetDescription": "工程劳动力测算的四页工作台：劳动力测算、比例设置、测算历史、工效库。施工逻辑由当前ChatGPT会话判断，本机完成数值计算。",
  "openai/widgetPrefersBorder": false,
  "openai/widgetCSP": { connect_domains: [], resource_domains: [], frame_domains: [] },
});

const publicFile = (name) => readFile(new URL(`../public/${name}`, import.meta.url), "utf8");

function inlineScript(source, label) {
  // No project data is interpolated into executable HTML. Refuse ambiguous source
  // rather than allowing an accidental closing tag to escape its script block.
  if (/<\/script\s*[>/]/i.test(source)) throw new Error(`${label}含有不安全的script结束标记`);
  return `<script>\n${source}\n</script>`;
}

export async function buildWorkforceUI({ cloudMode = false } = {}) {
  const [index, styles, embeddedStyles, bridge, adapter, calendar, chartData, chartMarkup, app] = await Promise.all([
    publicFile("index.html"), publicFile("styles.css"), publicFile("chatgpt.css"),
    publicFile("chatgpt-bridge.js"), publicFile("chatgpt-ui.js"),
    publicFile("calendar.js"), publicFile("schedule-charts.js"), publicFile("plan-visualizations.js"), publicFile("app.js"),
  ]);
  const stylesheet = /<link\s+rel="stylesheet"\s+href="\/styles\.css[^\"]*"\s*\/>/;
  const appTag = /<script\s+type="module"\s+src="\/app\.js[^\"]*"><\/script>/;
  const publicModeTag = /<script\s+src="\/public-mode\.js[^\"]*"><\/script>\s*/;
  const calendarImport = /^import\s+\{\s*DEFAULT_CALENDAR_RULES,\s*resolveCalendarRules\s*\}\s+from\s+"\.\/calendar\.js";\s*/;
  const chartImport = /^import\s+\{\s*renderScheduleVisualizations,\s*normalizeChartView\s*\}\s+from\s+"\.\/plan-visualizations\.js";\s*/m;
  const chartDataImport = /^import\s+\{[^\n]+\}\s+from\s+"\.\/schedule-charts\.js";\s*/m;
  if (!stylesheet.test(index) || !appTag.test(index) || !calendarImport.test(app) || !chartImport.test(app) || !chartDataImport.test(chartMarkup)) {
    throw new Error("网站入口已变化，需要更新ChatGPT界面打包器");
  }
  if (/<\/style\s*[>/]/i.test(styles + embeddedStyles)) throw new Error("样式含有不安全的style结束标记");
  // Keep calendar internals in their own scope, exactly as in the website's ES module.
  const calendarModule = `const { DEFAULT_CALENDAR_RULES, resolveCalendarRules } = (() => {\n${calendar.replace(/^export\s+/gm, "")}\nreturn { DEFAULT_CALENDAR_RULES, resolveCalendarRules };\n})();`;
  const chartsModule = `const { renderScheduleVisualizations, normalizeChartView } = (() => {\n${chartData.replace(/^export\s+/gm, "")}\n${chartMarkup.replace(chartDataImport, "").replace(/^export\s+/gm, "")}\nreturn { renderScheduleVisualizations, normalizeChartView };\n})();`;
  const application = `(async () => {\n${calendarModule}\n${chartsModule}\n${app.replace(calendarImport, "").replace(chartImport, "")}\n})();`;
  const cloudScripts = cloudMode ? [
    inlineScript("globalThis.WORKFORCE_PUBLIC_MODE = true;", "公开模式标识"),
    inlineScript(await publicFile("public-mode.js"), "公开版身份隔离层"),
  ] : [];
  return index.replace(publicModeTag, "")
    .replace(stylesheet, `<style>\n${styles}\n${embeddedStyles}\n</style>`)
    .replace("<body>", '<body data-chatgpt-app="true">')
    .replace(appTag, [
      inlineScript(bridge, "ChatGPT连接层"),
      ...cloudScripts,
      inlineScript(adapter, "ChatGPT界面适配层"),
      inlineScript(application, "劳动力测算界面"),
    ].join("\n"));
}
