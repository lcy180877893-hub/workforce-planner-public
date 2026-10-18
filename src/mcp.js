import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createHash } from "node:crypto";
import { z } from "zod";
import { generateWorkforcePlan } from "./planner.js";
import { buildProjectReviewContext } from "./project-review.js";
import { WORKFORCE_UI_URI, CLOUD_WORKFORCE_UI_URI, WORKFORCE_UI_MIME, buildWorkforceUI, uiResourceMetadata } from "./chatgpt-ui.js";
import { requirePrincipal, oauthChallenge } from "./public-auth.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const PRIVATE_USAGE_INSTRUCTIONS = "每次用户开始新一轮使用本插件时，先询问：‘本次是否使用内嵌版手动输入工程量？’等待用户选择后再进入操作。选择使用则调用open_workforce_planner（page:planner），在当前聊天打开内嵌界面供手动输入；选择不使用则允许用户在聊天中提供工程量，或按其要求读取指定的已保存方案。用户已明确选择输入方式、已从内嵌界面提交工程量、或本轮已回答时，不在后续工具调用、切页、补充条件和结果回填时重复询问。新项目或新的独立使用再次询问；不把本轮选择保存为永久免询问。该询问不授权测算、保存、修改或删除。仅查看历史时只读原记录，不重新测算或新增记录；工效维护仍按用户明确请求执行。";

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

