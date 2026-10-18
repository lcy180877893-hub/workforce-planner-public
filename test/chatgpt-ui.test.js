import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(new URL("../public/chatgpt-ui.js", import.meta.url), "utf8");

class Element {
  constructor(tag = "div") {
    this.tagName = tag; this.children = []; this.listeners = {}; this.dataset = {};
    const classes = new Set();
    this.classList = {
      add(...names) { for (const name of names) classes.add(name); },
      remove(...names) { for (const name of names) classes.delete(name); },
      contains(name) { return classes.has(name); },
      toggle(name, force) { const active = force ?? !classes.has(name); if (active) classes.add(name); else classes.delete(name); return active; },
    };
  }
  append(...nodes) { this.children.push(...nodes); }
  prepend(...nodes) { this.children.unshift(...nodes); }
  after(node) { this.afterNode = node; }
  addEventListener(type, listener) { this.listeners[type] = listener; }
  setAttribute(name, value) { this[name] = value; }
  querySelector(selector) { return this.children.find((entry) => entry.tagName === selector) ?? this.children.map((entry) => entry.querySelector?.(selector)).find(Boolean); }
  remove() { this.removed = true; }
  showModal() { this.open = true; }
  focus() {}
  select() { this.selected = true; }
}

async function fixture({ initial, saved = {}, sendError, connected = true, toolError, input, startupRead = false, pageBeforeReady, echoState = false, clock, toolResponse, requestIds } = {}) {
  const elements = new Map();
  for (const selector of ["#plan-message", ".eyebrow", "#ratios .source-rule", "#download-json", "main"]) elements.set(selector, new Element());
  let page = "planner";
  const tabs = new Map(["planner", "ratios", "history", "library"].map((name) => {
    const tab = new Element("button");
    tab.dataset.tab = name;
    tab.classList.toggle("is-active", name === page);
    tab.closest = (selector) => selector.includes(".tab") ? tab : null;
    tab.click = () => {
      page = name;
      for (const [value, entry] of tabs) entry.classList.toggle("is-active", value === name);
      for (const listener of document.listeners.click ?? []) listener({ target: tab });
    };
    return [name, tab];
  }));
  const body = new Element("body");
  const document = {
    body, listeners: {},
    createElement: (tag) => new Element(tag),
    addEventListener(type, listener) { (this.listeners[type] ??= []).push(listener); },
    querySelector(selector) {
      if (selector === ".tab.is-active") return [...tabs.values()].find((entry) => entry.classList.contains("is-active"));
      const match = selector.match(/^\.tab\[data-tab="(\w+)"\]$/);
      if (match) return tabs.get(match[1]);
      if (selector === "#workforce-send-fallback") return elements.get("#plan-message").afterNode;
      return elements.get(selector) ?? null;
    },
  };
  let hostState = structuredClone(saved);
  let listener;
  const calls = [];
  const messages = [];
  const stateWrites = [];
  let releaseReady;
  const host = {
    ready: pageBeforeReady ? new Promise((resolve) => { releaseReady = resolve; }) : Promise.resolve({ connected }),
    getState: () => structuredClone(hostState),
    setState(partial) {
      stateWrites.push(structuredClone(partial));
      hostState = { ...hostState, ...structuredClone(partial) };
      if (echoState && initial) listener?.({ structuredContent: structuredClone(initial) });
    },
    getToolInput: () => input,
    onToolResult(callback) { listener = callback; if (initial) callback({ structuredContent: initial }); },
    async callTool(name, args) {
      calls.push([name, structuredClone(args)]);
      if (toolError) return { isError: true, content: [{ type: "text", text: toolError }] };
      const provided = await toolResponse?.(name, args);
      const result = provided ?? { structuredContent: name === "prepare_project_review" ? { fingerprint: "test-fingerprint" } : { items: [], saved: args, deleted: args.id } };
      if (startupRead) listener(result);
      return result;
    },
    async sendMessage(text) { messages.push(text); if (sendError) throw new Error(sendError); },
    async requestDisplayMode() { return { supported: false }; },
  };
  let uuidIndex = 0;
  const lifecycle = new Map();
  const context = vm.createContext({ workforceHost: host, document,
    setTimeout: clock?.setTimeout ?? setTimeout, clearTimeout: clock?.clearTimeout ?? clearTimeout,
    Date: clock ? class extends Date { static now() { return clock.now(); } } : Date,
    addEventListener(name, callback) { lifecycle.set(name, callback); },
    console, crypto: { randomUUID: () => requestIds?.[uuidIndex++] ?? "ui-test-request" } });
  vm.runInContext(source, context);
  const payload = { project: { startDate: "2026-10-01", endDate: "2026-10-31" }, workItems: [{ itemId: "w1", division: "主体结构工程", subitem: "钢筋工程", quantity: 1, unit: "t" }] };
  let currentPayload = payload;
  let draft = { context: "", startDate: "", endDate: "", divisions: [{ division: "", subitems: [{ subitem: "", workItems: [{ activityId: "", quantity: "", unit: "" }] }] }] };
  const rendered = [];
  const history = [];
  const controller = {
    captureDraft: () => structuredClone(draft),
    restoreDraft(value) { draft = structuredClone(value); },
    collectPlan: () => structuredClone(currentPayload),
    renderPlan: (value) => rendered.push(value),
    showHistoryRecord: (value) => history.push(value),
  };
  if (startupRead) await context.workforceUI.api("/api/productivity");
  const initialization = context.workforceUI.initialize(controller);
  if (pageBeforeReady) {
    tabs.get(pageBeforeReady).click();
    releaseReady({ connected });
  }
  await initialization;
  return {
    ui: context.workforceUI, host, calls, messages, rendered, history, payload, elements, document, stateWrites,
    emit(value) { listener({ structuredContent: value }); },
    async selectPage(name) { tabs.get(name).click(); await new Promise((resolve) => setTimeout(resolve, 0)); },
    state: () => host.getState(), page: () => page, draft: () => draft,
    changePayload(value) { currentPayload = value; },
    changeDraft(value) { draft = value; },
    lifecycle(name) { lifecycle.get(name)?.(); },
    checkButton() { return elements.get("main").children[0].children.find((entry) => entry.textContent === "检查测算结果"); },
  };
}

