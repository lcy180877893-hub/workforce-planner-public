import test from "node:test";
import assert from "node:assert/strict";
import { loadUIRenderer, buildPreviewPlan, buildResourcePreviewHtml } from "./fixtures/resource-preview.mjs";

test("资源方案 UI 分别展示单班与早晚两套人员、全日峰值及8小时人日", async () => {
  const [renderer, plan] = await Promise.all([loadUIRenderer(), buildPreviewPlan()]);
  const original = JSON.stringify(plan);
  const twoShift = plan.planOptions.find((item) => item.id === "two-shift");
  assert.ok(twoShift);
  const html = renderer.render({ ...plan, selectedOptionId: twoShift.id });
  assert.match(html, /1 组\/班 × 2 班\/日/);
  assert.match(html, /每班 中籍×1、外籍技工×4、杂工×5；早晚两班合计 中籍×2、外籍技工×8、杂工×10（两套人员）/);
  assert.match(html, /单班在岗峰值/);
  assert.match(html, /全日配备峰值（各班合计）/);
  assert.match(html, /总人日（8小时\/人日）/);
  assert.match(html, /2 班\/日 · 每班 8 小时/);
  assert.match(html, /不因两班作业减半/);
  assert.match(html, /施工横道图 · 单班组早晚班/);
  assert.equal(JSON.stringify(plan), original);
});

test("工期不足 UI 显示真实基准超期及未提供方案原因", async () => {
  const [renderer, plan] = await Promise.all([loadUIRenderer(), buildPreviewPlan()]);
  const html = renderer.render(plan);
  assert.match(html, /工期不足/);
  assert.match(html, /顺序单白班预计需 18 天/);
  assert.match(html, /预计完工 2026-10-18/);
  assert.match(html, /超出 8 天/);
  assert.match(html, /未提供的方案/);
  assert.match(html, /多班组白班/);
  const multi = plan.planOptions.find((item) => item.id === "multi-crew-day");
  assert.ok(multi);
  const multiHtml = renderer.render({ ...plan, selectedOptionId: multi.id });
  assert.match(multiHtml, /施工横道图 · 多班组白班/);
  assert.match(multiHtml, /1 班\/日 · 每班 8 小时/);
  assert.doesNotMatch(multiHtml, /；早晚两班合计/);
});

test("工期足够仅显示顺序单白班选项且无旧策略标识", async () => {
  const [renderer, plan] = await Promise.all([loadUIRenderer(), buildPreviewPlan("2026-10-31")]);
  assert.deepEqual(plan.planOptions.map((option) => option.id), ["sequential"]);
  const html = renderer.render(plan);
  assert.match(html, /工期足够/);
  assert.match(html, /施工横道图 · 顺序施工/);
  assert.doesNotMatch(html, /data-option-id="(?:two-shift|multi-crew-day|balanced|early-overlap)"/);
  assert.doesNotMatch(html, /（旧版历史）/);
});

test("工效待补充时工期结论只针对已计入部分，远期基准空值不显示虚构0天", async () => {
  const [renderer, plan] = await Promise.all([loadUIRenderer(), buildPreviewPlan("2026-10-31")]);
  const partial = { ...plan, missingProductivity: [{ name: "未知工序" }], baselineAssessment: { ...plan.baselineAssessment, isComplete: false, missingItems: 1 } };
  assert.match(renderer.render(partial), /已计入部分可满足/);
  assert.doesNotMatch(renderer.render(partial), />工期足够</);
  partial.baselineAssessment = { feasible: false, requiredCalendarDays: null, finishDate: null, availableCalendarDays: 31, overrunDays: null, reason: "超出预测范围", isComplete: false, missingItems: 1 };
  const html = renderer.render(partial);
  assert.match(html, /已计入部分不足/);
  assert.match(html, /超出预测范围/);
  assert.doesNotMatch(html, /预计需 0 天/);
});

test("降排水设备不追加劳动班次；旧版穿插记录保留原始数据与历史标识", async () => {
  const [renderer, plan] = await Promise.all([loadUIRenderer(), buildPreviewPlan()]);
  const current = plan.planOptions[0];
  assert.equal(renderer.staffing({ requiredEquipment: { 水泵: 2 }, peakCrew: { 电工: 1 } }, current), "水泵×2");
  const legacy = { ...current, id: "balanced", name: "均衡穿插", staffingMode: undefined, shiftsPerDay: undefined, workItems: current.workItems.map((item) => ({ ...item, requiredCrews: 1, peakCrew: { 钢筋工: 20 }, crewPerShift: undefined, shiftsPerDay: undefined })) };
  const legacyPlan = { ...plan, baselineAssessment: undefined, selectedOptionId: "balanced", planOptions: [legacy], unavailableOptions: [] };
  const original = JSON.stringify(legacyPlan);
  const html = renderer.render(legacyPlan);
  assert.match(html, /均衡穿插（旧版历史）/);
  assert.match(html, /1 个班组 · 钢筋工×20/);
  assert.doesNotMatch(html, /工期判断 · 顺序施工/);
  assert.doesNotMatch(html, /全日配备峰值（各班合计）/);
  assert.equal(JSON.stringify(legacyPlan), original);
});

