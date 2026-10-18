import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const bridgeCode = readFileSync(new URL("../public/chatgpt-bridge.js", import.meta.url), "utf8");
const plain = (value) => JSON.parse(JSON.stringify(value));
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

function harness({ origin = "https://chatgpt.com", referrer = "", openai, standalone = false } = {}) {
  const listeners = new Map();
  const sent = [];
  const timers = new Map();
  let timerId = 0;
  const parent = { postMessage: (message, targetOrigin) => sent.push({ message, targetOrigin }) };
  const window = {
    location: { ancestorOrigins: origin ? [origin] : [] },
    openai,
    addEventListener(name, callback) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(callback);
    },
    setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
  };
  window.parent = standalone ? window : parent;
  runInNewContext(bridgeCode, { window, document: { referrer }, URL, console });
  const dispatch = (type, event) => { for (const callback of listeners.get(type) ?? []) callback(event); };
  const respond = (request, result, extras = {}) => dispatch("message", {
    source: parent,
    origin: origin ?? "https://portable-host.example",
    data: { jsonrpc: "2.0", id: request.id, result },
    ...extras,
  });
  const notify = (method, params, extras = {}) => dispatch("message", {
    source: parent,
    origin: origin ?? "https://portable-host.example",
    data: { jsonrpc: "2.0", method, params },
    ...extras,
  });
  const expire = (delay) => {
    for (const [id, timer] of [...timers]) if (timer.delay === delay) {
      timers.delete(id);
      timer.callback();
    }
  };
  return { window, host: window.workforceHost, parent, sent, timers, dispatch, respond, notify, expire };
}

async function initialized(options) {
  const h = harness(options);
  h.respond(h.sent[0].message, { hostInfo: { name: "test-host" } });
  assert.equal((await h.host.ready).mode, "mcp-apps");
  return h;
}

test("bridge initializes using MCP Apps and calls only the host transport", async () => {
  const h = harness();
  assert.deepEqual(plain(h.sent[0]), {
    message: {
      jsonrpc: "2.0", id: 1, method: "ui/initialize",
      params: { appInfo: { name: "workforce-planner", version: "0.18.0" }, appCapabilities: {}, protocolVersion: "2026-01-26" },
    },
    targetOrigin: "https://chatgpt.com",
  });
  h.respond(h.sent[0].message, {});
  assert.equal((await h.host.ready).connected, true);
  assert.deepEqual(plain(h.sent[1].message), { jsonrpc: "2.0", method: "ui/notifications/initialized", params: {} });
  const resultPromise = h.host.callTool("list_productivity", { trade: "钢筋工" });
  await settle();
  const request = h.sent.at(-1).message;
  assert.deepEqual(plain(request.params), { name: "list_productivity", arguments: { trade: "钢筋工" } });
  h.respond(request, { structuredContent: { items: [{ id: "test" }] } });
  assert.deepEqual(plain(await resultPromise), { structuredContent: { items: [{ id: "test" }] } });
  assert.equal(h.timers.size, 0);
});

test("bridge ignores messages from other frames, origins, unknown ids and request-shaped replies", async () => {
  const h = harness();
  const initial = h.sent[0].message;
  h.respond(initial, {}, { source: {} });
  h.respond(initial, {}, { origin: "https://unrelated.example" });
  h.respond({ id: 999 }, {});
  h.respond(initial, {}, { data: { jsonrpc: "2.0", id: initial.id, method: "tools/call", result: {} } });
  assert.equal(h.sent.length, 1);
  assert.equal(h.timers.size, 1);
  h.respond(initial, {});
  await h.host.ready;
  const results = [];
  h.host.onToolResult((value) => results.push(value));
  h.notify("ui/notifications/tool-result", { structuredContent: { invalid: 1 } }, { source: {} });
  h.notify("ui/notifications/tool-result", { structuredContent: { invalid: 2 } }, { origin: "https://unrelated.example" });
  h.notify("ui/notifications/tool-result", { structuredContent: { valid: true } });
  assert.deepEqual(plain(results), [{ structuredContent: { valid: true } }]);
});