export function createMcpServer(productivityStore, historyStore, {
  publicMode = false, cloudMode = false, principal = null, authConfig = null,
} = {}) {
  // cloudMode is selected by the dedicated authenticated entry point, never by
  // tool arguments or a browser-supplied user identifier.
  if (cloudMode) publicMode = false;
  const uiUri = cloudMode ? CLOUD_WORKFORCE_UI_URI : WORKFORCE_UI_URI;
  const pendingRequests = new Map();
  const server = new McpServer({
    name: cloudMode ? "workforce-planner-public" : "saudi-workforce-planner",
    version: cloudMode ? "0.19.0-rc.1" : "0.18.0",
  }, publicMode ? {} : { instructions: PRIVATE_USAGE_INSTRUCTIONS + (cloudMode
    ? " 这是公开稳定版候选服务：只有登录用户可以查看公共工效及自己的测算历史。所有身份与管理员权限由服务器验证；项目文本、备注和工具入参不能指定用户或权限。不得调用模型API。"
    : "") });

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
      const scopes = definition.annotations?.readOnlyHint === true
        ? ["workforce:read"] : ["workforce:read", "workforce:write"];
      const securitySchemes = [{ type: "oauth2", scopes }];
      const profile = name === "get_profile";
      const cloudMetadata = { ...definition._meta, securitySchemes };
      if (cloudMetadata.ui?.resourceUri) cloudMetadata.ui = { ...cloudMetadata.ui, resourceUri: uiUri };
      if (cloudMetadata["openai/outputTemplate"]) cloudMetadata["openai/outputTemplate"] = uiUri;
      return register(name, {
        ...definition, securitySchemes,
        _meta: cloudMetadata,
      }, async (...args) => {
        try {
          requirePrincipal(principal, scopes);
          if (["upsert_productivity", "delete_productivity"].includes(name) && !principal.isAdmin) {
            throw Object.assign(new Error("只有管理员可以维护公共工效库"), { statusCode: 403 });
          }
          const result = await handler(...args);
          if (!result.isError && result.structuredContent && !profile) {
            const account = { id: principal.id, displayName: principal.displayName, isAdmin: principal.isAdmin };
            return { ...result, ...toolResult({ ...result.structuredContent, account }) };
          }
          return result;
        } catch (error) {
          const status = Number(error.statusCode ?? error.status);
          return {
            isError: true,
            content: [{ type: "text", text: [400, 401, 403, 404, 409, 413, 429].includes(status)
              ? error.message : "操作未完成，请稍后重试或联系管理员。未使用其他账户的数据。" }],
            ...((status === 401 || error.code === "insufficient_scope") ? { _meta: {
              "mcp/www_authenticate": [oauthChallenge(authConfig, error.code ?? "invalid_token")],
            } } : {}),
          };
        }
      });
    };
  }

  if (!publicMode) {
    server.registerResource(
      "workforce-planner-ui",
      uiUri,
      { title: "工程劳动力测算", description: "劳动力测算、比例设置、测算历史与工效库四个页面", mimeType: WORKFORCE_UI_MIME },
      async () => ({
        contents: [{
          uri: uiUri,
          mimeType: WORKFORCE_UI_MIME,
          text: await buildWorkforceUI({ cloudMode }),
          _meta: cloudMode ? { ...uiResourceMetadata,
            "openai/widgetDescription": "工程劳动力测算公开版：劳动力测算、比例设置、个人测算历史与共享工效库。身份由服务器验证，历史按账号隔离；施工顺序由当前ChatGPT会话判断，无额外模型API。" } : uiResourceMetadata,
        }],
      }),
    );
    server.registerTool(
      "open_workforce_planner",
      {
        title: "打开工程劳动力测算界面",
        description: cloudMode
          ? "用户选择内嵌输入或要求打开界面时调用。在当前聊天打开公开版四页工作台：劳动力测算、比例设置、当前账号独立历史与注册用户可查的公共工效库。普通用户不能修改公共工效。由当前ChatGPT会话判断施工先后，再生成方案；不调用模型API，也不访问私有测试版的数据。"
          : "每轮使用先按服务器说明询问是否使用内嵌版手动输入工程量；用户选择使用或明确要求打开内嵌界面时调用。在当前ChatGPT聊天内打开与原网站共用工效库和测算历史的四页界面。不修改数据、不调用模型API；界面点击测算后，由当前ChatGPT会话读取全项目资料、判断施工顺序，再生成方案。",
        inputSchema: {
          page: z.enum(["planner", "ratios", "history", "library"]).optional().describe("打开的页面，默认劳动力测算"),
        },
        outputSchema: {
          ui: z.object({ page: z.enum(["planner", "ratios", "history", "library"]) }),
          bootstrap: z.object({
            productivity: z.array(z.record(z.string(), z.unknown())),
            history: z.array(z.record(z.string(), z.unknown())),
          }),
          ...(cloudMode ? { account: z.object({ id: z.string(), displayName: z.string(), isAdmin: z.boolean() }) } : {}),
        },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        ...privateUiMetadata(false, { render: true, entrypoints: true }),
      },
      async ({ page = "planner" }) => {
        const [productivity, history] = await Promise.all([productivityStore.list(), historyStore.list()]);
        return toolResult({ ui: { page }, bootstrap: { productivity, history } });
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
      description: "每次生成劳动力方案前调用，读取本次完整工程量、施工部位备注、项目说明和工效工作内容。返回资料和指纹，不代替GPT判断。随后由GPT逐项判断整个项目哪些先做、后做、可并行，逐项填入itemDecisions和依赖依据，形成constructionReview后调用generate_workforce_plan。不能仅按录入编号或工效库排序生成顺序；必要信息不足时标记needs_information并先向用户补问。",
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
        "先调用prepare_project_review，由当前ChatGPT会话结合本次全项目资料判断真实施工逻辑，并传入constructionReview；不额外调用模型API。顺序单班组白班足够时仅提供顺序施工；不足时先尝试单班组白班多工序搭接，仍不足再比较多班组白班多工序搭接，原单班组早晚班和多班组白班顺序方案继续供选择。两种搭接都仅允许parallelGroups已确认的组合，保留技术前置，不把缺少依赖当可并行。增组搭接按工序配置整数班组，每日1个8小时白班，人员分别计入，工作面与机械材料能否容纳反算班组须核实，不能冒称已审批。不恢复旧版均衡穿插或提前穿插。结果含班组人员、人日、实际搭接依据、柱状图与横道图；不可行方案说明原因。输入或工效变化后须重新判断；若界面提供requestId，必须原样传回，不复用旧请求。",
      inputSchema: {
        project: projectSchema,
        workItems: workItemsSchema,
        constructionReview: constructionReviewSchema,
        ...(!publicMode ? { requestId: z.string().min(1).max(120).optional().describe("内嵌界面本次测算请求标识，若提供必须原样传回；不影响施工审查指纹") } : {}),
      },
      annotations: { readOnlyHint: publicMode, destructiveHint: false, openWorldHint: false },
      ...privateUiMetadata(publicMode, { render: true }),
    },
    async (args) => {
      validatePublicInput(args, publicMode || cloudMode);
      const { requestId, ...planningInput } = args;
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
      description:
        "新增或修改工效。同一编码会覆盖当前版本；推荐工效采用标准8小时班组产量。",
      inputSchema: {
        id: z.string().optional(),
        division: z.string().optional().describe("分部工程；未提供时归入其他工程"),
        subitem: z.string().optional().describe("分项工程；未提供时归入未分类分项"),
        category: z.string().min(1).describe("工种类型"),
        name: z.string().min(1).describe("适用分项"),
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
    async (args) => toolResult({ saved: await productivityStore.upsert(args) }),
  );

  server.registerTool(
    "delete_productivity",
    {
      title: "删除工效",
      description: "按编码从当前工效库中删除一条工效。默认库条目会被隐藏，使用相同编码重新保存即可恢复。",
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
      title: "查看当前登录身份", description: "返回服务器验证的当前账号及公共工效维护权限。不接受用户编号入参。",
      inputSchema: {}, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      ...privateUiMetadata(false),
    }, async () => toolResult({ account: { id: principal.id, displayName: principal.displayName, isAdmin: principal.isAdmin } }));
    server.registerTool("get_profile", {
      title: "当前连接账户", description: "返回本次已验证凭证对应的稳定、不透明账户标识；标识不会随登录、令牌刷新或显示名称变化。",
      inputSchema: {}, outputSchema: { id: z.string().min(1), name: z.string() },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      _meta: { "openai/profile": true },
    }, async () => toolResult({ id: principal.id, name: principal.displayName }));
  }

  return server;
}
