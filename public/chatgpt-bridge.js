// MCP Apps transport. This file never contacts the application or a model API.
// Protocol: https://developers.openai.com/plugins/build/app-quickstart
(() => {
  "use strict";
  if (window.workforceHost) return;

  const INIT_TIMEOUT = 8000;
  const REQUEST_TIMEOUT = 60000;
  const MESSAGE_TIMEOUT = 15000;
  const MAX_STATE_LENGTH = 2_000_000;
  const pending = new Map();
  const resultListeners = new Set();
  const parentWindow = window.parent;
  let requestId = 0;
  let mode = "initializing";
  let closed = false;
  let latestToolResult;
  let latestToolInput;
  let hostOrigin = readParentOrigin();
  let state = copyRecord(window.openai?.widgetState);

  function readParentOrigin() {
    // Browser-provided ancestor origins are preferable to a hard-coded host name.
    const ancestor = window.location?.ancestorOrigins?.[0];
    if (ancestor === "null") return "null";
    const referrer = typeof document !== "undefined" ? document.referrer : "";
    for (const value of [ancestor, referrer]) {
      if (!value) continue;
      try {
        const parsed = new URL(value);
        if (parsed.protocol === "https:" || parsed.protocol === "http:") return parsed.origin;
      } catch { /* An absent or opaque origin is pinned by the initialization reply. */ }
    }
    return null;
  }

  function jsonCopy(value) {
    if (value === undefined) return undefined;
    const serialized = JSON.stringify(value);
    if (serialized === undefined) return undefined;
    if (serialized.length > MAX_STATE_LENGTH) throw bridgeError("界面状态过大，请减少工程量条目后重试。", -32002);
    return JSON.parse(serialized);
  }

  function copyRecord(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    try {
      return Object.fromEntries(Object.entries(jsonCopy(value)).filter(([key]) => !["__proto__", "constructor", "prototype"].includes(key)));
    } catch { return {}; }
  }

  function bridgeError(message, code, details) {
    const error = new Error(message);
    error.code = code;
    if (details !== undefined) error.details = details;
    return error;
  }

  function toError(value, fallback = "ChatGPT 未能完成此操作。") {
    if (value instanceof Error) return value;
    return bridgeError(typeof value?.message === "string" ? value.message : fallback, value?.code, value?.data);
  }

  function post(message) {
    if (closed || !parentWindow || parentWindow === window) throw bridgeError("请在 ChatGPT 插件内打开此界面。", -32002);
    // Opaque sandbox origins require '*'; incoming messages still require parent identity.
    parentWindow.postMessage(message, hostOrigin && hostOrigin !== "null" ? hostOrigin : "*");
  }

  function rpcRequest(method, params, timeout = REQUEST_TIMEOUT) {
    return new Promise((resolve, reject) => {
      const id = ++requestId;
      const timer = window.setTimeout(() => {
        pending.delete(id);
        reject(bridgeError("ChatGPT 连接等待超时。操作可能已提交，请先查看对话或历史记录，勿重复提交。", -32001));
      }, timeout);
      pending.set(id, { resolve, reject, timer, method });
      try { post({ jsonrpc: "2.0", id, method, params }); }
      catch (error) {
        window.clearTimeout(timer);
        pending.delete(id);
        reject(error);
      }
    });
  }

  function emitResult(result) {
    if (!result || typeof result !== "object") return;
    latestToolResult = result;
    for (const listener of [...resultListeners]) {
      try { listener(result); } catch { /* A view must not break the transport. */ }
    }
  }

  function aliasResult(globals) {
    // New ChatGPT hosts preserve the full result here, including hidden metadata.
    const metadata = globals?.toolResponseMetadata;
    const canonical = metadata?.mcp_tool_result ?? metadata?.call_tool_result;
    if (canonical && typeof canonical === "object") return canonical;
    if (globals?.toolOutput !== undefined && globals.toolOutput !== null) {
      return { structuredContent: globals.toolOutput };
    }
    return undefined;
  }

  function receiveMessage(event) {
    if (closed || event.source !== parentWindow) return;
    if (typeof event.origin !== "string" || !event.origin) return;
    if (hostOrigin !== null && event.origin !== hostOrigin) return;
    const message = event.data;
    if (!message || typeof message !== "object" || Array.isArray(message) || message.jsonrpc !== "2.0") return;

    if (Object.hasOwn(message, "id")) {
      const entry = pending.get(message.id);
      if (!entry || Object.hasOwn(message, "method")) return;
      if (!Object.hasOwn(message, "result") && !Object.hasOwn(message, "error")) return;
      // Only a response to our initialization may establish a previously unknown origin.
      if (hostOrigin === null) {
        if (entry.method !== "ui/initialize") return;
        hostOrigin = event.origin;
      }
      pending.delete(message.id);
      window.clearTimeout(entry.timer);
      if (message.error) entry.reject(toError(message.error));
      else entry.resolve(message.result);
      return;
    }

    // Do not accept unsolicited data until the handshake pins the parent origin.
    if (hostOrigin === null) return;
    if (message.method === "ui/notifications/tool-result") emitResult(message.params);
    else if (message.method === "ui/notifications/tool-input") latestToolInput = message.params;
  }

  window.addEventListener("message", receiveMessage, { passive: true });
  window.addEventListener("openai:set_globals", (event) => {
    const globals = event.detail?.globals;
    if (!globals || typeof globals !== "object") return;
    if (Object.hasOwn(globals, "widgetState")) state = copyRecord(globals.widgetState);
    if (Object.hasOwn(globals, "toolInput")) latestToolInput = globals.toolInput;
    const result = aliasResult(globals);
    if (result) emitResult(result);
  }, { passive: true });

  latestToolInput = window.openai?.toolInput;
  const initialResult = aliasResult(window.openai);
  if (initialResult) latestToolResult = initialResult;

  const ready = (async () => {
    try {
      const host = await rpcRequest("ui/initialize", {
        appInfo: { name: "workforce-planner", version: "0.18.0" },
        appCapabilities: {},
        protocolVersion: "2026-01-26",
      }, INIT_TIMEOUT);
      post({ jsonrpc: "2.0", method: "ui/notifications/initialized", params: {} });
      mode = "mcp-apps";
      return { connected: true, mode, host };
    } catch (error) {
      // Legacy aliases are feature-detected, not selected by the product name.
      if (typeof window.openai?.callTool === "function" || typeof window.openai?.sendFollowUpMessage === "function") {
        mode = "compatibility";
        return { connected: true, mode };
      }
      mode = "unavailable";
      return { connected: false, mode, error: toError(error).message };
    }
  })();

  function normalizeToolResult(result) {
    if (!result || typeof result !== "object") return { structuredContent: result ?? null };
    if (Object.hasOwn(result, "structuredContent") || Object.hasOwn(result, "content") || Object.hasOwn(result, "isError")) return result;
    return { structuredContent: result };
  }

  function assertToolSuccess(result) {
    if (result?.isError) {
      const text = result.content?.filter((block) => block?.type === "text" && typeof block.text === "string").map((block) => block.text).join("\n");
      throw bridgeError(text || "插件操作未成功，请查看对话中的提示。", -32003, result);
    }
    return result;
  }

  function withTimeout(action, timeout) {
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => reject(bridgeError("ChatGPT 连接等待超时。操作可能已提交，请先查看对话或历史记录，勿重复提交。", -32001)), timeout);
      Promise.resolve().then(action).then(
        (value) => { window.clearTimeout(timer); resolve(value); },
        (error) => { window.clearTimeout(timer); reject(toError(error)); },
      );
    });
  }

  async function sharedOrAlias(method, params, alias, timeout) {
    await ready;
    if (closed) throw bridgeError("此界面已关闭，请重新打开插件。", -32002);
    if (mode === "mcp-apps") {
      try { return await rpcRequest(method, params, timeout); }
      catch (error) {
        // Only a definite missing method is safe to retry through another transport.
        // A timeout or execution error must never replay a possibly committed write.
        if (error.code !== -32601 || typeof alias !== "function") throw error;
      }
    }
    if (typeof alias === "function") return withTimeout(alias, timeout);
    throw bridgeError("当前界面不支持此操作，请在 ChatGPT 对话中继续，或重新打开插件。", -32601);
  }

  window.workforceHost = Object.freeze({
    ready,
    async callTool(name, args = {}) {
      if (typeof name !== "string" || !/^[a-z][a-z0-9_]{0,127}$/.test(name)) throw bridgeError("插件工具名称无效。", -32602);
      const alias = typeof window.openai?.callTool === "function" ? () => window.openai.callTool(name, args) : undefined;
      const response = await sharedOrAlias("tools/call", { name, arguments: args }, alias, REQUEST_TIMEOUT);
      const result = assertToolSuccess(normalizeToolResult(response));
      emitResult(result);
      return result;
    },
    async sendMessage(text) {
      if (typeof text !== "string" || !text.trim() || text.length > MAX_STATE_LENGTH) throw bridgeError("发送给 ChatGPT 的测算内容为空或过大。", -32602);
      const alias = typeof window.openai?.sendFollowUpMessage === "function"
        ? () => window.openai.sendFollowUpMessage({ prompt: text, scrollToBottom: true }) : undefined;
      const response = await sharedOrAlias("ui/message", { role: "user", content: [{ type: "text", text }] }, alias, MESSAGE_TIMEOUT);
      // Some hosts return an application-level refusal in a successful RPC reply.
      // A transport acknowledgement must never turn that refusal into "submitted".
      if (response?.isError === true) {
        const message = response.content?.filter((block) => block?.type === "text" && typeof block.text === "string").map((block) => block.text).join("\n");
        throw bridgeError(message || "ChatGPT 未接收测算请求，请在对话中查看提示后重试。", -32003, response);
      }
      if (response?.accepted === false || response?.sent === false || response?.error) {
        throw toError(response.error || response, "ChatGPT 未接收测算请求，请在对话中查看提示后重试。");
      }
      // This acknowledges delivery only; the UI must wait for the generated plan.
      return response ?? { accepted: true };
    },
    onToolResult(listener) {
      if (typeof listener !== "function") throw new TypeError("onToolResult requires a callback");
      resultListeners.add(listener);
      if (latestToolResult) Promise.resolve().then(() => {
        if (resultListeners.has(listener)) {
          try { listener(latestToolResult); } catch { /* Same isolation as live events. */ }
        }
      });
      return () => resultListeners.delete(listener);
    },
    getToolInput() { return jsonCopy(latestToolInput); },
    getState() { return jsonCopy(state); },
    setState(partial) {
      if (!partial || typeof partial !== "object" || Array.isArray(partial)) throw bridgeError("界面状态格式无效。", -32602);
      // Validate before copyRecord's forgiving initial-snapshot handling.
      const validated = jsonCopy(partial);
      const next = { ...state, ...copyRecord(validated) };
      state = jsonCopy(next);
      try { window.openai?.setWidgetState?.(jsonCopy(state)); }
      catch { /* Hosts without persistence still support this instance's draft. */ }
      return jsonCopy(state);
    },
    async requestDisplayMode(displayMode = "fullscreen") {
      if (!["inline", "fullscreen", "pip"].includes(displayMode)) throw bridgeError("显示模式无效。", -32602);
      if (typeof window.openai?.requestDisplayMode !== "function") return { supported: false };
      return withTimeout(() => window.openai.requestDisplayMode({ mode: displayMode }), MESSAGE_TIMEOUT);
    },
  });

  window.addEventListener("pagehide", () => {
    closed = true;
    for (const entry of pending.values()) {
      window.clearTimeout(entry.timer);
      entry.reject(bridgeError("此界面已关闭，请重新打开插件。", -32002));
    }
    pending.clear();
    resultListeners.clear();
  }, { once: true });
})();
