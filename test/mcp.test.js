import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/mcp.js";

test("MCP先读取全项目再由GPT判断，合法审查测算后自动入库", async (context) => {
  const calls = [];
  const store = {
    async list() { return []; },
    async find() {
      return {
        id: "sample",
        name: "样例工序",
        category: "钢筋工",
        unit: "t",
        mode: "crew_day",
        output: 1,
        productivityUnit: "t/班组·8h",
        crew: { 钢筋工: 2 },
        source: "测试",
        status: "confirmed",
        workContent: "钢筋绑扎与安装",
      };
    },
    async upsert(input) { calls.push(["upsert", input]); return input; },
    async delete(id) { calls.push(["delete", id]); return { id, name: "测试" }; },
  };
  const historyStore = {
    async add(plan) { calls.push(["history-add", plan]); return { id: "record-1", createdAt: "2026-10-15T00:00:00.000Z" }; },
    async list() { return [{ id: "record-1" }]; },
    async get(id) { return { id, plan: { summary: { totalPersonDays: 2 } } }; },
    async delete(id) { calls.push(["history-delete", id]); return { id }; },
  };
  const server = createMcpServer(store, historyStore);
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  context.after(async () => {
    await client.close();
    await server.close();
  });

  const tools = await client.listTools();
  assert.deepEqual(
    tools.tools.map((tool) => tool.name).sort(),
    ["delete_productivity", "delete_workforce_history", "generate_workforce_plan", "get_workforce_history", "list_productivity", "list_workforce_history", "open_workforce_planner", "prepare_project_review", "upsert_productivity"],
  );
  assert.equal(tools.tools.find((tool) => tool.name === "prepare_project_review").annotations.readOnlyHint, true);
  const input = {
      project: {
        context: "酒店A栋独立钢筋工作面",
        startDate: "2026-10-01",
        endDate: "2026-10-01",
        calendarRules: { winter: { factor: 0.5 } },
      },
      workItems: [{ activityId: "sample", quantity: 1, unit: "t", remark: "先施工此项", divisionRemark: "酒店A栋" }],
  };
  const missingReview = await client.callTool({ name: "generate_workforce_plan", arguments: input });
  assert.equal(missingReview.isError, true);
  assert.deepEqual(calls, [], "缺少GPT判断时不能保存测算历史");
  const preparation = await client.callTool({ name: "prepare_project_review", arguments: input });
  assert.equal(preparation.isError, undefined);
  assert.deepEqual(calls, [], "读取全项目资料不能保存历史或更改工效");
  const reviewContext = preparation.structuredContent;
  assert.equal(reviewContext.project.context, input.project.context);
  assert.equal(reviewContext.workItems[0].itemId, "item-1");
  assert.equal(reviewContext.workItems[0].divisionRemark, "酒店A栋");
  assert.equal(reviewContext.workItems[0].workContent, "钢筋绑扎与安装");
  assert.equal(reviewContext.workItems[0].productivity.output, 1);
  const constructionReview = {
    fingerprint: reviewContext.fingerprint,
    summary: "仅有酒店A栋钢筋工作面，本项可开工，无其他已录入前置",
    reviewedItemIds: ["item-1"], dependencies: [], parallelGroups: [], assumptions: [], questions: [],
    itemDecisions: [{ itemId: "item-1", sequenceStatus: "determined", reason: "项目说明确认酒店A栋独立钢筋工作面已具备施工条件" }],
  };
  const stale = await client.callTool({ name: "generate_workforce_plan", arguments: {
    ...input, workItems: [{ ...input.workItems[0], quantity: 2 }], constructionReview,
  } });
  assert.equal(stale.isError, true);
  assert.match(stale.content[0].text, /已过期/);
  assert.deepEqual(calls, [], "旧判断不能生成新历史");
  const undetermined = await client.callTool({ name: "generate_workforce_plan", arguments: {
    ...input,
    constructionReview: {
      ...constructionReview,
      itemDecisions: [{ itemId: "item-1", sequenceStatus: "needs_information", reason: "需补充A栋钢筋绑扎的施工部位及前期基础完成情况" }],
      questions: ["A栋对应哪层结构，前期基础是否完成？"],
    },
  } });
  assert.equal(undetermined.isError, true);
  assert.match(undetermined.content[0].text, /暂停测算.*project.context/);
  assert.deepEqual(calls, [], "关键顺序条件不足时不能保存看似完整的测算历史");
  const plan = await client.callTool({
    name: "generate_workforce_plan",
    arguments: { ...input, constructionReview },
  });
  assert.equal(plan.structuredContent.history.id, "record-1");
  assert.equal(calls[0][0], "history-add");
  assert.equal(calls[0][1].summary.conservativePeakHeadcount, 4);
  assert.equal(calls[0][1].project.calendarRules.winter.factor, 0.5);
  assert.equal(calls[0][1].workItems[0].sequence, 1);
  assert.equal(calls[0][1].workItems[0].remark, "先施工此项");
  assert.equal(calls[0][1].workItems[0].divisionRemark, "酒店A栋");
  assert.equal(calls[0][1].workflow.mode, "gpt");
  assert.equal(calls[0][1].workflow.fingerprint, reviewContext.fingerprint);
  assert.deepEqual(calls[0][1].planOptions.map(({ id }) => id), ["two-shift", "multi-crew-day"]);
  const twoShift = calls[0][1].planOptions[0];
  assert.equal(twoShift.shiftsPerDay, 2);
  assert.equal(twoShift.hoursPerShift, 8);
  assert.equal(twoShift.workItems[0].requiredCrews, 1);
  assert.equal(twoShift.workItems[0].crewsPerShift, 1);
  assert.equal(twoShift.workItems[0].totalCrewRosters, 2);
  assert.deepEqual(twoShift.workItems[0].crewPerShift, { 钢筋工: 2 });
  assert.deepEqual(twoShift.workItems[0].peakCrew, { 钢筋工: 4 });
  assert.equal(twoShift.summary.peakOnShiftHeadcount, 2);
  assert.equal(calls[0][1].planOptions[0].workItems[0].startDate, "2026-10-01");

  const history = await client.callTool({ name: "list_workforce_history", arguments: {} });
  assert.equal(history.structuredContent.items[0].id, "record-1");
  const detail = await client.callTool({ name: "get_workforce_history", arguments: { id: "record-1" } });
  assert.equal(detail.structuredContent.record.plan.summary.totalPersonDays, 2);
  await client.callTool({ name: "delete_workforce_history", arguments: { id: "record-1" } });

  await client.callTool({
    name: "upsert_productivity",
    arguments: {
      id: "test-crew",
      category: "模板木工",
      name: "测试班组工效",
      unit: "m²",
      crew: { 中籍: 1, 外籍技工: 4, 杂工: 2 },
      crewText: "中籍1 + 外籍技工4 + 杂工2",
      output: 20,
      productivityUnit: "m²/班组·8h",
      workContent: "测试工作内容",
    },
  });
  await client.callTool({ name: "delete_productivity", arguments: { id: "test-crew" } });
  assert.equal(calls[2][0], "upsert");
  assert.deepEqual(calls[2][1].crew, { 中籍: 1, 外籍技工: 4, 杂工: 2 });
  assert.deepEqual(calls[3], ["delete", "test-crew"]);
  assert.deepEqual(calls[1], ["history-delete", "record-1"]);
});
