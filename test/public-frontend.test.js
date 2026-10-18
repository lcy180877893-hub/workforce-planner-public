import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const publicSource = await readFile(new URL("../public/public-mode.js", import.meta.url), "utf8");
const widgetSource = await readFile(new URL("../public/chatgpt-ui.js", import.meta.url), "utf8");
const appSource = await readFile(new URL("../public/app.js", import.meta.url), "utf8");

class Element {
  constructor(tagName = "div") {
    this.tagName = tagName; this.children = []; this.listeners = {}; this.dataset = {};
    const names = new Set();
    this.classList = {
      add(...values) { values.forEach((value) => names.add(value)); },
      remove(...values) { values.forEach((value) => names.delete(value)); },
      contains(value) { return names.has(value); },
      toggle(value, force) { const add = force ?? !names.has(value); if (add) names.add(value); else names.delete(value); return add; },
    };
  }
  append(...values) { this.children.push(...values); }
  prepend(...values) { this.children.unshift(...values); }
  replaceChildren(...values) { this.children = values; }
  after(value) { this.afterNode = value; }
  addEventListener(name, callback) { this.listeners[name] = callback; }
  setAttribute(name, value) { this[name] = value; }
  querySelector(selector) { return this.children.find((entry) => entry.tagName === selector) ?? this.children.map((entry) => entry.querySelector?.(selector)).find(Boolean); }
  remove() { this.removed = true; }
  showModal() { this.open = true; }
  focus() {}
  select() {}
}

function makeDocument() {
  const elements = new Map();
  for (const selector of ["main", "#plan-message", ".eyebrow", "#ratios .source-rule", "#download-json", "#results"]) elements.set(selector, new Element());
  const tabs = new Map();
  for (const name of ["planner", "ratios", "history", "library"]) {
    const tab = new Element("button"); tab.dataset.tab = name;
    tab.classList.toggle("is-active", name === "planner");
    tab.click = () => { for (const item of tabs.values()) item.classList.toggle("is-active", item === tab); };
    tabs.set(name, tab);
  }
  const document = {
    body: new Element("body"), listeners: {}, createElement: (tag) => new Element(tag),
    addEventListener(name, callback) { (this.listeners[name] ??= []).push(callback); },
    querySelector(selector) {
      if (selector === ".tab.is-active") return [...tabs.values()].find((tab) => tab.classList.contains("is-active"));
      const match = selector.match(/^\.tab\[data-tab="(\w+)"\]$/); if (match) return tabs.get(match[1]);
      if (selector === "#workforce-send-fallback") return elements.get("#plan-message").afterNode;
      return elements.get(selector) ?? null;
    },
  };
  return { document, elements, tabs };
}

const accountA = { id: "auth0|a", displayName: "A", isAdmin: false, canEditProductivity: true, productivityScope: "personal" };
const accountB = { id: "auth0|b", displayName: "B", isAdmin: false, canEditProductivity: true, productivityScope: "personal" };
const payload = { project: { name: "项目", startDate: "2026-10-01", endDate: "2026-11-01" }, workItems: [{ itemId: "w1", quantity: 200, unit: "m" }] };

async function website({ account = accountA, authenticated = true, response, initialStorage = {}, enabled = true, fail = false } = {}) {
  const dom = makeDocument(); const calls = []; const writes = []; const assigned = [];
  const values = new Map(Object.entries(initialStorage));
  let currentAccount = account;
  const context = vm.createContext({
    WORKFORCE_PUBLIC_MODE: enabled, ...dom, document: dom.document,
    localStorage: { getItem: (key) => values.get(key) ?? null, setItem(key, value) { writes.push([key, value]); values.set(key, value); } },
    async fetch(path, options) {
      calls.push([path, options]);
      if (fail) throw new Error("offline");
      if (path === "/api/session") return { ok: true, json: async () => ({ authenticated, user: currentAccount, csrfToken: "csrf-secret", loginUrl: "/login" }) };
      const body = response?.(path, options) ?? {};
      return { ok: true, status: 200, json: async () => body };
    },
    crypto: { randomUUID: () => "779cf871-4ee0-411b-b1d6-1fed9f2ac9df" },
    location: { assign: (path) => assigned.push(path) },
    confirm: () => true, alert: () => {}, addEventListener: () => {}, setTimeout, clearTimeout, console,
  });
  vm.runInContext(publicSource, context);
  await context.workforcePublicSession?.ready;
  return { context, ...dom, calls, writes, assigned, values, changeAccount(value) { currentAccount = value; } };
}