test("基准与方案原因进行 HTML 转义，隔离预览只内嵌实际渲染逻辑而不启动API", async () => {
  const [renderer, plan] = await Promise.all([loadUIRenderer(), buildPreviewPlan()]);
  const html = renderer.render({ ...plan, baselineAssessment: { ...plan.baselineAssessment, reason: '<img src=x onerror="alert(1)">' }, unavailableOptions: [{ name: "测试", reason: "<script>bad()</script>" }] });
  assert.match(html, /&lt;img/);
  assert.match(html, /&lt;script&gt;bad\(\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<img src=x/);
  const preview = await buildResourcePreviewHtml();
  assert.match(preview, /仅使用内存工效、项目和审查/);
  assert.match(preview, /function planMarkup\(plan\)/);
  assert.match(preview, /choosePlanOption\(container, resourcePreviewPlans\[key\]/);
  assert.doesNotMatch(preview, /await refreshProductivity\(\)/);
  assert.doesNotMatch(preview, /<script[^>]+src=/);
});

test("单班组白班多工序搭接按每道工序各1组显示，并保留实际搭接依据及原记录", async () => {
  const [renderer, sourcePlan] = await Promise.all([loadUIRenderer(), buildPreviewPlan("2026-10-31")]);
  const sourceOption = sourcePlan.planOptions[0];
  const dates = [
    { startDay: 0, endDay: 2, startDate: "2026-10-01", endDate: "2026-10-03", durationDays: 3 },
    { startDay: 3, endDay: 3, startDate: "2026-10-04", endDate: "2026-10-04", durationDays: 1 },
    { startDay: 0, endDay: 3, startDate: "2026-10-01", endDate: "2026-10-04", durationDays: 4 },
  ];
  const workItems = sourceOption.workItems.map((item, index) => ({ ...item, ...dates[index],
    requiredCrews: 1, crewsPerShift: 1, shiftsPerDay: 1, lastDayShifts: 1,
    peakCrew: item.crewPerShift,
  }));
  const option = { ...sourceOption, id: "single-crew-day-overlap", name: "单班组白班多工序搭接",
    staffingMode: "single-crew-day-overlap", shiftsPerDay: 1, hoursPerShift: 8,
    finishDate: "2026-10-04", workItems,
    overlapBasis: [{ itemIds: [workItems[0].itemId, workItems[2].itemId], reason: '独立工作面已确认 <script>不能执行</script>' }],
  };
  const plan = { ...sourcePlan, selectedOptionId: option.id, planOptions: [option],
    workflow: { ...sourcePlan.workflow,
      dependencies: sourcePlan.workflow.dependencies.slice(0, 1),
      parallelGroups: [{ itemIds: [workItems[0].itemId, workItems[2].itemId], reason: "不同工作面具备条件" }],
    },
  };
  const before = JSON.stringify(plan);
  const html = renderer.render(plan);
  assert.match(html, /data-option-id="single-crew-day-overlap"/);
  assert.match(html, /施工横道图 · 单班组白班多工序搭接/);
  assert.match(html, /1 组\/班 × 1 班\/日/);
  assert.match(html, /1 班\/日 · 每班 8 小时/);
  assert.match(html, /每道工序各配 1 个独立白班班组/);
  assert.match(html, /同时施工时各工序人员相加/);
  assert.match(html, /实际搭接工序与依据/);
  assert.match(html, /独立工作面已确认 &lt;script&gt;不能执行&lt;\/script&gt;/);
  assert.match(html, /1\.1\.1 · 钢筋绑扎\/安装〔酒店A栋〕、2\.1\.1 · 砌体施工〔酒店A栋〕/);
  assert.match(html, /仅在确认具备条件时允许并行/);
  assert.doesNotMatch(html, /各方案保留相同施工顺序|；早晚两班合计|单班组白班多工序搭接（旧版历史）|<script>/);
  assert.deepEqual([...html.matchAll(/data-headcount="([\d.]+)"/g)].map((match) => Number(match[1])), [15, 15, 15, 11]);
  assert.equal(JSON.stringify(plan), before);
});

test("搭接依据最多展示200组并明确实际总数，旧大记录只截展示不改写", async () => {
  const [renderer, sourcePlan] = await Promise.all([loadUIRenderer(), buildPreviewPlan("2026-10-31")]);
  const sourceOption = sourcePlan.planOptions[0];
  const savedBasis = Array.from({ length: 210 }, (_, index) => ({ itemIds: sourceOption.workItems.slice(0, 2).map((item) => item.itemId), reason: `仅供展示测试第${index + 1}组` }));
  for (const id of ["single-crew-day-overlap", "multi-crew-day-overlap"]) {
    for (const metadata of [
      { overlapBasis: savedBasis.slice(0, 200), overlapBasisTotal: 124750, overlapBasisTruncated: true },
      { overlapBasis: savedBasis },
    ]) {
      const option = { ...sourceOption, id, name: id === "single-crew-day-overlap" ? "单班组白班多工序搭接" : "多班组白班多工序搭接", staffingMode: id, ...metadata };
      const plan = { ...sourcePlan, selectedOptionId: option.id, planOptions: [option] };
      const before = JSON.stringify(plan);
      const html = renderer.render(plan);
      const section = html.match(/<section class="result-card overlap-basis">[\s\S]*?<\/section>/)?.[0];
      assert.ok(section);
      assert.equal([...section.matchAll(/<li>/g)].length, 200);
      assert.match(section, new RegExp(`仅列前 200 组，实际共 ${metadata.overlapBasisTotal ? "124,750" : "210"} 组`));
      assert.match(section, /完整允许搭接依据及日期见施工逻辑判断与横道图/);
      assert.match(section, /仅供展示测试第200组/);
      assert.doesNotMatch(section, /仅供展示测试第201组/);
      assert.equal(JSON.stringify(plan), before);
    }
  }
});

test("多班组白班搭接按实际每班班组数与完整人员展示，同工种并行不重复倍乘", async () => {
  const [renderer, sourcePlan] = await Promise.all([loadUIRenderer(), buildPreviewPlan("2026-10-31")]);
  const sourceOption = sourcePlan.planOptions[0];
  const details = [
    { startDay: 0, endDay: 2, startDate: "2026-10-01", endDate: "2026-10-03", durationDays: 3, crewsPerShift: 3, crewPerShift: { 钢筋工: 12 } },
    { startDay: 3, endDay: 3, startDate: "2026-10-04", endDate: "2026-10-04", durationDays: 1, crewsPerShift: 2, crewPerShift: { 混凝土工: 8 } },
    { startDay: 1, endDay: 3, startDate: "2026-10-02", endDate: "2026-10-04", durationDays: 3, crewsPerShift: 2, crewPerShift: { 钢筋工: 6 } },
  ];
  const workItems = sourceOption.workItems.map((item, index) => ({ ...item, ...details[index],
    requiredCrews: details[index].crewsPerShift, peakCrew: details[index].crewPerShift, shiftsPerDay: 1, lastDayShifts: 1,
  }));
  const option = { ...sourceOption, id: "multi-crew-day-overlap", name: "多班组白班多工序搭接",
    shiftsPerDay: 1, hoursPerShift: 8, finishDate: "2026-10-04", workItems,
    overlapBasis: [{ itemIds: [workItems[0].itemId, workItems[2].itemId], reason: "独立施工区域，机械供应可满足 <b>待核对</b>" }],
  };
  // The ID also recognizes saved resource records without a staffingMode field.
  delete option.staffingMode;
  const plan = { ...sourcePlan, selectedOptionId: option.id, planOptions: [option] };
  const before = JSON.stringify(plan);
  const html = renderer.render(plan);
  assert.match(html, /data-option-id="multi-crew-day-overlap"/);
  assert.match(html, /施工横道图 · 多班组白班多工序搭接/);
  assert.match(html, /3 组\/班 × 1 班\/日 · 每班 钢筋工×12/);
  assert.match(html, /2 组\/班 × 1 班\/日 · 每班 钢筋工×6/);
  assert.match(html, /每道工序按明细所列整数个独立白班班组配置，每日仅 1 班/);
  assert.match(html, /多个班组为多套完整人员；同时施工时各工序人员相加/);
  assert.match(html, /足够独立工作面和机械供应能力/);
  assert.match(html, /工效按班组数线性估算/);
  assert.match(html, /不代表现场组织或工程审批已通过/);
  assert.match(html, /实际搭接工序与依据/);
  assert.match(html, /机械供应可满足 &lt;b&gt;待核对&lt;\/b&gt;/);
  assert.doesNotMatch(html, /每道工序各配 1 个独立白班班组|；早晚两班合计|多班组白班多工序搭接（旧版历史）|<b>待核对<\/b>/);
  assert.deepEqual([...html.matchAll(/data-headcount="([\d.]+)"/g)].map((match) => Number(match[1])), [12, 18, 18, 14]);
  assert.equal(renderer.staffing(workItems[0], option, true), "3 组/班 × 1 班/日 · 全日配备 钢筋工×12");
  assert.equal(JSON.stringify(plan), before);
});
