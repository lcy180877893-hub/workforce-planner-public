import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createHash } from "node:crypto";
import { z } from "zod";
import { generateWorkforcePlan } from "./planner.js";
import { buildProjectReviewContext } from "./project-review.js";
import { WORKFORCE_UI_URI, CLOUD_WORKFORCE_UI_URI, CLOUD_WORKFORCE_UI_LEGACY_URIS, LOCAL_WORKFORCE_UI_URI, WORKFORCE_UI_MIME, PUBLIC_VERSION, buildWorkforceUI, uiResourceMetadata } from "./chatgpt-ui.js";
import { requirePrincipal, oauthChallenge } from "./public-auth.js";
import { bundledProductivityStore } from "./cloud-stores.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const PRIVATE_USAGE_INSTRUCTIONS = "每次用户开始新一轮使用本插件时，先询问：‘本次是否使用内嵌版手动输入工程量？’等待用户选择后再进入操作。选择使用则调用open_workforce_planner（page:planner），在当前聊天打开内嵌界面供手动输入；选择不使用则允许用户在聊天中提供工程量，或按其要求读取指定的已保存方案。用户已明确选择输入方式、已从内嵌界面提交工程量、或本轮已回答时，不在后续工具调用、切页、补充条件和结果回填时重复询问。新项目或新的独立使用再次询问；不把本轮选择保存为永久免询问。该询问不授权测算、保存、修改或删除。仅查看历史时只读原记录，不重新测算或新增记录；工效维护仍按用户明确请求执行。";
const GUEST_USAGE_INSTRUCTIONS = "游客可直接在当前 AI 会话中使用随公开版本提供的默认工效测算。按工序名称调用 list_productivity 获取工效编码，调用 prepare_project_review 读取资料，由当前会话判断施工先后，再用本次指纹调用 generate_workforce_plan 展示方案。游客结果返回当前会话，插件不保存游客测算。用户要求手动输入且客户端支持界面时，可调用 open_workforce_planner。不得调用模型API。";
const GUEST_TOOLS = new Set(["list_productivity", "prepare_project_review", "generate_workforce_plan", "open_workforce_planner", "get_current_profile"]);
const LOCAL_TOOLS = new Set([...GUEST_TOOLS, "upsert_productivity", "delete_productivity"]);
const LOCAL_USAGE_INSTRUCTIONS = "本机版无需插件账号。要打开工效库界面，调用 open_workforce_planner（page:library）。用户明确要求维护工效时，可新增、修改或删除，仅保存在当前电脑用户的工效库。测算时先调用 list_productivity 选用本机最新工效，再调用 prepare_project_review，由当前会话判断施工顺序，携带本次指纹调用 generate_workforce_plan。测算结果返回当前会话。";

const crewSchema = z.record(z.string(), z.number().positive());
const seasonSchema = z.object({
  start: z.string().regex(/^\d{2}-\d{2}$/).optional(),
  end: z.string().regex(/^\d{2}-\d{2}$/).optional(),
  factor: z.number().positive().max(2).optional(),
});
const calendarRulesSchema = z.object({
  winter: seasonSchema.optional(),
  summer: seasonSchema.optional(),
  ramadan: z.object({
    mode: z.enum(["auto", "custom"]).optional(),
    ranges: z.array(z.object({ startDate: z.string(), endDate: z.string() })).optional(),
    factor: z.number().positive().max(2).optional(),
  }).optional(),
});