test("unknown parent origin is pinned only by initialization and supports opaque sandbox origin", async () => {
  const h = harness({ origin: null });
  const received = [];
  h.host.onToolResult((result) => received.push(result));
  h.notify("ui/notifications/tool-result", { structuredContent: { beforeHandshake: true } });
  assert.equal(received.length, 0);
  assert.equal(h.sent[0].targetOrigin, "*");
  h.respond(h.sent[0].message, {});
  await h.host.ready;
  assert.equal(h.sent[1].targetOrigin, "https://portable-host.example");
  h.notify("ui/notifications/tool-result", { structuredContent: { afterHandshake: true } });
  h.notify("ui/notifications/tool-result", { structuredContent: { wrong: true } }, { origin: "https://another-host.example" });
  assert.equal(received.length, 1);

  const opaque = harness({ origin: null });
  opaque.respond(opaque.sent[0].message, {}, { origin: "null" });
  await opaque.host.ready;
  assert.equal(opaque.sent[1].targetOrigin, "*");
  const promise = opaque.host.callTool("list_workforce_history");
  await settle();
  const request = opaque.sent.at(-1).message;
  opaque.respond(request, { structuredContent: { history: [] } }, { origin: "null" });
  await promise;

  const declaredOpaque = await initialized({ origin: "null", referrer: "https://chatgpt.com/" });
  assert.equal(declaredOpaque.sent[0].targetOrigin, "*");
});

test("tool input and result subscriptions replay both initial alias values and later lifecycle values", async () => {
  const h = await initialized({ openai: { toolInput: { project: { name: "项目 A" } }, toolOutput: { bootstrap: true } } });
  const received = [];
  const unsubscribe = h.host.onToolResult((result) => received.push(result));
  await settle();
  assert.deepEqual(plain(received), [{ structuredContent: { bootstrap: true } }]);
  assert.deepEqual(plain(h.host.getToolInput()), { project: { name: "项目 A" } });
  h.notify("ui/notifications/tool-input", { requestId: "request-b" });
  h.notify("ui/notifications/tool-result", { structuredContent: { requestId: "request-b" }, _meta: { test: true } });
  assert.deepEqual(plain(h.host.getToolInput()), { requestId: "request-b" });
  assert.equal(received.at(-1)._meta.test, true);
  unsubscribe();
  h.notify("ui/notifications/tool-result", { structuredContent: { ignoredByListener: true } });
  assert.equal(received.length, 2);
});

test("legacy globals updates retain canonical envelopes and widget-scoped state", async () => {
  const stored = [];
  const h = await initialized({ openai: { widgetState: { page: "planner", draft: { quantity: 5 } }, setWidgetState: (value) => stored.push(value) } });
  const snapshot = h.host.getState();
  snapshot.draft.quantity = 999;
  assert.equal(h.host.getState().draft.quantity, 5);
  h.host.setState({ page: "ratios" });
  assert.deepEqual(plain(stored[0]), { page: "ratios", draft: { quantity: 5 } });
  const results = [];
  h.host.onToolResult((value) => results.push(value));
  h.dispatch("openai:set_globals", { detail: { globals: {
    toolInput: { requestId: "global" }, widgetState: { page: "history" },
    toolResponseMetadata: { mcp_tool_result: { structuredContent: { canonical: true }, _meta: { private: true } } },
  } } });
  assert.equal(h.host.getState().page, "history");
  assert.equal(h.host.getToolInput().requestId, "global");
  assert.equal(results[0]._meta.private, true);
  const cyclic = {}; cyclic.self = cyclic;
  assert.throws(() => h.host.setState(cyclic));
  assert.throws(() => h.host.setState({ large: "x".repeat(2_000_001) }));
  h.host.setState(JSON.parse('{"__proto__":{"polluted":true},"constructor":123,"safe":true}'));
  assert.equal(h.host.getState().safe, true);
  assert.equal(Object.hasOwn(h.host.getState(), "__proto__"), false);
});

test("unsupported initialization falls back to documented aliases without model API", async () => {
  const calls = [];
  const h = harness({ openai: {
    callTool: async (name, args) => { calls.push({ name, args }); return { items: [1] }; },
    sendFollowUpMessage: async (args) => { calls.push(args); },
  } });
  h.respond(h.sent[0].message, undefined, { data: { jsonrpc: "2.0", id: 1, error: { code: -32601, message: "Method not found" } } });
  assert.equal((await h.host.ready).mode, "compatibility");
  assert.deepEqual(plain(await h.host.callTool("list_productivity", { limit: 1 })), { structuredContent: { items: [1] } });
  assert.deepEqual(plain(await h.host.sendMessage("请审查当前工程量")), { accepted: true });
  assert.deepEqual(plain(calls), [{ name: "list_productivity", args: { limit: 1 } }, { prompt: "请审查当前工程量", scrollToBottom: true }]);
  assert.equal(h.sent.length, 1);
});

