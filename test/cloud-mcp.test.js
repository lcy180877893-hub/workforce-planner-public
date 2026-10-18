import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { createMcpServer } from "../src/mcp.js";
import { buildWorkforceUI, CLOUD_WORKFORCE_UI_URI, WORKFORCE_UI_URI, WORKFORCE_UI_MIME } from "../src/chatgpt-ui.js";
import { loadPublicConfig, principalFromClaims, PUBLIC_SCOPES } from "../src/public-auth.js";

const authConfig = loadPublicConfig({
  NODE_ENV: "production", PUBLIC_ORIGIN: "https://workforce.example",
  AUTH0_ISSUER_BASE_URL: "https://workforce-test.auth0.com",
  AUTH0_CLIENT_ID: "test-website-client", AUTH0_CLIENT_SECRET: "test-only-secret",
  SESSION_SECRET: "test-only-session-secret-at-least-32-bytes",
  DATABASE_URL: "postgresql://test:test@localhost/test", ADMIN_SUBJECTS: "auth0|admin",
});
const principalFor = (subject = "auth0|alice", scope = PUBLIC_SCOPES.join(" ")) => principalFromClaims({
  iss: authConfig.issuer, sub: subject, name: subject === "auth0|alice" ? "Alice" : "Other user", scope,
}, authConfig);
const accountFor = (principal) => ({ id: principal.id, displayName: principal.displayName, isAdmin: principal.isAdmin,
  canEditProductivity: true, productivityScope: "personal" });

const definitions = [
  { id: "test-rebar", name: "钢筋绑扎与安装", division: "主体结构工程", subitem: "钢筋工程", category: "钢筋工",
    unit: "t", output: 20, productivityUnit: "t/班组·8h", mode: "crew_day", crew: { 钢筋工: 4 },
    workContent: "同一施工对象的钢筋绑扎与安装", status: "confirmed", source: "仅测试内存数据" },
  { id: "test-concrete", name: "混凝土浇筑", division: "主体结构工程", subitem: "混凝土工程", category: "混凝土工",
    unit: "m³", output: 100, productivityUnit: "m³/班组·8h", mode: "crew_day", crew: { 混凝土工: 5 },
    workContent: "同一施工对象的混凝土浇筑", status: "confirmed", source: "仅测试内存数据" },
];

const projectInput = {
  project: {
    name: "内存测试项目", startDate: "2026-10-01", endDate: "2026-10-31",
    context: "同一 A 区钢筋绑扎验收完成后次日浇筑，不分区流水；模板预埋和养护均另行安排，不计入本次。工作面和班组已确认可用。",
  },
  workItems: [
    { itemId: "rebar", divisionId: "structure", subitemId: "rebar-part", activityId: "test-rebar", quantity: 50, unit: "t", divisionRemark: "A区" },
    { itemId: "concrete", divisionId: "structure", subitemId: "concrete-part", activityId: "test-concrete", quantity: 250, unit: "m³", divisionRemark: "A区" },
  ],
};

function reviewedInput(fingerprint, requestId = "cloud-test-request") {
  return {
    ...structuredClone(projectInput), requestId,
    constructionReview: {
      fingerprint, summary: "A区先完成钢筋并验收，再进行混凝土浇筑；不分区不并行。",
      reviewedItemIds: ["rebar", "concrete"],
      itemDecisions: [
        { itemId: "rebar", sequenceStatus: "determined", reason: "已确认模板及预埋另行完成，本项先施工并整项验收。" },
        { itemId: "concrete", sequenceStatus: "determined", reason: "同一A区钢筋整项绑扎及验收结束后，次日开始浇筑。" },
      ],
      dependencies: [{ beforeItemId: "rebar", afterItemId: "concrete", reason: "用户确认同一A区钢筋整项完成并验收后才能浇筑。" }],
      parallelGroups: [], assumptions: [], questions: [],
    },
  };
}