function makeController() {
  let input = structuredClone(payload); let draft = { divisions: [{ division: "主体" }] };
  const renders = []; const restored = [];
  return {
    renders, restored, captureDraft: () => draft,
    restoreDraft(value) { restored.push(value); draft = value; },
    collectPlan: () => input, renderPlan: (value) => renders.push(value), showHistoryRecord: () => {},
    changeInput(value) { input = value; },
  };
}

test("未启用公开模式不读取会话、不覆盖原适配器", async () => {
  const f = await website({ enabled: false });
  assert.equal(f.calls.length, 0);
  assert.equal(f.context.workforcePublicSession, undefined);
  assert.equal(f.context.workforceUI, undefined);
});

test("未登录或连接失败只显示登录提示，不读取工效、历史、个人存储", async () => {
  for (const options of [{ authenticated: false }, { fail: true }]) {
    const f = await website(options);
    assert.equal(f.context.workforcePublicSession.authenticated, false);
    assert.deepEqual(f.calls.map(([path]) => path), ["/api/session"]);
    assert.equal(f.writes.length, 0);
    assert.equal(f.document.body.children[0].children[0].className, "panel public-login-panel");
    assert.equal(f.document.body.children[0].children[0].children[2].href, "/login");
  }
  assert.ok(appSource.indexOf("await globalThis.workforcePublicSession?.ready") < appSource.indexOf('const state ='));
});

test("浏览器草稿和比例以账号命名空间存储，不读取旧私有设置或保存CSRF", async () => {
  const f = await website({ initialStorage: { "saudi-workforce-ratios-v1": "private-value", "workforce-public-v1:auth0%7Cb:ratio": "B-value" } });
  const storage = f.context.workforceUI.storage;
  assert.equal(storage.getItem("saudi-workforce-ratios-v1"), null);
  storage.setItem("ratio", "A-value");
  assert.equal(f.values.get("workforce-public-v1:auth0%7Ca:ratio"), "A-value");
  assert.equal(f.values.get("workforce-public-v1:auth0%7Cb:ratio"), "B-value");
  assert.ok(f.writes.every(([key, value]) => !`${key}${value}`.includes("csrf-secret")));
});

test("cookie API禁用缓存且带账号和CSRF；普通用户编辑个人工效，不靠管理员授权", async () => {
  const f = await website();
  await f.context.workforceUI.api("/api/workforce-history/h1", { method: "DELETE" });
  const [, options] = f.calls.at(-1);
  assert.equal(options.credentials, "same-origin"); assert.equal(options.cache, "no-store");
  assert.equal(options.headers["X-CSRF-Token"], "csrf-secret");
  await f.context.workforceUI.api("/api/productivity/p1", { method: "DELETE" });
  assert.equal(f.calls.at(-1)[1].headers["X-Workforce-Account"], accountA.id);
  assert.equal(f.calls.at(-1)[1].headers["X-CSRF-Token"], "csrf-secret");
  assert.equal(f.document.body.classList.contains("workforce-readonly"), false);
  const admin = await website({ account: { ...accountA, isAdmin: true, canEditProductivity: false } });
  await assert.rejects(admin.context.workforceUI.api("/api/productivity", { method: "POST", body: "{}" }), /未启用个人工效编辑/);
  assert.ok(!admin.calls.some(([path]) => path === "/api/productivity"));
  assert.equal(admin.document.body.classList.contains("workforce-readonly"), true);
  assert.ok(f.calls.every(([, args]) => args.cache === "no-store"));
});

test("网页个人编辑权限按每次会话复核；旧服务或共享范围均拒绝写入", async () => {
  const f = await website();
  f.changeAccount({ ...accountA, canEditProductivity: false });
  await assert.rejects(f.context.workforceUI.api("/api/productivity/p1", { method: "PUT", body: "{}" }), /未启用个人工效编辑/);
  assert.ok(!f.calls.some(([path]) => path === "/api/productivity/p1"));
  for (const account of [
    { id: accountA.id, isAdmin: true },
    { ...accountA, productivityScope: "shared" },
  ]) {
    const g = await website({ account });
    await assert.rejects(g.context.workforceUI.api("/api/productivity", { method: "POST", body: "{}" }), /不会修改共享工效库/);
    assert.ok(!g.calls.some(([path]) => path === "/api/productivity"));
  }
});