function pollingClock() {
  let now = 0;
  let nextId = 0;
  const timers = new Map();
  return {
    now: () => now,
    setTimeout(callback, delay) { const id = ++nextId; timers.set(id, { callback, at: now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    async flush() { for (let index = 0; index < 15; index++) await Promise.resolve(); },
    async advance(duration) {
      const until = now + duration;
      for (;;) {
        const [id, timer] = [...timers].filter(([, entry]) => entry.at <= until).sort((a, b) => a[1].at - b[1].at)[0] ?? [];
        if (!timer) break;
        now = timer.at; timers.delete(id); timer.callback();
        await this.flush();
      }
      now = until;
      await this.flush();
    },
    count: () => timers.size,
  };
}

function plan(requestId = "ui-test-request") {
  return { project: { startDate: "2026-10-01", endDate: "2026-10-31" }, workItems: [], summary: {}, planOptions: [], workflow: { fingerprint: "test-fingerprint" }, history: { id: "h1" }, requestId };
}

test("内嵌四页 API 只映射 MCP 工具，不转发网页或模型 API", async () => {
  const f = await fixture();
  await f.ui.api("/api/productivity");
  await f.ui.api("/api/productivity/code%201", { method: "PUT", body: JSON.stringify({ name: "钢筋", mode: "crew_day" }) });
  await f.ui.api("/api/productivity/code%201", { method: "DELETE" });
  await f.ui.api("/api/workforce-history");
  await f.ui.api("/api/workforce-history/h1");
  await f.ui.api("/api/workforce-history/h1", { method: "DELETE" });
  assert.deepEqual(f.calls.map(([name]) => name), ["list_productivity", "upsert_productivity", "delete_productivity", "list_workforce_history", "get_workforce_history", "delete_workforce_history"]);
  assert.deepEqual(f.calls[1][1], { id: "code 1", name: "钢筋" });
  await assert.rejects(f.ui.api("/api/workforce-plan", { method: "POST" }), /不会转发/);
  assert.equal((await f.ui.api("/api/gpt-status")).configured, true);
});

test("内嵌测算先读资料，再发给当前对话；不会直接生成或写入历史", async () => {
  const f = await fixture();
  await f.ui.requestPlan(f.payload);
  assert.deepEqual(f.calls.map(([name]) => name), ["prepare_project_review"]);
  assert.equal(f.messages.length, 1);
  assert.match(f.messages[0], /generate_workforce_plan/);
  assert.match(f.messages[0], /requestId="ui-test-request"/);
  assert.match(f.messages[0], /不可信项目数据/);
  assert.equal(f.state().workforcePending.requestId, "ui-test-request");
  assert.equal(f.rendered.length, 0);
  assert.match(f.elements.get("#plan-message").textContent, /补问或工具授权/);
});

test("请求 ID、草稿与指纹全部相符时才回填计划；修改输入后旧结果不覆盖", async () => {
  const valid = await fixture();
  await valid.ui.requestPlan(valid.payload);
  valid.emit(plan());
  assert.equal(valid.rendered.length, 1);
  assert.equal(valid.state().workforcePending, null);

  const stale = await fixture();
  await stale.ui.requestPlan(stale.payload);
  stale.changePayload({ ...stale.payload, project: { ...stale.payload.project, endDate: "2026-11-30" } });
  stale.emit(plan());
  assert.equal(stale.rendered.length, 0);
  assert.match(stale.elements.get("#plan-message").textContent, /旧结果未覆盖/);

  const unrelated = await fixture();
  await unrelated.ui.requestPlan(unrelated.payload);
  unrelated.emit(plan("other-request"));
  assert.equal(unrelated.rendered.length, 0);
  assert.equal(unrelated.state().workforcePending.requestId, "ui-test-request");
});

test("宿主未确认发送时提供可复制请求，不声称测算完成或重试写入", async () => {
  const f = await fixture({ sendError: "host timeout" });
  await f.ui.requestPlan(f.payload);
  const fallback = f.elements.get("#plan-message").afterNode;
  assert.equal(fallback.open, true);
  assert.match(fallback.querySelector("textarea").value, /ui-test-request/);
  assert.match(f.elements.get("#plan-message").textContent, /未确认发送成功/);
  assert.equal(f.calls.length, 1);
  assert.equal(f.messages.length, 1);
  assert.equal(f.rendered.length, 0);
});

test("原始空白草稿与季节设置保存在组件状态，不伪装为网页共享设置", async () => {
  const draft = { context: "酒店A", startDate: "", endDate: "", divisions: [{ divisionId: "division-7", division: "", subitems: [{ subitemId: "subitem-9", subitem: "", workItems: [{ itemId: "work-12", activityId: "", quantity: "", unit: "" }] }] }] };
  const f = await fixture({ saved: { workforceDraft: draft, workforceSettings: { custom: "70" }, workforcePage: "ratios" } });
  assert.deepEqual(f.draft(), draft);
  assert.equal(f.ui.storage.getItem("custom"), "70");
  assert.equal(f.state().workforceDraft.divisions[0].subitems[0].workItems[0].quantity, "");
  assert.equal(f.page(), "ratios");
  assert.match(f.elements.get("#ratios .source-rule").textContent, /原网站浏览器设置保持不变/);
});

test("主页打开通知仅初始化一次，四页切换后重复宿主通知不重置页签", async () => {
  const opening = { ui: { page: "planner" }, bootstrap: { productivity: [], history: [] } };
  for (const selected of ["ratios", "history", "library"]) {
    const f = await fixture({ initial: structuredClone(opening) });
    assert.equal(f.page(), "planner");
    await f.selectPage(selected);
    assert.equal(f.state().workforcePage, selected);
    f.emit(structuredClone(opening));
    f.emit(structuredClone(opening));
    assert.equal(f.page(), selected, `${selected} 不应被重复打开通知覆盖`);
    assert.equal(f.state().workforcePage, selected);
  }
});

test("组件恢复保留上次所选页签，不被原始打开主页覆盖", async () => {
  for (const selected of ["ratios", "history", "library"]) {
    const f = await fixture({ saved: { workforcePage: selected }, initial: { ui: { page: "planner" } } });
    assert.equal(f.page(), selected);
    assert.equal(f.state().workforcePage, selected);
    f.emit({ ui: { page: "planner" } });
    assert.equal(f.page(), selected);
  }
});

test("恢复组件时计划或历史内容可加载，但仍保留用户上次所选页签", async () => {
  const restoredPlan = await fixture({ saved: { workforcePage: "library" }, initial: plan() });
  assert.equal(restoredPlan.rendered.length, 1);
  assert.equal(restoredPlan.page(), "library");
  const restoredHistory = await fixture({ saved: { workforcePage: "ratios" }, initial: { record: { id: "restored-history", plan: plan() } } });
  assert.equal(restoredHistory.history.length, 1);
  assert.equal(restoredHistory.page(), "ratios");
});

test("宿主尚未就绪时用户已选页签，初始化不能再跳回默认主页", async () => {
  const f = await fixture({ initial: { ui: { page: "planner" } }, pageBeforeReady: "library" });
  assert.equal(f.page(), "library");
  assert.equal(f.state().workforcePage, "library");
});

test("没有已保存页签时可按打开参数选页；迟到打开结果不能撤销用户切换", async () => {
  const requested = await fixture({ initial: { ui: { page: "library" } } });
  assert.equal(requested.page(), "library");
  const lateRequested = await fixture();
  lateRequested.emit({ ui: { page: "history" } });
  assert.equal(lateRequested.page(), "history");
  const edited = await fixture();
  await edited.selectPage("ratios");
  edited.emit({ ui: { page: "planner" } });
  assert.equal(edited.page(), "ratios");
  edited.emit({ items: [{ id: "fresh-library-read" }] });
  edited.emit({ records: [{ id: "history-list-read" }] });
  assert.equal(edited.page(), "ratios");
});

test("已展示方案的宿主重放不跳回测算页、不重复渲染或覆盖后续编辑", async () => {
  const output = plan();
  const f = await fixture({ initial: output });
  assert.equal(f.rendered.length, 1);
  const edits = { context: "用户后续编辑的 B 栋", divisions: [] };
  f.changeDraft(edits);
  await f.selectPage("library");
  f.emit(structuredClone(output));
  assert.equal(f.page(), "library");
  assert.equal(f.rendered.length, 1);
  assert.deepEqual(f.draft(), edits);
});

test("同一历史详情重放不抢回页签，新的历史记录仍可展示", async () => {
  const record = { id: "history-first", createdAt: "2026-10-18", plan: plan() };
  const f = await fixture({ initial: { record } });
  assert.equal(f.history.length, 1);
  await f.selectPage("ratios");
  f.emit({ record: structuredClone(record) });
  assert.equal(f.page(), "ratios");
  assert.equal(f.history.length, 1);
  const next = { ...record, id: "history-next" };
  f.emit({ record: next });
  assert.equal(f.page(), "history");
  assert.equal(f.history.length, 2);
  assert.equal(f.history[1].id, "history-next");
});

test("页签防重放不阻止本次已匹配测算结果回填", async () => {
  const f = await fixture({ initial: { ui: { page: "planner" } } });
  await f.selectPage("ratios");
  await f.ui.requestPlan(f.payload);
  f.emit(plan());
  assert.equal(f.rendered.length, 1);
  assert.equal(f.page(), "planner");
  assert.equal(f.state().workforcePending, null);
});

test("对象键次序不同的同一方案仍视为重放，同请求修正结果不被误去重", async () => {
  const output = plan();
  const f = await fixture({ initial: output });
  await f.selectPage("history");
  const reordered = Object.fromEntries(Object.entries(output).reverse());
  reordered.project = Object.fromEntries(Object.entries(output.project).reverse());
  f.emit(reordered);
  assert.equal(f.page(), "history");
  assert.equal(f.rendered.length, 1);
  f.emit({ ...output, summary: { corrected: true } });
  assert.equal(f.rendered.length, 2);
  assert.equal(f.rendered[1].summary.corrected, true);
});

test("新请求等待中收到上一已展示方案重放，不改等待信息、页签或当前请求", async () => {
  const previous = plan("previous-request");
  const f = await fixture({ initial: previous });
  await f.ui.requestPlan(f.payload);
  await f.selectPage("ratios");
  const pending = structuredClone(f.state().workforcePending);
  const status = f.elements.get("#plan-message").textContent;
  f.emit(structuredClone(previous));
  assert.equal(f.page(), "ratios");
  assert.equal(f.rendered.length, 1);
  assert.deepEqual(f.state().workforcePending, pending);
  assert.equal(f.elements.get("#plan-message").textContent, status);
});

test("尚未接受的方案不能被永久标记为重放，之后匹配当前请求仍可接收", async () => {
  const output = plan();
  const f = await fixture({ initial: output, saved: { workforceDraft: { context: "用户保留草稿", divisions: [] } } });
  assert.equal(f.rendered.length, 0);
  await f.ui.requestPlan(f.payload);
  f.emit(structuredClone(output));
  assert.equal(f.rendered.length, 1);
  assert.equal(f.state().workforcePending, null);
});

test("宿主保存状态同步回声不会重入方案渲染，也不会形成切页保存循环", async () => {
  const f = await fixture({ initial: plan(), echoState: true });
  assert.equal(f.rendered.length, 1);
  await f.selectPage("library");
  assert.equal(f.page(), "library");
  assert.equal(f.rendered.length, 1);
  const writes = f.stateWrites.length;
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(f.stateWrites.length, writes);
  assert.ok(writes <= 4);
});

test("迟到的初始历史详情可加载数据但保留已恢复或已选择页签，新历史仍可切页", async () => {
  const record = { id: "late-opening-history", plan: plan() };
  for (const restore of [true, false]) {
    const f = await fixture({ input: { id: record.id }, saved: restore ? { workforcePage: "library" } : {} });
    if (!restore) await f.selectPage("ratios");
    const selected = restore ? "library" : "ratios";
    f.emit({ record: structuredClone(record) });
    assert.equal(f.page(), selected);
    assert.equal(f.history.length, 1);
    assert.equal(f.history[0].id, record.id);
    f.emit({ record: { ...record, id: "next-distinct-history" } });
    assert.equal(f.page(), "history");
    assert.equal(f.history.length, 2);
    assert.equal(f.history[1].id, "next-distinct-history");
  }
});

test("浏览多条历史后原始打开结果重放仍不能抢页或重复展示", async () => {
  const originalPlan = plan("opening-plan");
  const originalHistory = { record: { id: "opening-history", plan: plan() } };
  for (const original of [originalPlan, originalHistory]) {
    const f = await fixture({ initial: structuredClone(original), input: original.record ? { id: original.record.id } : undefined });
    for (let index = 0; index < 9; index++) f.emit({ record: { id: `browsed-history-${index}`, plan: plan() } });
    await f.selectPage("library");
    const rendered = f.rendered.length;
    const shownHistory = f.history.length;
    f.emit(structuredClone(original));
    assert.equal(f.page(), "library");
    assert.equal(f.rendered.length, rendered);
    assert.equal(f.history.length, shownHistory);
  }
});

test("历史工具关联组件直接展示对应历史；无 ID 的不同施工部位不合并", async () => {
  const record = { id: "record-2", createdAt: "2026-10-18", plan: plan() };
  const history = await fixture({ initial: { record } });
  assert.equal(history.page(), "history");
  assert.equal(history.history[0].id, record.id);

  const input = { project: { startDate: "2026-10-01", endDate: "2026-10-31" }, workItems: [
    { division: "主体结构工程", subitem: "钢筋工程", divisionRemark: "A栋", name: "钢筋", quantity: 1 },
    { division: "主体结构工程", subitem: "钢筋工程", divisionRemark: "B栋", name: "钢筋", quantity: 2 },
  ] };
  const generated = await fixture({ initial: plan(), input });
  assert.equal(generated.rendered.length, 1);
  assert.equal(generated.draft().divisions.length, 2);
  assert.deepEqual(generated.draft().divisions.map((entry) => entry.divisionRemark), ["A栋", "B栋"]);
});

test("未连接或 MCP 错误不返回假成功；删除确认拒绝时不写入", async () => {
  const disconnected = await fixture({ connected: false });
  await assert.rejects(disconnected.ui.api("/api/productivity"), /未连接/);
  assert.equal(disconnected.calls.length, 0);
  const failed = await fixture({ toolError: "当前操作未获授权" });
  await assert.rejects(failed.ui.api("/api/productivity/x", { method: "DELETE" }), /未获授权/);
  const confirmation = failed.ui.confirm("确定删除吗？");
  const modal = failed.document.body.children.at(-1);
  modal.children.at(-1).children[0].listeners.click();
  assert.equal(await confirmation, false);
  assert.equal(failed.calls.length, 1);
});

test("启动时工效读取的宿主通知不覆盖打开界面的计划或历史结果", async () => {
  const generated = await fixture({ initial: plan(), startupRead: true });
  assert.equal(generated.rendered.length, 1);
  const history = await fixture({ initial: { record: { id: "history-initial", plan: plan() } }, startupRead: true });
  assert.equal(history.history.length, 1);
  assert.equal(history.history[0].id, "history-initial");
});

test("较晚收到打开组件的计划仍可展示；编辑后不被迟到结果覆盖", async () => {
  const input = { project: { startDate: "2026-10-01", endDate: "2026-10-31" }, workItems: [{ activityId: "steel", quantity: 2 }], requestId: "ui-test-request" };
  const output = { ...plan(), workItems: [{ activityId: "steel", quantity: 2, division: "主体结构工程", subitem: "钢筋工程", name: "钢筋绑扎" }] };
  const late = await fixture({ input });
  late.emit(output);
  assert.equal(late.rendered.length, 1);
  assert.equal(late.draft().divisions[0].division, "主体结构工程");
  assert.equal(late.draft().divisions[0].subitems[0].subitem, "钢筋工程");
  const edited = await fixture({ input });
  edited.changeDraft({ context: "用户已修改输入", divisions: [] });
  edited.emit(output);
  assert.equal(edited.rendered.length, 0);
});

test("已有草稿不与不相干的打开结果混用；旧 bootstrap 不取代实时工效库", async () => {
  const saved = { workforceDraft: { context: "B栋", divisions: [{ division: "主体结构工程", subitems: [] }] } };
  const f = await fixture({ initial: plan(), saved });
  assert.equal(f.rendered.length, 0);
  assert.match(f.elements.get("#plan-message").textContent, /当前已保存草稿未被替换/);
  const bootstrap = await fixture({ initial: { ui: { page: "library" }, bootstrap: { productivity: [{ id: "outdated" }], history: [] } } });
  const value = await bootstrap.ui.api("/api/productivity");
  assert.equal(value.items.length, 0);
  assert.equal(bootstrap.calls[0][0], "list_productivity");
});

test("同一请求未完成时再次测算须明确确认；取消不重复发送或保存", async () => {
  const f = await fixture();
  await f.ui.requestPlan(f.payload);
  const duplicate = f.ui.requestPlan(f.payload);
  const modal = f.document.body.children.at(-1);
  assert.match(modal.children[0].textContent, /重新提交/);
  assert.match(modal.children[1].textContent, /重复生成可能保存两条历史/);
  modal.children.at(-1).children[0].listeners.click();
  await duplicate;
  assert.equal(f.messages.length, 1);
  assert.equal(f.calls.length, 1);
});

test("原面板通过只读历史精确找回本次请求，自动渲染并停止检查", async () => {
  const clock = pollingClock();
  const output = plan();
  const f = await fixture({ clock, toolResponse(name) {
    if (name === "list_workforce_history") return { items: [{ id: "foreign", requestId: "other" }, { id: "h1", requestId: output.requestId }] };
    if (name === "get_workforce_history") return { record: { id: "h1", createdAt: "2026-10-18", plan: output } };
  } });
  await f.ui.requestPlan(f.payload);
  await f.selectPage("ratios");
  await clock.advance(2000);
  assert.deepEqual(f.calls.map(([name]) => name), ["prepare_project_review", "list_workforce_history", "get_workforce_history"]);
  assert.deepEqual(f.calls[2][1], { id: "h1" });
  assert.equal(f.rendered.length, 1);
  assert.equal(f.history.length, 0);
  assert.equal(f.page(), "planner");
  assert.equal(f.state().workforcePending, null);
  assert.equal(f.checkButton().hidden, true);
  await clock.advance(600000);
  assert.equal(f.calls.length, 3);
  assert.equal(f.messages.length, 1);
});

test("宿主直接投递结果时立即取消只读轮询，重复投递不抢页", async () => {
  const clock = pollingClock();
  const f = await fixture({ clock });
  await f.ui.requestPlan(f.payload);
  f.emit(plan());
  await f.selectPage("library");
  await clock.advance(600000);
  f.emit(plan());
  assert.equal(f.calls.length, 1);
  assert.equal(f.rendered.length, 1);
  assert.equal(f.page(), "library");
});

test("恢复待处理请求后只恢复结果检查，不重发对话或重新生成", async () => {
  const original = await fixture();
  await original.ui.requestPlan(original.payload);
  const saved = original.state();
  original.lifecycle("pagehide");
  const clock = pollingClock();
  const f = await fixture({ clock, saved, initial: { ui: { page: "planner" } }, toolResponse(name) {
    if (name === "list_workforce_history") return { items: [{ id: "h1", requestId: "ui-test-request" }] };
    if (name === "get_workforce_history") return { record: { id: "h1", plan: plan() } };
  } });
  assert.equal(f.rendered.length, 0);
  await clock.advance(2000);
  assert.equal(f.rendered.length, 1);
  assert.deepEqual(f.calls.map(([name]) => name), ["list_workforce_history", "get_workforce_history"]);
  assert.equal(f.messages.length, 0);
  assert.equal(f.state().workforcePending, null);
});

test("历史只按 requestId 匹配，工程量相同或最新记录都不能代替本次请求", async () => {
  const clock = pollingClock();
  const f = await fixture({ clock, toolResponse(name) {
    if (name === "list_workforce_history") return { items: [{ id: "latest", requestId: "other-request" }, { id: "legacy-no-id" }] };
  } });
  await f.ui.requestPlan(f.payload);
  await clock.advance(2000);
  assert.equal(f.calls.filter(([name]) => name === "get_workforce_history").length, 0);
  assert.equal(f.rendered.length, 0);
  assert.equal(f.state().workforcePending.requestId, "ui-test-request");
  f.lifecycle("pagehide");
});

test("历史摘要与详情请求不一致时不回填；指纹不一致也不覆盖输入", async () => {
  for (const mismatch of ["request", "fingerprint"]) {
    const clock = pollingClock();
    const output = mismatch === "request" ? plan("foreign") : { ...plan(), workflow: { fingerprint: "changed-catalog" } };
    const f = await fixture({ clock, toolResponse(name) {
      if (name === "list_workforce_history") return { items: [{ id: "h1", requestId: "ui-test-request" }] };
      if (name === "get_workforce_history") return { record: { id: "h1", plan: output } };
    } });
    await f.ui.requestPlan(f.payload);
    await clock.advance(2000);
    assert.equal(f.rendered.length, 0);
    assert.equal(f.history.length, 0);
    if (mismatch === "fingerprint") {
      assert.equal(f.state().workforcePending, null);
      assert.match(f.elements.get("#plan-message").textContent, /旧结果未覆盖/);
    } else assert.equal(f.state().workforcePending.requestId, "ui-test-request");
    f.lifecycle("pagehide");
  }
});

test("读取详情返回错误记录 ID 时，桥接提前通知也不能展示该记录", async () => {
  const clock = pollingClock();
  const f = await fixture({ clock, startupRead: true, toolResponse(name) {
    if (name === "list_workforce_history") return { items: [{ id: "expected", requestId: "ui-test-request" }] };
    if (name === "get_workforce_history") return { record: { id: "wrong-record", plan: plan("foreign-request") } };
  } });
  await f.ui.requestPlan(f.payload);
  await f.selectPage("library");
  await clock.advance(2000);
  assert.equal(f.page(), "library");
  assert.equal(f.history.length, 0);
  assert.equal(f.rendered.length, 0);
  assert.equal(f.state().workforcePending.requestId, "ui-test-request");
  f.lifecycle("pagehide");
});

test("等待期间修改输入即停止读取旧结果，未完成输入也不会抛出或覆盖", async () => {
  const clock = pollingClock();
  const f = await fixture({ clock });
  await f.ui.requestPlan(f.payload);
  f.changePayload({ ...f.payload, workItems: [] });
  await clock.advance(2000);
  assert.equal(f.calls.length, 1);
  assert.equal(f.state().workforcePending, null);
  assert.equal(f.rendered.length, 0);
  assert.match(f.elements.get("#plan-message").textContent, /停止读取原测算结果/);
});

test("自动检查有明确时限，手动检查只读恢复而不重复提交或保存", async () => {
  const clock = pollingClock();
  let ready = false;
  const f = await fixture({ clock, toolResponse(name) {
    if (name === "list_workforce_history") return { items: ready ? [{ id: "h1", requestId: "ui-test-request" }] : [] };
    if (name === "get_workforce_history") return { record: { id: "h1", plan: plan() } };
  } });
  await f.ui.requestPlan(f.payload);
  await clock.advance(600000);
  const calls = f.calls.length;
  assert.ok(calls <= 25);
  assert.match(f.elements.get("#plan-message").textContent, /暂停自动检查/);
  assert.equal(f.checkButton().hidden, false);
  await clock.advance(600000);
  assert.equal(f.calls.length, calls);
  ready = true;
  f.checkButton().listeners.click();
  await clock.advance(0);
  assert.equal(f.rendered.length, 1);
  assert.equal(f.messages.length, 1);
  assert.equal(f.calls.filter(([name]) => name === "prepare_project_review").length, 1);
  assert.equal(f.calls.some(([name]) => name === "generate_workforce_plan"), false);
});

test("连续读取失败后停止轮询并允许手动重试，不伪造成功", async () => {
  const clock = pollingClock();
  let failed = true;
  const f = await fixture({ clock, toolResponse(name) {
    if (name === "list_workforce_history") return failed ? { isError: true, content: [{ type: "text", text: "读取暂不可用" }] } : { items: [{ id: "h1", requestId: "ui-test-request" }] };
    if (name === "get_workforce_history") return { record: { id: "h1", plan: plan() } };
  } });
  await f.ui.requestPlan(f.payload);
  await clock.advance(30000);
  assert.equal(f.calls.length, 4);
  assert.equal(f.rendered.length, 0);
  assert.match(f.elements.get("#plan-message").textContent, /暂时无法读取/);
  failed = false;
  f.checkButton().listeners.click();
  await clock.advance(0);
  assert.equal(f.rendered.length, 1);
  assert.equal(f.messages.length, 1);
});

test("检查不重叠，新请求会取消旧检查且拒绝迟到的旧读取", async () => {
  const clock = pollingClock();
  let resolveOld;
  let reads = 0;
  const f = await fixture({ clock, requestIds: ["first-request", "next-request"], toolResponse(name) {
    if (name === "list_workforce_history") {
      reads++;
      if (reads === 1) return new Promise((resolve) => { resolveOld = resolve; });
      return { items: [] };
    }
  } });
  await f.ui.requestPlan(f.payload);
  await clock.advance(2000);
  assert.equal(f.checkButton().disabled, true);
  f.checkButton().listeners.click();
  await clock.advance(30000);
  assert.equal(reads, 1);
  const nextPayload = { ...f.payload, project: { ...f.payload.project, endDate: "2026-11-30" } };
  f.changePayload(nextPayload);
  await f.ui.requestPlan(nextPayload);
  resolveOld({ items: [{ id: "old", requestId: "first-request" }] });
  await clock.flush();
  assert.equal(f.calls.some(([name]) => name === "get_workforce_history"), false);
  assert.equal(f.state().workforcePending.requestId, "next-request");
  assert.equal(f.rendered.length, 0);
  await clock.advance(2000);
  assert.equal(reads, 2);
  f.lifecycle("pagehide");
});

test("旧请求详情的桥接通知先于 Promise 返回时也不能抢页；主动查看该历史仍返回详情", async () => {
  const clock = pollingClock();
  let resolveOldDetails;
  let detailsReads = 0;
  const oldRecord = { id: "old-history", plan: plan("first-request") };
  const f = await fixture({ clock, startupRead: true, requestIds: ["first-request", "next-request"], toolResponse(name) {
    if (name === "list_workforce_history") return { items: [{ id: "old-history", requestId: "first-request" }] };
    if (name === "get_workforce_history") {
      detailsReads++;
      if (detailsReads === 1) return new Promise((resolve) => { resolveOldDetails = resolve; });
      return { record: oldRecord };
    }
  } });
  await f.ui.requestPlan(f.payload);
  await clock.advance(2000);
  assert.equal(detailsReads, 1);
  const nextPayload = { ...f.payload, project: { ...f.payload.project, endDate: "2026-11-30" } };
  f.changePayload(nextPayload);
  await f.ui.requestPlan(nextPayload);
  await f.selectPage("library");
  resolveOldDetails({ record: oldRecord });
  await clock.flush();
  assert.equal(f.page(), "library");
  assert.equal(f.history.length, 0);
  assert.equal(f.rendered.length, 0);
  assert.equal(f.state().workforcePending.requestId, "next-request");
  f.emit({ record: oldRecord });
  assert.equal(f.page(), "library");
  await f.selectPage("history");
  const deliberate = await f.ui.api("/api/workforce-history/old-history");
  assert.equal(deliberate.record.id, "old-history");
  assert.equal(deliberate.record.plan.requestId, "first-request");
  assert.equal(f.page(), "history");
  assert.equal(detailsReads, 2);
  f.lifecycle("pagehide");
});

test("卸载时清理计时器，恢复页面后安全恢复检查", async () => {
  const clock = pollingClock();
  const f = await fixture({ clock });
  await f.ui.requestPlan(f.payload);
  f.lifecycle("pagehide");
  await clock.advance(600000);
  assert.equal(f.calls.length, 1);
  f.lifecycle("pageshow");
  await clock.advance(2000);
  assert.equal(f.calls.length, 2);
  assert.equal(f.messages.length, 1);
  f.lifecycle("pagehide");
});

test("关联历史工具的宿主通知也回填原方案，不错误跳到历史页", async () => {
  const clock = pollingClock();
  const f = await fixture({ clock });
  await f.ui.requestPlan(f.payload);
  const envelope = { record: { id: "h1", createdAt: "2026-10-18", plan: plan() } };
  f.emit(envelope);
  assert.equal(f.rendered.length, 1);
  assert.equal(f.history.length, 0);
  assert.equal(f.page(), "planner");
  await f.selectPage("ratios");
  f.emit(structuredClone(envelope));
  assert.equal(f.history.length, 0);
  assert.equal(f.page(), "ratios");
  await clock.advance(600000);
  assert.equal(f.calls.length, 1);
});

test("缺失关联信息的旧组件状态不自动查询或提交", async () => {
  const clock = pollingClock();
  const f = await fixture({ clock, saved: { workforcePending: { requestId: "old-request" } } });
  await clock.advance(600000);
  assert.equal(f.calls.length, 0);
  assert.equal(f.messages.length, 0);
  assert.equal(f.state().workforcePending, null);
  assert.match(f.elements.get("#plan-message").textContent, /信息不完整/);
});

test("网站实际草稿捕获与恢复函数保留空工程量、自定义单位和三级实例标识", async () => {
  const app = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const functions = app.slice(app.indexOf("function captureEmbeddedDraft()"), app.indexOf("function objectRows("));
  const group = { dataset: { divisionId: "division-8" } };
  const subitem = { dataset: { subitemId: "subitem-11" } };
  const row = { dataset: { itemId: "work-19" } };
  const form = { elements: { context: { value: " A栋 " }, startDate: { value: "" }, endDate: { value: "" } } };
  const values = new Map([
    [group, { ".division-select": "主体结构工程", ".division-remark": " A栋 " }],
    [subitem, { ".subitem-select": "其他分项" }],
    [row, { ".activity-select": "__missing__", ".quantity": "", ".missing-name": "自定义工作", ".unit": "延米" }],
  ]);
  const added = [];
  const stored = new Map();
  let resets = 0;
  const context = vm.createContext({
    qs(selector, parent) {
      if (selector === "#plan-form") return form;
      if (["#division-list", "#ramadan-ranges"].includes(selector)) return { replaceChildren() { resets++; } };
      return { value: values.get(parent)?.[selector] };
    },
    qsa(selector) {
      return selector.includes("#division-list") ? [group] : selector.includes("subitem-list") ? [subitem] : [row];
    },
    ratioValues: () => ({ winter: 100, summer: 70, ramadan: 50 }),
    calendarDateValues: () => ({ winter: { start: "10-01", end: "05-31" }, summer: { start: "06-01", end: "09-30" }, ramadan: { mode: "auto", ranges: [] } }),
    addDivision: (value) => added.push(value),
    settingsStorage: () => ({ setItem: (key, value) => stored.set(key, value) }),
    RATIO_STORAGE_KEY: "ratios", DATE_STORAGE_KEY: "dates",
    loadRatioSettings() {}, loadCalendarSettings() {},
  });
  vm.runInContext(functions, context);
  const draft = vm.runInContext("captureEmbeddedDraft()", context);
  assert.equal(draft.divisions[0].divisionId, "division-8");
  assert.equal(draft.divisions[0].subitems[0].subitemId, "subitem-11");
  assert.deepEqual(JSON.parse(JSON.stringify(draft.divisions[0].subitems[0].workItems[0])), {
    itemId: "work-19", activityId: "__missing__", quantity: "", name: "自定义工作", unit: "延米",
  });
  context.inputDraft = draft;
  assert.equal(vm.runInContext("restoreEmbeddedDraft(inputDraft)", context), true);
  assert.equal(added[0].subitems[0].workItems[0].quantity, "");
  assert.equal(form.elements.context.value, " A栋 ");
  assert.equal(resets, 2);
  assert.equal(JSON.parse(stored.get("ratios")).summer, 70);
});