test("messages use ui/message and acknowledge delivery rather than generated completion", async () => {
  const h = await initialized();
  const promise = h.host.sendMessage("检查顺序并调用 generate_workforce_plan");
  await settle();
  const request = h.sent.at(-1).message;
  assert.equal(request.method, "ui/message");
  assert.deepEqual(plain(request.params), { role: "user", content: [{ type: "text", text: "检查顺序并调用 generate_workforce_plan" }] });
  h.respond(request, { sent: true });
  assert.deepEqual(plain(await promise), { sent: true });
});

test("message application-level refusals reject without replaying a possibly delivered message", async () => {
  const aliasCalls = [];
  const h = await initialized({ openai: { sendFollowUpMessage: (...args) => aliasCalls.push(args) } });
  for (const refusal of [
    { isError: true, content: [{ type: "text", text: "Host denied this request" }] },
    { accepted: false },
    { sent: false },
    { error: { code: -32000, message: "Host could not send" } },
  ]) {
    const message = h.host.sendMessage("仅提交一次");
    await settle();
    h.respond(h.sent.at(-1).message, refusal);
    await assert.rejects(message, /denied|未接收|could not send/);
  }
  assert.equal(aliasCalls.length, 0);

  const legacy = harness({ openai: { sendFollowUpMessage: async () => ({ isError: true }) } });
  legacy.expire(8000);
  await legacy.host.ready;
  await assert.rejects(legacy.host.sendMessage("仅提交一次"), /未接收测算请求/);
});

test("definite missing methods may use aliases but timeouts and execution errors never replay writes", async () => {
  const aliasCalls = [];
  const h = await initialized({ openai: { callTool: (...args) => { aliasCalls.push(args); return { structuredContent: { ok: true } }; } } });
  const missing = h.host.callTool("list_productivity");
  await settle();
  const request = h.sent.at(-1).message;
  h.respond(request, undefined, { data: { jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "unsupported" } } });
  assert.equal((await missing).structuredContent.ok, true);
  assert.equal(aliasCalls.length, 1);

  const write = h.host.callTool("delete_productivity", { id: "do-not-repeat" });
  const rejection = assert.rejects(write, (error) => error.code === -32001 && /勿重复提交/.test(error.message));
  await settle();
  h.expire(60000);
  await rejection;
  assert.equal(aliasCalls.length, 1);

  const denied = h.host.callTool("delete_workforce_history", { id: "not-allowed" });
  await settle();
  const deniedRequest = h.sent.at(-1).message;
  h.respond(deniedRequest, undefined, { data: { jsonrpc: "2.0", id: deniedRequest.id, error: { code: -32000, message: "Permission denied" } } });
  await assert.rejects(denied, /Permission denied/);
  assert.equal(aliasCalls.length, 1);
});

test("MCP isError tool results reject and do not masquerade as successful state", async () => {
  const h = await initialized();
  const operation = h.host.callTool("upsert_productivity", { id: "invalid" });
  await settle();
  h.respond(h.sent.at(-1).message, { isError: true, content: [{ type: "text", text: "推荐工效必须大于 0" }] });
  await assert.rejects(operation, /推荐工效必须大于 0/);
});

test("absent host and timed-out compatibility calls fail visibly rather than hanging", async () => {
  const standalone = harness({ standalone: true });
  assert.equal((await standalone.host.ready).connected, false);
  await assert.rejects(standalone.host.sendMessage("测算"), /当前界面不支持/);

  const h = harness({ openai: { sendFollowUpMessage: () => new Promise(() => {}) } });
  h.expire(8000);
  assert.equal((await h.host.ready).mode, "compatibility");
  const send = h.host.sendMessage("测算一次");
  const reject = assert.rejects(send, (error) => error.code === -32001);
  await settle();
  h.expire(15000);
  await reject;
});

test("optional display mode is feature-detected and lifecycle closure rejects outstanding calls", async () => {
  const h = await initialized();
  assert.deepEqual(plain(await h.host.requestDisplayMode()), { supported: false });
  const call = h.host.callTool("list_productivity");
  const reject = assert.rejects(call, /界面已关闭/);
  await settle();
  h.dispatch("pagehide", {});
  await reject;
  assert.equal(h.timers.size, 0);
  await assert.rejects(h.host.callTool("list_productivity"), /界面已关闭/);
});