test("切换账号立即移除原界面，停止旧个人历史请求", async () => {
  const f = await website(); f.changeAccount(accountB);
  await assert.rejects(f.context.workforceUI.api("/api/workforce-history"), /登录状态已变化/);
  assert.equal(f.context.workforcePublicSession.account, null);
  assert.ok(!f.calls.some(([path]) => path === "/api/workforce-history"));
  assert.equal(f.document.body.children[0].children[0].className, "panel public-login-panel");
});

test("网页只准备可复制请求；同输入不重提；检查仅按requestId和指纹回填", async () => {
  const requestId = "779cf871-4ee0-411b-b1d6-1fed9f2ac9df";
  const f = await website({ response(path) {
    if (path === "/api/project-review") return { fingerprint: "fingerprint" };
    if (path === "/api/workforce-history") return { items: [{ id: "h1", requestId }] };
    if (path === "/api/workforce-history/h1") return { record: { id: "h1", createdAt: "2026-10-18", plan: { requestId, workflow: { fingerprint: "fingerprint" } } } };
  } });
  const controller = makeController(); await f.context.workforceUI.initialize(controller);
  await f.context.workforceUI.requestPlan(payload);
  await f.context.workforceUI.requestPlan(payload);
  const panel = f.elements.get("#plan-message").afterNode;
  const prompt = panel.querySelector("textarea").value;
  assert.match(prompt, /公开插件/); assert.match(prompt, /get_current_profile/); assert.match(prompt, /prepare_project_review/);
  assert.match(prompt, /generate_workforce_plan/); assert.match(prompt, /auth0\|a/); assert.match(prompt, /不调用模型 API/);
  assert.equal(f.calls.filter(([path]) => path === "/api/project-review").length, 1);
  assert.equal(controller.renders.length, 0);
  await panel.children.find((entry) => entry.textContent === "检查测算结果（只读）").listeners.click();
  // The UI callback intentionally returns void; drain its read-only promises.
  for (let i = 0; i < 30; i++) await Promise.resolve();
  assert.equal(controller.renders.length, 1);
  assert.ok(!f.calls.some(([path]) => path === "/api/workforce-plan" || path.includes("generate")));
  assert.equal(f.calls.filter(([path, options]) => path.startsWith("/api/workforce-history") && options.method !== "GET").length, 0);
});

test("修改网页输入后检查不读取旧请求、不覆盖新输入", async () => {
  const f = await website({ response: (path) => path === "/api/project-review" ? { fingerprint: "fp" } : {} });
  const controller = makeController(); await f.context.workforceUI.initialize(controller);
  await f.context.workforceUI.requestPlan(payload);
  controller.changeInput({ ...payload, project: { ...payload.project, endDate: "2026-12-01" } });
  const button = f.elements.get("#plan-message").afterNode.children.find((entry) => entry.textContent === "检查测算结果（只读）");
  button.listeners.click(); await Promise.resolve();
  assert.equal(controller.renders.length, 0);
  assert.ok(!f.calls.some(([path]) => path === "/api/workforce-history"));
});

test("退出登录写请求带CSRF，清除当前DOM后返回首页", async () => {
  const f = await website(); await f.context.workforceUI.initialize(makeController());
  const toolbar = f.elements.get("main").children[0];
  await toolbar.children[1].listeners.click();
  const call = f.calls.find(([path]) => path === "/auth/logout");
  assert.equal(call[1].method, "POST"); assert.equal(call[1].headers["X-CSRF-Token"], "csrf-secret");
  assert.deepEqual(f.assigned, ["/"]);
  assert.equal(f.context.workforcePublicSession.account, null);
});