async function fixture(t, { principal = principalFor(), extraOptions = {}, storeError } = {}) {
  const calls = [];
  const records = new Map();
  let nextRecord = 1;
  const store = {
    async list({ search = "" } = {}) {
      calls.push(["productivity-list"]);
      if (storeError) throw storeError;
      return structuredClone(definitions.filter((item) => item.name.includes(search) || item.id.includes(search)));
    },
    async find(id) { calls.push(["productivity-find", id]); return structuredClone(definitions.find((item) => item.id === id) || null); },
    async upsert(input) { calls.push(["productivity-upsert", structuredClone(input)]); return input; },
    async delete(id) { calls.push(["productivity-delete", id]); return { id }; },
  };
  function save(plan, request = {}) {
    const record = { id: `history-${principal?.id.slice(0, 6) || "anonymous"}-${nextRecord++}`,
      createdAt: "2026-10-18T08:00:00.000Z", ...request, plan: structuredClone(plan) };
    records.set(record.id, record);
    return record;
  }
  const historyStore = {
    async list() { calls.push(["history-list"]); return structuredClone([...records.values()]); },
    async get(id) {
      calls.push(["history-get", id]);
      if (!records.has(id)) throw Object.assign(new Error("未找到此账号的历史记录"), { status: 404 });
      return structuredClone(records.get(id));
    },
    async findByRequestId(requestId) { calls.push(["history-request", requestId]); return structuredClone([...records.values()].find((record) => record.requestId === requestId) || null); },
    async add(plan) {
      calls.push(["history-add"]);
      const record = save(plan);
      return { id: record.id, createdAt: record.createdAt };
    },
    async addRequest(plan, request) {
      calls.push(["history-add-request", structuredClone(request)]);
      return { record: save(plan, request), created: true };
    },
    async delete(id) { calls.push(["history-delete", id]); return { id, deleted: records.delete(id) }; },
  };
  const server = createMcpServer(store, historyStore, { cloudMode: true, principal, authConfig, ...extraOptions });
  const client = new Client({ name: "cloud-mcp-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); });
  return { client, server, principal, calls, records, store };
}

test("cloud anonymous clients can discover tools/resources but every data tool is gated before store access", async (t) => {
  const f = await fixture(t, { principal: null });
  assert.equal(f.client.getServerVersion().name, "workforce-planner-public");
  const tools = (await f.client.listTools()).tools;
  assert.equal(tools.length, 11);
  assert.ok(tools.some((tool) => tool.name === "get_profile"));
  assert.ok(tools.some((tool) => tool.name === "open_workforce_planner"));
  const resources = await f.client.listResources();
  assert.deepEqual(resources.resources.map((resource) => resource.uri), [CLOUD_WORKFORCE_UI_URI]);
  const args = {
    open_workforce_planner: {}, list_productivity: {}, prepare_project_review: projectInput,
    generate_workforce_plan: reviewedInput("not-a-real-fingerprint"),
    list_workforce_history: {}, get_workforce_history: { id: "other-user-record" },
    delete_workforce_history: { id: "other-user-record" },
    upsert_productivity: { category: "test", name: "should not save" },
    delete_productivity: { id: "test-rebar" }, get_current_profile: {}, get_profile: {},
  };
  for (const tool of tools) {
    const result = await f.client.callTool({ name: tool.name, arguments: args[tool.name] });
    assert.equal(result.isError, true, tool.name);
    assert.equal(result.structuredContent, undefined, tool.name);
    const challenge = result._meta?.["mcp/www_authenticate"]?.[0];
    assert.match(challenge, /^Bearer /u, tool.name);
    assert.match(challenge, /resource_metadata="https:\/\/workforce.example\/\.well-known\/oauth-protected-resource"/u);
    assert.match(challenge, /error="invalid_token"/u);
    assert.match(challenge, /error_description="[^"\r\n]+"/u);
  }
  assert.deepEqual(f.calls, [], "匿名调用不能触及工效或任何账号的历史存储");
});

test("cloud tool discovery advertises OAuth scopes and versioned embedded templates", async (t) => {
  const { client } = await fixture(t);
  // SDK 1.32.1's built-in ToolSchema strips extension fields. Preserve the actual
  // wire descriptor here while ordinary discovery tests still exercise listTools().
  const wireListSchema = z.looseObject({
    tools: z.array(z.looseObject({
      name: z.string(), inputSchema: z.looseObject({ type: z.literal("object") }),
    })),
  });
  const tools = (await client.request({ method: "tools/list" }, wireListSchema)).tools;
  for (const tool of tools) {
    const scopes = tool.annotations.readOnlyHint === true ? ["workforce:read"] : PUBLIC_SCOPES;
    assert.deepEqual(tool.securitySchemes, [{ type: "oauth2", scopes }], `${tool.name} top-level schemes`);
    assert.deepEqual(tool._meta.securitySchemes, [{ type: "oauth2", scopes }], `${tool.name} mirrored schemes`);
  }
  for (const name of ["open_workforce_planner", "generate_workforce_plan", "get_workforce_history"]) {
    const tool = tools.find((item) => item.name === name);
    assert.equal(tool._meta["openai/outputTemplate"], CLOUD_WORKFORCE_UI_URI);
    assert.equal(tool._meta.ui.resourceUri, CLOUD_WORKFORCE_UI_URI);
  }
  const profile = tools.find((item) => item.name === "get_profile");
  assert.equal(profile._meta["openai/profile"], true);
  assert.deepEqual(profile.outputSchema.required.sort(), ["id", "name"]);
});

test("ordinary authenticated users can maintain their personal productivity with write scope; forged ownership is not forwarded", async (t) => {
  const f = await fixture(t);
  const catalog = await f.client.callTool({ name: "list_productivity", arguments: { search: "钢筋" } });
  assert.equal(catalog.isError, undefined);
  assert.equal(catalog.structuredContent.items.length, 1);
  assert.deepEqual(catalog.structuredContent.account, accountFor(f.principal));
  for (const [name, args] of [
    ["upsert_productivity", { category: "钢筋工", name: "forged", isAdmin: true, ownerId: "auth0|admin" }],
    ["delete_productivity", { id: "test-rebar", isAdmin: true, ownerId: "auth0|admin" }],
  ]) {
    const result = await f.client.callTool({ name, arguments: args });
    assert.equal(result.isError, undefined);
    assert.equal(result.structuredContent.account.canEditProductivity, true);
    assert.equal(result.structuredContent.account.productivityScope, "personal");
    assert.equal(result._meta?.["mcp/www_authenticate"], undefined);
  }
  const saved = f.calls.find(([name]) => name === "productivity-upsert")[1];
  assert.equal(saved.ownerId, undefined);
  assert.equal(saved.isAdmin, undefined);
  assert.equal(f.calls.some(([name]) => name === "productivity-delete"), true);
  const partial = await f.client.callTool({ name: "upsert_productivity", arguments: { id: "test-rebar", output: 25 } });
  assert.equal(partial.isError, undefined, "cloud MCP permits an output-only patch; store validates required fields for additions");
  const patch = f.calls.filter(([name]) => name === "productivity-upsert").at(-1)[1];
  assert.deepEqual(patch, { id: "test-rebar", output: 25 }, "MCP must not inject default mode, crew or empty applicability fields");
});

test("write scopes are enforced independently of admin and produce a scoped OAuth challenge", async (t) => {
  const f = await fixture(t, { principal: principalFor("auth0|admin", "workforce:read") });
  const catalog = await f.client.callTool({ name: "list_productivity", arguments: {} });
  assert.equal(catalog.isError, undefined);
  assert.equal(catalog.structuredContent.account.isAdmin, true);
  const result = await f.client.callTool({ name: "upsert_productivity", arguments: { category: "test", name: "not saved" } });
  assert.equal(result.isError, true);
  assert.match(result._meta["mcp/www_authenticate"][0], /error="insufficient_scope"/u);
  assert.match(result._meta["mcp/www_authenticate"][0], /error_description=/u);
  assert.equal(f.calls.some(([name]) => name === "productivity-upsert"), false);
});

test("get_profile is strict opaque id/name only, while current profile and open UI return trusted account", async (t) => {
  const f = await fixture(t);
  const result = await f.client.callTool({ name: "get_profile", arguments: { id: "auth0|admin", isAdmin: true } });
  assert.deepEqual(Object.keys(result.structuredContent).sort(), ["id", "name"]);
  assert.deepEqual(result.structuredContent, { id: f.principal.id, name: f.principal.displayName });
  assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
  assert.equal(result.structuredContent.account, undefined);
  assert.equal(JSON.stringify(result).includes(f.principal.subject), false, "profile不得泄露原始Auth0 subject");
  const current = await f.client.callTool({ name: "get_current_profile", arguments: {} });
  assert.deepEqual(current.structuredContent.account, accountFor(f.principal));
  for (const page of ["planner", "ratios", "history", "library"]) {
    const opened = await f.client.callTool({ name: "open_workforce_planner", arguments: { page } });
    assert.equal(opened.isError, undefined);
    assert.equal(opened.structuredContent.ui.page, page);
    assert.deepEqual(opened.structuredContent.account, accountFor(f.principal));
    assert.equal(opened.structuredContent.bootstrap.productivity.length, 2);
    assert.deepEqual(opened.structuredContent.bootstrap.history, []);
  }
});

test("prepare → reviewed generation → read-only saved history includes account and preserves verified order without model API", async (t) => {
  // All required work uses deterministic in-process computation, not any provider/model call.
  t.mock.method(globalThis, "fetch", async () => { throw new Error("No external network/model API is allowed in this test"); });
  const f = await fixture(t);
  const prepared = await f.client.callTool({ name: "prepare_project_review", arguments: projectInput });
  assert.equal(prepared.isError, undefined);
  assert.deepEqual(prepared.structuredContent.account, accountFor(f.principal));
  assert.equal(prepared.structuredContent.workItems.length, 2);
  const input = reviewedInput(prepared.structuredContent.fingerprint);
  const generated = await f.client.callTool({ name: "generate_workforce_plan", arguments: input });
  assert.equal(generated.isError, undefined);
  const plan = generated.structuredContent;
  assert.deepEqual(plan.account, accountFor(f.principal));
  assert.equal(plan.workflow.mode, "gpt");
  assert.equal(plan.workflow.fingerprint, input.constructionReview.fingerprint);
  assert.equal(plan.requestId, input.requestId);
  assert.deepEqual(plan.planOptions.map((option) => option.id), ["sequential"]);
  const ordered = plan.planOptions[0].workItems;
  assert.equal(ordered[0].itemId, "rebar");
  assert.equal(ordered[1].itemId, "concrete");
  assert.ok(ordered[1].startDate > ordered[0].finishDate || ordered[1].startDate > ordered[0].endDate,
    "同一施工对象的混凝土必须在整项钢筋结束后施工");
  assert.equal(f.records.size, 1);
  const repeated = await f.client.callTool({ name: "generate_workforce_plan", arguments: input });
  assert.equal(repeated.structuredContent.history.id, plan.history.id);
  assert.deepEqual(repeated.structuredContent.account, accountFor(f.principal));
  assert.equal(f.records.size, 1, "相同requestId不得新增测算历史");
  const list = await f.client.callTool({ name: "list_workforce_history", arguments: {} });
  assert.deepEqual(list.structuredContent.account, accountFor(f.principal));
  assert.equal(list.structuredContent.items[0].id, plan.history.id);
  const detail = await f.client.callTool({ name: "get_workforce_history", arguments: { id: plan.history.id } });
  assert.deepEqual(detail.structuredContent.account, accountFor(f.principal));
  assert.equal(detail.structuredContent.record.id, plan.history.id);
  const opened = await f.client.callTool({ name: "open_workforce_planner", arguments: { page: "history" } });
  assert.equal(opened.structuredContent.bootstrap.history.length, 1);
  assert.deepEqual(opened.structuredContent.account, accountFor(f.principal));
  assert.equal(f.calls.filter(([name]) => name === "history-add-request").length, 1);
  assert.equal(globalThis.fetch.mock.calls.length, 0);
});

test("independently bound principals cannot obtain another session's history by supplied user arguments", async (t) => {
  const a = await fixture(t);
  const b = await fixture(t, { principal: principalFor("auth0|bob") });
  const prepared = await a.client.callTool({ name: "prepare_project_review", arguments: projectInput });
  const generated = await a.client.callTool({ name: "generate_workforce_plan",
    arguments: reviewedInput(prepared.structuredContent.fingerprint, "only-alice") });
  const id = generated.structuredContent.history.id;
  const bobList = await b.client.callTool({ name: "list_workforce_history", arguments: {
    ownerId: a.principal.id, userId: a.principal.id, account: accountFor(a.principal),
  } });
  assert.deepEqual(bobList.structuredContent.items, []);
  assert.deepEqual(bobList.structuredContent.account, accountFor(b.principal));
  const bobRead = await b.client.callTool({ name: "get_workforce_history", arguments: { id, ownerId: a.principal.id } });
  assert.equal(bobRead.isError, true);
  assert.equal(bobRead.structuredContent, undefined);
  assert.equal(a.records.size, 1);
});

test("cloud embedded resource is versioned, self-contained, four-page and public isolation boots before adapter/app", async (t) => {
  const { client } = await fixture(t, { principal: null, extraOptions: { publicMode: true } });
  // Dedicated cloud mode cannot silently fall back to the legacy three-tool anonymous demo.
  assert.equal((await client.listTools()).tools.length, 11);
  assert.match(client.getInstructions(), /服务器验证/u);
  assert.match(client.getInstructions(), /不得调用模型API/u);
  const resource = await client.readResource({ uri: CLOUD_WORKFORCE_UI_URI });
  assert.equal(resource.contents.length, 1);
  const entry = resource.contents[0];
  assert.equal(entry.uri, CLOUD_WORKFORCE_UI_URI);
  assert.equal(entry.mimeType, WORKFORCE_UI_MIME);
  assert.notEqual(CLOUD_WORKFORCE_UI_URI, WORKFORCE_UI_URI);
  const html = entry.text;
  assert.match(html, /<body data-chatgpt-app="true">/u);
  for (const page of ["planner", "ratios", "history", "library"]) {
    assert.match(html, new RegExp(`data-tab="${page}"`));
    assert.match(html, new RegExp(`id="${page}"`));
  }
  assert.match(entry._meta["openai/widgetDescription"], /历史按账号隔离/u);
  assert.deepEqual(entry._meta["openai/widgetCSP"].connect_domains, []);
  assert.doesNotMatch(html, /<script[^>]+src=/iu);
  assert.doesNotMatch(html, /<link\s+rel="stylesheet"/iu);
  const bridge = html.indexOf("window.workforceHost = Object.freeze({");
  const publicFlag = html.indexOf("globalThis.WORKFORCE_PUBLIC_MODE = true;");
  const isolation = html.indexOf("const session = globalThis.workforcePublicSession");
  const adapter = html.indexOf("const publicSession = globalThis.workforcePublicSession");
  const application = html.indexOf("const { DEFAULT_CALENDAR_RULES, resolveCalendarRules } = (() => {");
  assert.ok(bridge >= 0 && bridge < publicFlag, "宿主桥必须先于公开隔离层初始化");
  assert.ok(publicFlag < isolation, "公开模式标识必须在公开隔离层前");
  assert.ok(isolation < adapter && adapter < application, "隔离层必须先于内嵌适配器和应用脚本");
  const privateHtml = await buildWorkforceUI();
  assert.doesNotMatch(privateHtml, /globalThis.WORKFORCE_PUBLIC_MODE = true;/u);
  assert.doesNotMatch(privateHtml, /const session = globalThis.workforcePublicSession/u);
});

test("unexpected storage failures are sanitized and never expose provider/connection secrets", async (t) => {
  const secret = "postgresql://test:test@localhost/synthetic-private-db-name";
  const f = await fixture(t, { storeError: new Error(secret) });
  const result = await f.client.callTool({ name: "list_productivity", arguments: {} });
  assert.equal(result.isError, true);
  assert.doesNotMatch(JSON.stringify(result), /postgresql:|synthetic-private-db-name/u);
  assert.equal(result._meta?.["mcp/www_authenticate"], undefined, "存储故障不得误触发重新授权");
});