const projectSchema = z.object({
  name: z.string().optional(),
  context: z.string().max(5000).optional().describe("项目类型、施工方法、现场条件、工作面及资源共用等说明"),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  calendarRules: calendarRulesSchema.optional(),
});
const workItemsSchema = z.array(z.object({
  itemId: z.string().optional().describe("工序实例唯一编码，不能以工效编码代替；省略时为item-1等"),
  divisionId: z.string().optional(), subitemId: z.string().optional(),
  division: z.string().optional(), subitem: z.string().optional(),
  divisionRemark: z.string().max(200).optional().describe("楼栋、楼层或区域等施工部位；同一部位各分部使用相同备注"),
  activityId: z.string().optional(), name: z.string().optional(),
  remark: z.string().max(500).optional(),
  processType: z.enum(["auto", "other", "rebar", "concrete_cast", "concrete_cure"]).optional(),
  quantity: z.number().positive(), unit: z.string().optional(),
})).min(1).max(500);
const constructionReviewSchema = z.object({
  fingerprint: z.string().min(1), summary: z.string().min(1),
  reviewedItemIds: z.array(z.string()).min(1),
  itemDecisions: z.array(z.object({ itemId: z.string(), sequenceStatus: z.enum(["determined", "needs_information"]), reason: z.string().min(1) })).min(1),
  dependencies: z.array(z.object({ beforeItemId: z.string(), afterItemId: z.string(), reason: z.string().min(1) })),
  parallelGroups: z.array(z.object({ itemIds: z.array(z.string()).min(2), reason: z.string().min(1) })),
  assumptions: z.array(z.string()), questions: z.array(z.string()),
});

export const cloudReviewInputSchema = z.object({ project: projectSchema, workItems: workItemsSchema });
export const cloudPlanInputSchema = cloudReviewInputSchema.extend({
  constructionReview: constructionReviewSchema,
  requestId: z.string().min(1).max(120),
});
export { requestHash, validatePublicInput };

function validatePublicInput(args, publicMode) {
  if (!publicMode) return;
  if (args.workItems.length > 100) throw Object.assign(new Error("公开插件每次最多测算100项工程量"), { statusCode: 400 });
  const duration = (Date.parse(args.project.endDate) - Date.parse(args.project.startDate)) / 86400000;
  if (!Number.isFinite(duration) || duration > 1826) throw Object.assign(new Error("公开插件单次项目施工时间最多5年"), { statusCode: 400 });
}

function toolResult(value) {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
  };
}

function canonicalRequest(value) {
  if (Array.isArray(value)) return value.map(canonicalRequest);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => [key, canonicalRequest(value[key])]));
  }
  return value;
}

function requestHash(input) {
  return createHash("sha256").update(JSON.stringify(canonicalRequest(input))).digest("hex");
}

function savedRequestResult(record, requestInputHash) {
  if (record.requestInputHash !== requestInputHash) {
    throw new Error("此测算请求标识已用于其他工程量或施工审查，请重新发起测算");
  }
  return toolResult({
    ...record.plan,
    requestId: record.requestId,
    history: { id: record.id, createdAt: record.createdAt },
  });
}

function privateUiMetadata(publicMode, { render = false, entrypoints = false } = {}) {
  if (publicMode) return {};
  const metadata = {
    ui: { visibility: ["model", "app"] },
    "openai/widgetAccessible": true,
  };
  if (render) {
    metadata.ui.resourceUri = WORKFORCE_UI_URI;
    metadata["openai/outputTemplate"] = WORKFORCE_UI_URI;
  }
  if (entrypoints) {
    metadata["openai/ui"] = { entrypoints: [{ type: "global" }, { type: "thread" }] };
  }
  return { _meta: metadata };
}

export function createGuestMcpServer() {
  return createMcpServer(bundledProductivityStore, null, { cloudMode: true, guestOnly: true });
}

export function createLocalMcpServer(productivityStore) {
  return createMcpServer(productivityStore, null, { cloudMode: true, guestOnly: true, localMode: true });
}