test("网站兼容204退出且会话401时不保留旧数据或私有回退", async () => {
  const f = await website();
  const originalFetch = f.context.fetch;
  f.context.fetch = async (path, options) => path === "/auth/logout"
    ? { ok: true, status: 204, json: () => { throw new Error("204 must not parse JSON"); } }
    : originalFetch(path, options);
  await f.context.workforceUI.initialize(makeController());
  await f.elements.get("main").children[0].children[1].listeners.click();
  assert.deepEqual(f.assigned, ["/"]);
  const g = await website(); const old = g.context.fetch;
  g.context.fetch = async (path, options) => path === "/api/workforce-history"
    ? { ok: false, status: 401, json: async () => ({ error: "unauthorized" }) }
    : old(path, options);
  await assert.rejects(g.context.workforceUI.api("/api/workforce-history"), /重新登录/);
  assert.equal(g.context.workforcePublicSession.account, null);
  assert.equal(g.document.body.children[0].children[0].className, "panel public-login-panel");
});

test("只读结果检查拒绝错误记录ID、请求ID或工效指纹", async () => {
  const requestId = "779cf871-4ee0-411b-b1d6-1fed9f2ac9df";
  for (const [id, planRequestId, fingerprint] of [["wrong", requestId, "fp"], ["h1", "other-request", "fp"], ["h1", requestId, "other-fp"]]) {
    const f = await website({ response(path) {
      if (path === "/api/project-review") return { fingerprint: "fp" };
      if (path === "/api/workforce-history") return { items: [{ id: "h1", requestId }] };
      if (path === "/api/workforce-history/h1") return { record: { id, plan: { requestId: planRequestId, workflow: { fingerprint } } } };
    } });
    const controller = makeController(); await f.context.workforceUI.initialize(controller); await f.context.workforceUI.requestPlan(payload);
    f.elements.get("#plan-message").afterNode.children.find((entry) => entry.textContent === "检查测算结果（只读）").listeners.click();
    for (let i = 0; i < 30; i++) await Promise.resolve();
    assert.equal(controller.renders.length, 0);
  }
});

async function widget({ saved = {}, account = accountA, publicMode = true, toolResponse, clock } = {}) {
  const dom = makeDocument(); let state = structuredClone(saved); let listener;
  const calls = []; const messages = [];
  const host = {
    ready: Promise.resolve({ connected: true }), getState: () => structuredClone(state),
    setState(partial) { state = { ...state, ...structuredClone(partial) }; },
    onToolResult(callback) { listener = callback; }, getToolInput: () => null,
    async callTool(name, args) {
      calls.push([name, args]);
      if (toolResponse) {
        const result = await toolResponse(name, args);
        if (result !== undefined) return result;
      }
      return { structuredContent: name === "get_current_profile" ? { account } : name === "prepare_project_review" ? { account, fingerprint: "widget-fp" } : { account, items: [] } };
    }, sendMessage: async (text) => messages.push(text),
  };
  const context = vm.createContext({ WORKFORCE_PUBLIC_MODE: publicMode, workforceHost: host, document: dom.document,
    fetch: () => { throw new Error("Widget must never fetch"); }, console, setTimeout: clock?.setTimeout ?? setTimeout, clearTimeout: clock?.clearTimeout ?? clearTimeout,
    addEventListener: () => {}, crypto: { randomUUID: () => "request1" },
  });
  vm.runInContext(publicSource, context); await context.workforcePublicSession?.ready;
  vm.runInContext(widgetSource, context);
  const controller = makeController(); await context.workforceUI.initialize(controller);
  return { ...dom, context, host, calls, messages, controller, state: () => state, emit: (value) => listener({ structuredContent: value }) };
}

test("Widget仅通过profile工具认证，不读cookie；其他账户或未标记旧缓存全部清空", async () => {
  for (const workforceAccountId of [undefined, accountB.id]) {
    const f = await widget({ saved: { workforceAccountId, workforceDraft: { secret: "old" }, workforceSettings: { ratio: "old" }, workforcePending: { requestId: "old" }, workforceLastRequestId: "old", workforcePage: "history" } });
    assert.equal(f.calls[0][0], "get_current_profile");
    assert.equal(f.controller.restored.length, 0);
    assert.equal(f.state().workforceAccountId, accountA.id);
    assert.equal(f.state().workforcePending, null);
    assert.equal(f.state().workforceLastRequestId, null);
    assert.equal(f.context.workforceUI.storage.getItem("ratio"), null);
  }
});

test("Widget保留同账号草稿及四页，非管理员可写本人工效，测算仍交当前ChatGPT且不直接generate", async () => {
  const draft = { divisions: [{ division: "saved" }] };
  const f = await widget({ saved: { workforceAccountId: accountA.id, workforceDraft: draft, workforcePage: "library", workforceSettings: { ratio: "A" } } });
  assert.deepEqual(JSON.parse(JSON.stringify(f.controller.restored[0])), draft);
  assert.equal(f.context.workforceUI.storage.getItem("ratio"), "A");
  for (const name of ["planner", "ratios", "history", "library"]) { f.tabs.get(name).click(); assert.equal(f.document.querySelector(".tab.is-active").dataset.tab, name); }
  await f.context.workforceUI.api("/api/productivity/p1", { method: "DELETE" });
  assert.ok(f.calls.some(([name, args]) => name === "delete_productivity" && args.id === "p1"));
  await f.context.workforceUI.requestPlan(payload);
  assert.equal(f.messages.length, 1); assert.match(f.messages[0], /公开插件/); assert.match(f.messages[0], /get_current_profile/);
  assert.ok(!f.messages[0].includes("私有插件"));
  assert.ok(!f.calls.some(([name]) => name === "generate_workforce_plan"));
});

test("Widget管理员不绕过个人编辑能力与作用域，缺失新权限时不发工效写工具", async () => {
  for (const account of [
    { ...accountA, isAdmin: true, canEditProductivity: false },
    { ...accountA, isAdmin: true, productivityScope: "shared" },
    { id: accountA.id, isAdmin: true },
  ]) {
    const f = await widget({ account });
    await assert.rejects(f.context.workforceUI.api("/api/productivity/p1", { method: "DELETE" }), /不会修改共享工效库/);
    assert.ok(!f.calls.some(([name]) => name === "delete_productivity"));
  }
});

test("Widget不展示旧账户或无账户标签的方案", async () => {
  const f = await widget();
  const plan = { project: {}, workItems: [], summary: {}, planOptions: [] };
  f.emit(plan); assert.equal(f.controller.renders.length, 0);
  f.emit({ ...plan, account: accountB }); assert.equal(f.controller.renders.length, 0);
  assert.equal(f.context.workforcePublicSession.authenticated, true);
});

test("公开Widget新增及修改工效保留计算mode，私有旧协议仍剔除mode", async () => {
  for (const publicMode of [true, false]) {
    const f = await widget({ publicMode, account: { ...accountA, isAdmin: true } });
    for (const mode of ["crew_day", "equipment_hour", "role_productivity"]) {
      const body = { name: "工效", mode, output: 25, crew: { 电工: 1 } };
      await f.context.workforceUI.api("/api/productivity", { method: "POST", body: JSON.stringify(body) });
      await f.context.workforceUI.api("/api/productivity/equipment%201", { method: "PUT", body: JSON.stringify(body) });
      const calls = f.calls.filter(([name]) => name === "upsert_productivity").slice(-2);
      assert.equal(calls.length, 2);
      for (const [, args] of calls) {
        assert.equal(Object.hasOwn(args, "mode"), publicMode);
        assert.equal(args.mode, publicMode ? mode : undefined);
        assert.equal(args.output, 25);
        assert.equal(args.crew.电工, 1);
      }
      assert.equal(calls[1][1].id, "equipment 1");
    }
  }
});

function catalogRenderer({ publicMode = true, account = accountA, items = [] } = {}) {
  const elements = new Map();
  for (const selector of ["#library-division-filter", "#library-subitem-filter", "#library-activity-filter", "#library-search", "#library-count", "#library-rows", "#library-scope-note", "#productivity-scope-note", "#productivity-form-title", "#save-productivity"]) {
    elements.set(selector, { value: "", textContent: "", innerHTML: "", hidden: true });
  }
  const context = vm.createContext({ WORKFORCE_PUBLIC_MODE: publicMode, workforcePublicSession: { account },
    state: { productivity: items }, qs: (selector) => elements.get(selector), orderedProductivity: () => items,
    formatNumber: (value) => String(value), crewText: () => "—",
    escapeHtml: (value) => String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;"),
  });
  const helpers = appSource.slice(appSource.indexOf("function canMaintainProductivity()"), appSource.indexOf("function orderedProductivity()"));
  const render = appSource.slice(appSource.indexOf("function renderLibrary()"), appSource.indexOf("function setNewHierarchyInput("));
  vm.runInContext(`${helpers}\n${render}`, context);
  return { context, elements, render() { vm.runInContext("renderLibrary()", context); return elements.get("#library-rows").innerHTML; } };
}