export function createMcpServer(productivityStore, historyStore, {
  publicMode = false, cloudMode = false, guestOnly = false, localMode = false, principal = null, authConfig = null,
} = {}) {
  // cloudMode is selected by the cloud entry point, never by
  // tool arguments or a browser-supplied user identifier.
  if (cloudMode) publicMode = false;
  const anonymous = cloudMode && !principal;
  const anonymousAccessMode = localMode ? "local" : "guest";
  const anonymousTools = localMode ? LOCAL_TOOLS : GUEST_TOOLS;
  const uiUri = localMode ? LOCAL_WORKFORCE_UI_URI : cloudMode ? CLOUD_WORKFORCE_UI_URI : WORKFORCE_UI_URI;
  const pendingRequests = new Map();
  const server = new McpServer({
    name: localMode ? "workforce-planner-local" : cloudMode ? "workforce-planner-public" : "saudi-workforce-planner",
    version: cloudMode ? PUBLIC_VERSION : "0.18.0",
  }, publicMode ? {} : { instructions: localMode ? LOCAL_USAGE_INSTRUCTIONS : cloudMode ? GUEST_USAGE_INSTRUCTIONS + (guestOnly ? ""
    : " 登录账号可使用个人工效及个人测算历史，身份与权限由服务器验证。") : PRIVATE_USAGE_INSTRUCTIONS });

  if (cloudMode) {
    // SDK 1.32 exposes custom tool fields through _meta but does not copy the
    // top-level securitySchemes argument into tools/list. Mirror it in the
    // protocol response without depending on the SDK's private registries.
    const setRequestHandler = server.server.setRequestHandler.bind(server.server);
    server.server.setRequestHandler = (schema, handler) => setRequestHandler(schema,
      schema === ListToolsRequestSchema ? async (...args) => {
        const result = await handler(...args);
        return { ...result, tools: result.tools.map((tool) => ({ ...tool,
          securitySchemes: tool._meta.securitySchemes,
        })) };
      } : handler);
    const register = server.registerTool.bind(server);
    server.registerTool = (name, definition, handler) => {
      const anonymousAllowed = anonymousTools.has(name);
      if (guestOnly && !anonymousAllowed) return;
      const scopes = definition.annotations?.readOnlyHint === true
        ? ["workforce:read"] : ["workforce:read", "workforce:write"];
      const securitySchemes = [
        ...(anonymousAllowed ? [{ type: "noauth" }] : []),
        ...(guestOnly ? [] : [{ type: "oauth2", scopes }]),
      ];
      const profile = name === "get_profile";
      const cloudMetadata = { ...definition._meta, securitySchemes };
      if (cloudMetadata.ui?.resourceUri) cloudMetadata.ui = { ...cloudMetadata.ui, resourceUri: uiUri };
      if (cloudMetadata["openai/outputTemplate"]) cloudMetadata["openai/outputTemplate"] = uiUri;
      return register(name, {
        ...definition, securitySchemes,
        _meta: cloudMetadata,
      }, async (...args) => {
        try {
          if (!anonymous || !anonymousAllowed) requirePrincipal(principal, scopes);
          const result = await handler(...args);
          if (!result.isError && result.structuredContent && !profile) {
            if (anonymous) return { ...result, ...toolResult({ ...result.structuredContent, accessMode: anonymousAccessMode, account: null }) };
            const account = { id: principal.id, displayName: principal.displayName, isAdmin: principal.isAdmin,
              canEditProductivity: true, productivityScope: "personal" };
            return { ...result, ...toolResult({ ...result.structuredContent, account }) };
          }
          return result;
        } catch (error) {
          const status = Number(error.statusCode ?? error.status);
          return {
            isError: true,
            content: [{ type: "text", text: [400, 401, 403, 404, 409, 413, 429].includes(status)
              ? error.message : localMode ? "本机操作未完成，请检查本机工效库或稍后重试。" : "操作未完成，请稍后重试或联系管理员。未使用其他账户的数据。" }],
            ...(!guestOnly && (status === 401 || error.code === "insufficient_scope") ? { _meta: {
              "mcp/www_authenticate": [oauthChallenge(authConfig, error.code ?? "invalid_token")],
            } } : {}),
          };
        }
      });
    };
  }

  if (!publicMode) {
    // A connected ChatGPT client can retain the preceding outputTemplate URI.
    // Register the recent public URIs as read-only aliases so that a server
    // update never turns a cached tool descriptor into a blank widget.
    const resourceUris = cloudMode ? [...new Set([uiUri, ...CLOUD_WORKFORCE_UI_LEGACY_URIS])] : [uiUri];
    const embeddedUi = buildWorkforceUI({ cloudMode });
    for (const resourceUri of resourceUris) server.registerResource(
      resourceUri === uiUri ? "workforce-planner-ui" : `workforce-planner-ui-compat-${resourceUri.split("v").at(-1)}`,
      resourceUri,
      { title: "工程劳动力测算", description: "劳动力测算、比例设置、测算历史与工效库四个页面", mimeType: WORKFORCE_UI_MIME },
      async () => ({
        contents: [{
          uri: resourceUri,
          mimeType: WORKFORCE_UI_MIME,
          text: await embeddedUi,
          _meta: cloudMode ? { ...uiResourceMetadata,
            "openai/widgetDescription": localMode ? "工程劳动力测算本机版：免登录维护这台电脑的工效库，并用本机工效测算。"
              : "工程劳动力测算公开版：使用共享工效免登录测算，登录后可使用个人工效与历史。历史按账号隔离。施工顺序由当前 AI 会话判断，无额外模型API。" } : uiResourceMetadata,
        }],
      }),
    );
    server.registerTool(
      "open_workforce_planner",
      {
        title: "打开工程劳动力测算界面",
        description: localMode ? "打开本机劳动力测算工作台。使用 page:library 可直接在界面新增、修改和删除本机工效，无需插件登录。"
          : cloudMode
          ? "在支持内嵌界面的客户端打开劳动力测算工作台。游客可使用公开默认工效测算并设置施工比例。施工先后由当前 AI 会话判断。"
          : "每轮使用先按服务器说明询问是否使用内嵌版手动输入工程量；用户选择使用或明确要求打开内嵌界面时调用。在当前ChatGPT聊天内打开与原网站共用工效库和测算历史的四页界面。不修改数据、不调用模型API；界面点击测算后，由当前ChatGPT会话读取全项目资料、判断施工顺序，再生成方案。",
        inputSchema: {
          page: z.enum(["planner", "ratios", "history", "library"]).optional().describe("打开的页面，默认劳动力测算"),
        },
        outputSchema: {
          ui: z.object({ page: z.enum(["planner", "ratios", "history", "library"]) }),
          ...(cloudMode ? { account: z.object({ id: z.string(), displayName: z.string(), isAdmin: z.boolean(),
            canEditProductivity: z.boolean(), productivityScope: z.literal("personal") }).nullable(),
            accessMode: z.literal(anonymousAccessMode).optional() } : {}),
        },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        ...privateUiMetadata(false, { render: true, entrypoints: true }),
      },
      async ({ page = "planner" }) => {
        // The embedded UI obtains its live catalog through list_productivity
        // after mounting. Returning the full catalog here duplicated it in
        // both structuredContent and text content (over 200 KB on the public
        // library), which can prevent a host from mounting the component.
        // Keep this launch result deliberately small and page-specific.
        return toolResult({ ui: { page } });
      },
    );
  }

  server.registerTool(
    "list_productivity",
    {
      title: "查询工效库",
      description: "按关键词或状态查询工种类型、适用分项、班组配置、推荐工效和工作内容。",
      inputSchema: {
        search: z.string().optional().describe("工序、专业、编码或单位关键词"),
        status: z.enum(["confirmed", "needs_validation", "unavailable"]).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
      ...privateUiMetadata(publicMode),
    },
    async ({ search = "", status = "" }) =>
      toolResult({ items: await productivityStore.list({ search, status }) }),
  );

  server.registerTool(
    "prepare_project_review",
    {
      title: "读取全项目施工逻辑判断资料",
      description: "生成劳动力方案前，读取工程量、施工部位、项目说明和工效。当前 AI 会话根据返回的资料逐项判断施工先后与可并行工序，填写itemDecisions和依赖依据，再携带本次指纹和constructionReview调用generate_workforce_plan。必要信息不足时标记needs_information并向用户补问。",
      inputSchema: { project: projectSchema, workItems: workItemsSchema },
      annotations: { readOnlyHint: true, openWorldHint: false },
      ...privateUiMetadata(publicMode),
    },
    async (args) => {
      validatePublicInput(args, publicMode || cloudMode);
      return toolResult(await buildProjectReviewContext(args, productivityStore));
    },
  );

  server.registerTool(
    "generate_workforce_plan",
    {
      title: "生成劳动力方案",
      description:
        "先调用prepare_project_review，由当前 AI 会话结合本次全项目资料判断真实施工逻辑，并传入constructionReview；不额外调用模型API。顺序单班组白班足够时仅提供顺序施工；不足时先尝试单班组白班多工序搭接，仍不足再比较多班组白班多工序搭接，原单班组早晚班和多班组白班顺序方案继续供选择。两种搭接都仅允许parallelGroups已确认的组合，保留技术前置，不把缺少依赖当可并行。增组搭接按工序配置整数班组，每日1个8小时白班，人员分别计入，工作面与机械材料能否容纳反算班组须核实，不能冒称已审批。不恢复旧版均衡穿插或提前穿插。结果含班组人员、人日、实际搭接依据、柱状图与横道图；不可行方案说明原因。输入或工效变化后须重新判断；若界面提供requestId，必须原样传回，不复用旧请求。",
      inputSchema: {
        project: projectSchema,
        workItems: workItemsSchema,
        constructionReview: constructionReviewSchema,
        ...(!publicMode ? { requestId: z.string().min(1).max(120).optional().describe("内嵌界面本次测算请求标识，若提供必须原样传回；不影响施工审查指纹") } : {}),
      },
      annotations: { readOnlyHint: publicMode || guestOnly, destructiveHint: false, openWorldHint: false },
      ...privateUiMetadata(publicMode, { render: true }),
    },
    async (args) => {
      validatePublicInput(args, publicMode || cloudMode);
      const { requestId, ...planningInput } = args;
      if (anonymous) {
        const plan = await generateWorkforcePlan(planningInput, productivityStore);
        return toolResult({ ...plan, ...(requestId ? { requestId } : {}), saved: false });
      }
      if (publicMode) {
        return toolResult(await generateWorkforcePlan(planningInput, productivityStore));
      }
      if (requestId) {
        const requestInputHash = requestHash(planningInput);
        const pending = pendingRequests.get(requestId);
        if (pending) {
          if (pending.requestInputHash !== requestInputHash) {
            throw new Error("此测算请求标识正在处理其他工程量或施工审查，请重新发起测算");
          }
          return pending.result;
        }
        const result = (async () => {
          const existing = await historyStore.findByRequestId(requestId);
          if (existing) return savedRequestResult(existing, requestInputHash);
          const plan = await generateWorkforcePlan(planningInput, productivityStore);
          const { record } = await historyStore.addRequest(plan, { requestId, requestInputHash });
          return savedRequestResult(record, requestInputHash);
        })();
        pendingRequests.set(requestId, { requestInputHash, result });
        try {
          return await result;
        } finally {
          if (pendingRequests.get(requestId)?.result === result) pendingRequests.delete(requestId);
        }
      }
      const plan = await generateWorkforcePlan(planningInput, productivityStore);
      const history = await historyStore.add(plan);
      return toolResult({ ...plan, history });
    },
  );

  if (!publicMode) {
  server.registerTool(
    "list_workforce_history",
    {
      title: "查询测算历史",
      description: "按最近测算优先列出施工时间、各工种人数和人日汇总。",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
      ...privateUiMetadata(false),
    },
    async () => toolResult({ items: await historyStore.list() }),
  );

  server.registerTool(
    "get_workforce_history",
    {
      title: "查看历史劳动力方案",
      description: "按历史记录编码查看完整的各工种人员配置和分项测算明细。",
      inputSchema: { id: z.string().min(1).describe("测算历史记录编码") },
      annotations: { readOnlyHint: true, openWorldHint: false },
      ...privateUiMetadata(false, { render: true }),
    },
    async ({ id }) => toolResult({ record: await historyStore.get(id) }),
  );

  server.registerTool(
    "delete_workforce_history",
    {
      title: "删除测算历史",
      description: "按编码永久删除一条测算历史记录。",
      inputSchema: { id: z.string().min(1).describe("要删除的测算历史记录编码") },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
      ...privateUiMetadata(false),
    },
    async ({ id }) => toolResult({ deleted: await historyStore.delete(id) }),
  );

  server.registerTool(
    "upsert_productivity",
    {
      title: "补充或更新工效",
      description: localMode ? "新增或修改本机工效。修改已有条目时传入编码及需要变动的字段，省略字段保留原值。本次更改供这台电脑当前用户的后续测算使用。"
        : cloudMode
        ? "新增或修改当前登录账号的个人工效版本。相同编码覆盖本人版本；不修改公共默认库或其他账号。改变参与测算的工效后须重新读取并审查施工顺序。推荐工效采用标准8小时班组产量。"
        : "新增或修改工效。同一编码会覆盖当前版本；推荐工效采用标准8小时班组产量。",
      inputSchema: {
        id: z.string().optional(),
        ...(localMode ? { mustExist: z.boolean().optional().describe("编辑界面已选条目时设为 true，条目已删除则提示刷新") } : {}),
        division: z.string().optional().describe("分部工程；未提供时归入其他工程"),
        subitem: z.string().optional().describe("分项工程；未提供时归入未分类分项"),
        category: (cloudMode ? z.string().min(1).optional() : z.string().min(1)).describe("工种类型；公开版修改已有工效时可省略以保留原值，新增时必填"),
        name: (cloudMode ? z.string().min(1).optional() : z.string().min(1)).describe("适用分项；公开版修改已有工效时可省略以保留原值，新增时必填"),
        ...(cloudMode ? {
          mode: z.enum(["crew_day", "role_productivity", "equipment_hour"]).optional(),
          roleProductivity: crewSchema.optional(),
          equipment: z.array(z.string()).optional(),
        } : {}),
        crew: crewSchema.optional().describe("班组人员配置；不可用状态可暂缺"),
        crewText: z.string().optional().describe("班组配置显示文本"),
        output: z.number().positive().nullable().optional().describe("标准8小时班组推荐工效；不可用状态可暂缺"),
        unit: z.string().optional().describe("工程量基础单位；不可用状态可暂缺"),
        productivityUnit: z.string().optional().describe("完整工效单位，如㎡/班组·8h"),
        workContent: z.string().optional().describe("工作内容"),
        source: z.string().optional(),
        status: z.enum(["confirmed", "needs_validation", "unavailable"]).optional(),
        notes: z.string().optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      ...privateUiMetadata(false),
    },
    async (args) => {
      if (!localMode) return toolResult({ saved: await productivityStore.upsert(args) });
      const { mustExist, ...entry } = args;
      return toolResult({ saved: await productivityStore.upsert(entry, { mustExist }) });
    },
  );

  server.registerTool(
    "delete_productivity",
    {
      title: "删除工效",
      description: localMode ? "按编码从本机工效库删除条目。随软件提供的默认条目只在这台电脑上隐藏。"
        : cloudMode
        ? "按编码仅在当前登录账号的个人工效库中隐藏一条工效，不删除公共默认库或其他账号版本。相同编码重新保存可恢复本人版本。"
        : "按编码从当前工效库中删除一条工效。默认库条目会被隐藏，使用相同编码重新保存即可恢复。",
      inputSchema: {
        id: z.string().min(1).describe("要删除的工效编码"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      ...privateUiMetadata(false),
    },
    async ({ id }) => toolResult({ deleted: await productivityStore.delete(id) }),
  );
  }

  if (cloudMode) {
    server.registerTool("get_current_profile", {
      title: "查看当前使用身份", description: localMode ? "返回免登录的本机使用状态。" : "游客可直接开始测算，返回游客状态；已登录时返回服务器验证的当前账号及个人工效编辑权限。",
      inputSchema: {}, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      ...privateUiMetadata(false),
    }, async () => toolResult(anonymous ? { authenticated: false } : { account: { id: principal.id, displayName: principal.displayName, isAdmin: principal.isAdmin } }));
    server.registerTool("get_profile", {
      title: "当前连接账户", description: "返回本次已验证凭证对应的稳定、不透明账户标识；标识不会随登录、令牌刷新或显示名称变化。",
      inputSchema: {}, outputSchema: { id: z.string().min(1), name: z.string() },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      _meta: { "openai/profile": true },
    }, async () => toolResult({ id: principal.id, name: principal.displayName }));
  }

  return server;
}