test("工效库明确显示共享默认、个人修改、个人新增，公开删除只表示本人隐藏", () => {
  const base = { division: "地基", subitem: "土方", name: "工序", category: "土方工", crew: {}, status: "unavailable" };
  const items = [
    { ...base, id: "shared", catalogScope: "shared", hasPersonalOverride: false },
    { ...base, id: "override", catalogScope: "shared", hasPersonalOverride: true, name: "<img src=x>" },
    { ...base, id: "custom", catalogScope: "personal", hasPersonalOverride: false },
  ];
  const f = catalogRenderer({ items });
  const before = JSON.stringify(items); const html = f.render();
  for (const label of ["共享默认", "个人修改", "个人新增", "修改个人版本", "仅本人隐藏", "待补充", "不可用"]) assert.ok(html.includes(label), label);
  assert.match(html, /&lt;img src=x&gt;/);
  assert.doesNotMatch(html, /<img src=x>/);
  assert.doesNotMatch(html, />删除<|仅管理员/);
  assert.equal(JSON.stringify(items), before);
  vm.runInContext("configureProductivityScope()", f.context);
  assert.match(f.elements.get("#library-scope-note").textContent, /不改变共享库、其他用户或已保存历史/);
  assert.equal(f.elements.get("#productivity-scope-note").hidden, false);
  assert.equal(f.elements.get("#save-productivity").textContent, "新增个人工效");
});

test("私有模式保留原新增修改删除行为且不显示个人范围；公开管理员也不能仅凭身份编辑", () => {
  const item = { id: "p", name: "工序", status: "confirmed", catalogScope: "personal", hasPersonalOverride: true };
  const privateUI = catalogRenderer({ publicMode: false, items: [item] });
  assert.match(privateUI.render(), />修改<|>删除</);
  assert.doesNotMatch(privateUI.render(), /共享默认|个人修改|个人新增|仅本人隐藏/);
  vm.runInContext("configureProductivityScope()", privateUI.context);
  assert.equal(privateUI.elements.get("#productivity-scope-note").hidden, true);
  const admin = catalogRenderer({ account: { ...accountA, isAdmin: true, canEditProductivity: false }, items: [item] });
  assert.match(admin.render(), /当前账户只读/);
  assert.doesNotMatch(admin.render(), /edit-productivity|delete-productivity/);
});

test("公开编辑现有设备小时和角色工效不重置计算模式；未提供工效仍可保存为不可用", () => {
  const f = catalogRenderer();
  const fields = Object.fromEntries(["id", "status", "category", "name", "crewText", "output", "productivityUnit", "workContent"].map((key) => [key, { value: "", required: true }]));
  const form = { elements: fields, dataset: {}, reset() {} };
  f.elements.set("#productivity-form", form);
  f.elements.set("#cancel-edit", {}); f.elements.set("#save-message", {}); f.elements.set(".sticky-card", { scrollIntoView() {} });
  f.context.refreshFormDivisions = () => {};
  const formFunctions = appSource.slice(appSource.indexOf("function syncProductivityFormRequirements()"), appSource.indexOf("async function refreshProductivity()"));
  vm.runInContext(formFunctions, f.context);
  for (const mode of ["equipment_hour", "role_productivity"]) {
    f.context.item = { id: "p1", mode, roleProductivity: { 电工: 25 }, name: "测试", status: "confirmed" };
    vm.runInContext("beginEdit(item)", f.context);
    assert.equal(form.dataset.productivityMode, mode);
    assert.deepEqual(JSON.parse(form.dataset.roleProductivity), { 电工: 25 });
    assert.equal(fields.output.required, mode !== "role_productivity");
  }
  fields.status.value = "unavailable";
  vm.runInContext("syncProductivityFormRequirements()", f.context);
  for (const field of ["crewText", "output", "productivityUnit"]) assert.equal(fields[field].required, false);
  vm.runInContext("resetProductivityForm()", f.context);
  assert.equal(form.dataset.productivityMode, undefined);
  assert.equal(form.dataset.roleProductivity, undefined);
  assert.equal(form.dataset.productivityPreservedFields, undefined);
});

test("公开表单编辑占位项保留适用范围备注和来源，设备工效保留设备信息", () => {
  const f = catalogRenderer();
  const fields = Object.fromEntries(["id", "status", "category", "name", "crewText", "output", "productivityUnit", "workContent"].map((key) => [key, { value: "", required: true }]));
  const form = { elements: fields, dataset: {}, reset() {} };
  f.elements.set("#productivity-form", form); f.elements.set("#cancel-edit", {}); f.elements.set("#save-message", {}); f.elements.set(".sticky-card", { scrollIntoView() {} });
  f.context.refreshFormDivisions = () => {};
  f.context.formHierarchy = () => ({ division: "地基", subitem: "地下水" });
  f.context.parseCrewConfiguration = () => ({ crew: { 电工: 1 }, crewText: "电工1" });
  const forms = appSource.slice(appSource.indexOf("function syncProductivityFormRequirements()"), appSource.indexOf("async function refreshProductivity()"));
  const payloadFunction = appSource.slice(appSource.indexOf("function productivityFormPayload("), appSource.indexOf('qsa(".tab")'));
  vm.runInContext(forms + payloadFunction, f.context);
  for (const item of [
    { id: "placeholder", name: "支护", mode: "crew_day", category: "待分类", status: "unavailable", workContent: "待补充", notes: "适用于排桩围护墙；尚待补充工效", source: "图片目录补充", equipment: [] },
    { id: "pump", name: "泵", mode: "equipment_hour", category: "降排水", status: "confirmed", workContent: "降水", crewText: "电工1", productivityUnit: "m³/设备·h", output: 25, notes: "所有泵共用一名电工", source: "用户确认", equipment: ["70方水泵"] },
  ]) {
    f.context.item = item;
    vm.runInContext("beginEdit(item); submitted = productivityFormPayload(qs('#productivity-form'))", f.context);
    const submitted = JSON.parse(JSON.stringify(f.context.submitted));
    assert.equal(submitted.notes, item.notes);
    assert.equal(submitted.source, item.source);
    assert.equal(submitted.mode, item.mode);
    assert.deepEqual(submitted.equipment, item.equipment);
    assert.ok(!Object.hasOwn(submitted, "catalogScope"));
  }
});

const drain = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };

test("网页工效成功写入后清理旧请求；相同输入可使用新指纹重prepare，旧结果不回填", async () => {
  for (const [path, method] of [["/api/productivity/p1", "PUT"], ["/api/productivity", "POST"], ["/api/productivity/p1", "DELETE"]]) {
    let prepares = 0; let nextId = 0; let releaseHistory;
    const f = await website({ response(route) {
      if (route === "/api/project-review") return { fingerprint: `fp-${++prepares}` };
      if (route === "/api/workforce-history") return new Promise((resolve) => { releaseHistory = resolve; });
      return {};
    } });
    f.context.crypto.randomUUID = () => `request-${++nextId}`;
    const controller = makeController(); await f.context.workforceUI.initialize(controller);
    await f.context.workforceUI.requestPlan(payload);
    const oldPrompt = f.elements.get("#plan-message").afterNode;
    oldPrompt.children.find((entry) => entry.textContent === "检查测算结果（只读）").listeners.click();
    await drain(); assert.equal(typeof releaseHistory, "function");
    const draftBefore = JSON.stringify(controller.captureDraft());
    await f.context.workforceUI.api(path, { method, body: "{}" });
    assert.equal(oldPrompt.removed, true); assert.equal(oldPrompt.querySelector("textarea").value, "");
    assert.equal(JSON.stringify(controller.captureDraft()), draftBefore);
    await f.context.workforceUI.requestPlan(payload);
    const freshPrompt = f.elements.get("#plan-message").afterNode;
    assert.notEqual(freshPrompt, oldPrompt);
    assert.match(freshPrompt.querySelector("textarea").value, /fp-2/);
    releaseHistory({ items: [{ id: "old", requestId: "request-1" }] });
    await drain();
    assert.equal(controller.renders.length, 0);
    assert.ok(!f.calls.some(([route]) => route === "/api/workforce-history/old"));
    assert.equal(prepares, 2);
    assert.ok(!f.calls.some(([route]) => route === "/api/workforce-plan"));
  }
});

test("网页工效写入失败保留原待处理请求和提示，不重prepare", async () => {
  const f = await website({ response: (path) => path === "/api/project-review" ? { fingerprint: "old-fp" } : {} });
  await f.context.workforceUI.initialize(makeController());
  await f.context.workforceUI.requestPlan(payload);
  const oldPrompt = f.elements.get("#plan-message").afterNode;
  const originalFetch = f.context.fetch;
  f.context.fetch = (path, options) => path === "/api/productivity/p1"
    ? Promise.resolve({ ok: false, status: 400, json: async () => ({ error: "保存失败" }) }) : originalFetch(path, options);
  await assert.rejects(f.context.workforceUI.api("/api/productivity/p1", { method: "PUT", body: "{}" }), /保存失败/);
  await f.context.workforceUI.requestPlan(payload);
  assert.equal(f.calls.filter(([path]) => path === "/api/project-review").length, 1);
  assert.match(oldPrompt.querySelector("textarea").value, /old-fp/);
  assert.notEqual(oldPrompt.removed, true);
});

test("公开Widget工效成功写后停止轮询、移除旧请求标识并允许新指纹prepare；旧结果不回填", async () => {
  for (const [path, method] of [["/api/productivity/p1", "PUT"], ["/api/productivity", "POST"], ["/api/productivity/p1", "DELETE"]]) {
    let prepares = 0; let nextId = 0; let nextTimer = 0; const timers = new Map();
    const clock = { setTimeout(fn) { timers.set(++nextTimer, fn); return nextTimer; }, clearTimeout(id) { timers.delete(id); } };
    const f = await widget({ clock, toolResponse: (name) => name === "prepare_project_review" ? { structuredContent: { account: accountA, fingerprint: `fp-${++prepares}` } } : undefined });
    f.context.crypto.randomUUID = () => `request-${++nextId}`;
    await f.context.workforceUI.requestPlan(payload);
    const oldPrompt = f.elements.get("#plan-message").afterNode;
    assert.equal(timers.size, 1);
    const draft = JSON.stringify(f.controller.captureDraft());
    await f.context.workforceUI.api(path, { method, body: "{}" });
    assert.equal(timers.size, 0);
    assert.equal(f.state().workforcePending, null);
    assert.equal(f.state().workforceLastRequestId, null);
    assert.equal(oldPrompt.hidden, true); assert.equal(oldPrompt.querySelector("textarea").value, "");
    assert.equal(JSON.stringify(f.controller.captureDraft()), draft);
    const oldPlan = { account: accountA, requestId: "request-1", project: {}, workItems: [], summary: {}, planOptions: [], workflow: { fingerprint: "fp-1" } };
    f.emit(oldPlan); assert.equal(f.controller.renders.length, 0);
    await f.context.workforceUI.requestPlan(payload);
    assert.equal(prepares, 2); assert.equal(f.messages.length, 2);
    assert.match(f.messages[1], /fp-2/);
    f.emit(oldPlan); assert.equal(f.controller.renders.length, 0);
    f.emit({ ...oldPlan, requestId: "request-2", workflow: { fingerprint: "fp-2" } });
    assert.equal(f.controller.renders.length, 1);
    assert.ok(!f.calls.some(([name]) => name === "generate_workforce_plan"));
  }
});

test("Widget工效失败不清请求；私有模式成功写入仍保留原行为", async () => {
  for (const publicMode of [true, false]) {
    const f = await widget({ publicMode, toolResponse: (name) => publicMode && name === "upsert_productivity" ? { isError: true, content: [{ type: "text", text: "保存失败" }] } : undefined });
    await f.context.workforceUI.requestPlan(payload);
    const before = JSON.stringify(f.state().workforcePending);
    const oldPrompt = f.elements.get("#plan-message").afterNode;
    const write = f.context.workforceUI.api("/api/productivity/p1", { method: "PUT", body: "{}" });
    if (publicMode) await assert.rejects(write, /保存失败/); else await write;
    assert.equal(JSON.stringify(f.state().workforcePending), before);
    assert.notEqual(oldPrompt.hidden, true);
    assert.match(oldPrompt.querySelector("textarea").value, /widget-fp/);
  }
});
