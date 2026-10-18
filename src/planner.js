import { calculateCalendar, enumerateCalendarDays } from "../public/calendar.js";
import { buildScheduleOptions } from "./scheduler.js";
import { prepareWorkflow } from "./workflow.js";
import { applyProjectReview, buildProjectReviewContext, snapshotProductivityStore } from "./project-review.js";

export { calculateCalendar };

function positiveNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    const error = new Error(`${label}必须是大于0的数值`);
    error.statusCode = 400;
    throw error;
  }
  return number;
}

function missingResult(item, reason, sequence, status = "missing_productivity", definition = null) {
  return {
    sequence,
    itemId: String(item.itemId || `item-${sequence}`),
    activityId: item.activityId ?? null,
    name: definition?.name || item.name || "未命名工序",
    category: definition?.category || "",
    division: definition?.division || item.division || "其他工程",
    subitem: definition?.subitem || item.subitem || "未分类分项",
    remark: String(item.remark ?? "").trim(),
    divisionRemark: String(item.divisionRemark ?? "").trim(),
    processType: item.processType ?? "auto",
    quantity: Number(item.quantity || 0),
    unit: item.unit || "",
    status,
    reason,
  };
}

function scheduleDefinition(definition) {
  if (definition.mode === "equipment_hour") {
    const output = positiveNumber(definition.output, `${definition.name}设备工效`);
    return { ...definition, output, baseOutput: output * 10 };
  }
  if (definition.mode === "role_productivity") {
    const rates = Object.values(definition.roleProductivity ?? {}).map((rate) =>
      positiveNumber(rate, `${definition.name}人员工效`),
    );
    if (!rates.length) {
      const error = new Error(`${definition.name}缺少人员工效`);
      error.statusCode = 400;
      throw error;
    }
    return { ...definition, baseOutput: Math.min(...rates) };
  }
  const output = positiveNumber(definition.output, `${definition.name}班组工效`);
  if (!Object.keys(definition.crew ?? {}).length) {
    const error = new Error(`${definition.name}缺少班组人员配置`);
    error.statusCode = 400;
    throw error;
  }
  return { ...definition, output, baseOutput: output };
}

export async function generateWorkforcePlan(input, productivityStore) {
  productivityStore = snapshotProductivityStore(productivityStore);
  const project = input.project ?? {};
  const calendar = calculateCalendar(project);
  const days = enumerateCalendarDays(project);
  const items = Array.isArray(input.workItems) ? input.workItems : [];
  if (!items.length) {
    const error = new Error("请至少录入一项工程量");
    error.statusCode = 400;
    throw error;
  }

  const prepared = [];
  const missing = [];
  let hasDewatering = false;
  for (const [index, item] of items.entries()) {
    const sequence = index + 1;
    const quantity = positiveNumber(item.quantity, `${item.name || item.activityId || "工序"}工程量`);
    const definition = item.activityId ? await productivityStore.find(item.activityId) : null;
    let result;
    if (!definition) {
      result = missingResult(item, "工效库中没有匹配条目，请后续补充工效", sequence);
    } else if (definition.status !== "confirmed") {
      const label = definition.status === "unavailable" ? "不可用" : "待核验";
      result = missingResult(item, `工效条目状态为“${label}”：${definition.notes || "请确认单位和数值"}`, sequence, "missing_productivity", definition);
    } else if (item.unit && item.unit !== definition.unit) {
      result = missingResult(item, `单位不一致：工程量使用“${item.unit}”，工效使用“${definition.unit}”`, sequence, "unit_mismatch", definition);
    }
    if (result) {
      missing.push(result);
      prepared.push({ result, definition: null });
      continue;
    }

    const schedulable = scheduleDefinition(definition);
    if (definition.category === "降排水" && definition.mode === "equipment_hour") hasDewatering = true;
    const productivity = definition.mode === "equipment_hour"
      ? `${definition.output}${definition.unit}/小时·台`
      : definition.mode === "role_productivity"
        ? Object.entries(definition.roleProductivity).map(([role, rate]) => `${role} ${rate}${definition.unit}/人日`).join("；")
        : `${definition.output}${definition.productivityUnit || `${definition.unit}/班组·8h`}`;
    prepared.push({
      definition: schedulable,
      result: {
        sequence,
        itemId: String(item.itemId || `item-${sequence}`),
        activityId: definition.id,
        name: definition.name,
        division: definition.division || item.division || "其他工程",
        subitem: definition.subitem || item.subitem || "未分类分项",
        remark: String(item.remark ?? "").trim(),
        divisionRemark: String(item.divisionRemark ?? "").trim(),
        processType: item.processType ?? "auto",
        category: definition.category,
        quantity,
        unit: definition.unit,
        mode: definition.mode,
        status: "calculated",
        productivity,
        equipment: definition.equipment ?? [],
        source: definition.source,
      },
    });
  }

  const divisionNumbers = new Map();
  const divisionNames = new Map();
  const divisionRemarks = new Map();
  const subitemNumbers = new Map();
  const subitemNames = new Map();
  const activityNumbers = new Map();
  for (const entry of prepared) {
    const { result } = entry;
    const source = items[result.sequence - 1];
    if (result.divisionRemark.length > 200) {
      const error = new Error("分部备注最多200字");
      error.statusCode = 400;
      throw error;
    }
    result.divisionId = String(source.divisionId || `name:${result.division}${result.divisionRemark ? `\u0000${result.divisionRemark}` : ""}`);
    result.subitemId = String(source.subitemId || `${result.divisionId}\u0000${result.subitem}`);
    if (divisionNames.has(result.divisionId) && divisionNames.get(result.divisionId) !== result.division) {
      const error = new Error(`同一分部序号不能对应不同名称：${result.divisionId}`);
      error.statusCode = 400;
      throw error;
    }
    divisionNames.set(result.divisionId, result.division);
    if (divisionRemarks.has(result.divisionId) && divisionRemarks.get(result.divisionId) !== result.divisionRemark) {
      const error = new Error(`同一分部序号不能填写不同施工部位备注：${result.divisionId}`);
      error.statusCode = 400;
      throw error;
    }
    divisionRemarks.set(result.divisionId, result.divisionRemark);
    if (!divisionNumbers.has(result.divisionId)) divisionNumbers.set(result.divisionId, divisionNumbers.size + 1);
    if (subitemNames.has(result.subitemId) && subitemNames.get(result.subitemId) !== `${result.divisionId}\u0000${result.subitem}`) {
      const error = new Error(`同一分项序号不能对应不同分部或名称：${result.subitemId}`);
      error.statusCode = 400;
      throw error;
    }
    subitemNames.set(result.subitemId, `${result.divisionId}\u0000${result.subitem}`);
    if (!subitemNumbers.has(result.subitemId)) {
      const withinDivision = [...prepared.slice(0, result.sequence - 1)]
        .filter((previous) => previous.result.divisionId === result.divisionId)
        .map((previous) => previous.result.subitemId);
      subitemNumbers.set(result.subitemId, new Set(withinDivision).size + 1);
    }
    activityNumbers.set(result.subitemId, (activityNumbers.get(result.subitemId) ?? 0) + 1);
    result.divisionSequence = divisionNumbers.get(result.divisionId);
    result.subitemSequence = subitemNumbers.get(result.subitemId);
    result.activitySequence = activityNumbers.get(result.subitemId);
    result.hierarchyNumber = `${result.divisionSequence}.${result.subitemSequence}.${result.activitySequence}`;
  }

  const constraints = new Map();
  const resolveDivisionId = (id, name) => {
    if (id) return String(id);
    const matches = [...divisionNames].filter(([, value]) => value === name);
    if (matches.length !== 1) return "";
    return matches[0][0];
  };
  for (const item of input.divisionConstraints ?? []) {
    if (item?.waitForCompletion === false) continue;
    const divisionId = resolveDivisionId(item?.divisionId, item?.division);
    const afterDivisionId = resolveDivisionId(item?.afterDivisionId, item?.afterDivision);
    if (!afterDivisionId && !item?.afterDivision && !item?.afterDivisionId) continue;
    if (!divisionNumbers.has(divisionId) || !divisionNumbers.has(afterDivisionId) || divisionId === afterDivisionId) {
      const error = new Error("分部限制无效：请选择另一条已录入的分部序号");
      error.statusCode = 400;
      throw error;
    }
    const afterSubitemId = item.afterSubitemId ? String(item.afterSubitemId) : null;
    const afterItemId = item.afterItemId ? String(item.afterItemId) : null;
    if (afterSubitemId && !prepared.some((entry) => entry.result.divisionId === afterDivisionId && entry.result.subitemId === afterSubitemId)) {
      const error = new Error("分部限制无效：所选分项不属于目标分部");
      error.statusCode = 400;
      throw error;
    }
    if (afterItemId && (!afterSubitemId || prepared.filter((entry) => entry.result.divisionId === afterDivisionId
      && entry.result.subitemId === afterSubitemId && entry.result.itemId === afterItemId).length !== 1)) {
      const error = new Error("分部限制无效：所选工序不属于目标分项或工序序号不唯一");
      error.statusCode = 400;
      throw error;
    }
    if (constraints.has(divisionId)) {
      const error = new Error(`分部 ${divisionNumbers.get(divisionId)} 只能设置一条完成后施工限制`);
      error.statusCode = 400;
      throw error;
    }
    const target = prepared.find((entry) => entry.result.divisionId === afterDivisionId
      && (!afterSubitemId || entry.result.subitemId === afterSubitemId)
      && (!afterItemId || entry.result.itemId === afterItemId)).result;
    const afterLabel = afterItemId
      ? `${target.hierarchyNumber} · ${target.name}`
      : afterSubitemId
        ? `${target.divisionSequence}.${target.subitemSequence} · ${target.subitem}`
        : `${target.divisionSequence} · ${target.division}`;
    constraints.set(divisionId, { afterDivisionId, afterSubitemId, afterItemId, afterLabel });
  }

  const workflow = input.constructionReview
    ? applyProjectReview(prepared, input.constructionReview, (await buildProjectReviewContext(input, productivityStore)).fingerprint)
    : { mode: "rules", ...prepareWorkflow(prepared) };
  const preciseEffectiveDays = days.reduce((sum, day) => sum + day.factor, 0);
  const { options: planOptions, unavailable: unavailableOptions, baselineAssessment } = buildScheduleOptions(prepared, days, preciseEffectiveDays, constraints, {
    allowInterleaved: workflow.mode === "gpt", project,
    parallelGroups: workflow.mode === "gpt" ? workflow.parallelGroups : [],
  });
  const selected = planOptions[0];
  const warnings = [
    "先按每道工序1个白班班组、分部顺序和技术前置检查工期；满足时仅提供顺序施工。不足时先尝试单班组白班多工序搭接，仍不足再反算多班组白班多工序搭接，并保留单班组早晚班和多班组白班顺序方案供比较；不恢复旧版均衡穿插或提前穿插策略。",
    "所有方案保留已确认的技术前置，后继最早次日开工；跨分部必须配合的结构与机电等工作按实际工序前置执行。新增搭接方案只对GPT已判断具备独立工作面、人员和资源条件的工序安排搭接，不以缺少依赖自动认定可同时施工。单班组指每道工序，不代表全项目共用一支班组。",
    workflow.mode === "gpt" ? "本次先由GPT结合全项目工程量、备注和项目说明判断施工逻辑，再进行逐日测算；判断依据和待确认事项随方案保存。" : "本次只采用内置规则，未进行GPT全项目施工逻辑判断。",
    "养护仅按录入工程量和工效估算，不再附加固定最短天数；实际养护及后续加载条件应按设计、合同和现场技术要求确定。",
    "每个劳动班次按现有8小时工效和完整班次计人日；早晚班为两套人员，不将同一人员按16小时连续工作计算。完成后的晚班和工期余量不再计人日。",
    ...(planOptions.some((option) => option.id === "single-crew-day-overlap") ? ["单班组白班多工序搭接：每道工序仅1个8小时白班班组，不增加该工序工效；同时作业的工序分别配齐人员，即使工种相同也按不同班组相加，不重复占用同一套人员。共用机械及工作面须满足已确认的搭接条件；此为保守排程，不保证最短工期或全局最优。"] : []),
    ...(planOptions.some((option) => option.id === "multi-crew-day-overlap") ? ["多班组白班多工序搭接仅在每道工序1个白班班组搭接仍超期后启用：保持原搭接许可和真实技术前置，按工序增加整数白班班组，每日仍1班、每班8小时，各班组分别配齐人员。产能暂按班组数线性相加估算，需核实工作面能容纳所需班组、机械材料配套及安全交接条件；已有单班组搭接许可不代表任意增组均获批准。此为可行性启发式估算，不保证最优或已通过工程审批。"] : []),
    ...(planOptions.some((option) => option.id === "two-shift") ? ["早晚班暂采用相同的标准班组工效及当日冬夏季或斋月比例，未擅自添加夜班折减。实际夜间作业许可、照明、交接、工法及管理覆盖须另行核对。"] : []),
    ...(planOptions.some((option) => option.id === "multi-crew-day") ? ["多班组白班按工序分别配置整数班组或设备并寻找可行资源组合；暂按工作面可容纳且产能可相加估算，实际工作面、机械配套和人员共享限制需校核。此算法不保证数学全局最优。"] : []),
    ...workflow.warnings,
    ...unavailableOptions.map((option) => `${option.name}未提供：${option.reason}`),
  ];
  if (calendar.calendarRules.ramadan.mode === "auto") {
    warnings.push("斋月日期按沙特乌姆古拉历自动识别；实施计划应以项目所在地官方公告校准可能的一日差异。");
  }
  if (missing.length) warnings.unshift(`有${missing.length}项缺少或无法使用工效，未计入排程及劳动力合计。`);
  if (hasDewatering) warnings.push("同一天运行的所有降排水泵合计配置1名电工，未按泵数重复配置。");
  if (planOptions.some((option) => option.divisionSchedule.some((group, index) => group.divisionSequence !== index + 1))) {
    warnings.push("已依据本次技术前置调整实际施工顺序，录入编号仅用于对照工程量；请核对横道图。");
  }

  return {
    project: { name: String(project.name || "未命名项目"), context: String(project.context || "").trim(), ...calendar },
    selectedOptionId: selected.id,
    baselineAssessment,
    summary: selected.summary,
    workItems: selected.workItems,
    divisionSchedule: selected.divisionSchedule,
    planOptions,
    unavailableOptions,
    missingProductivity: missing,
    workflow,
    warnings,
    calculationAssumptions: {
      equipmentOperatingHoursPerDay: 10,
      successorStartsNextDay: true,
      staffingPolicyVersion: "resource-escalation-v3",
      hoursPerLaborShift: 8,
      earlyLateShiftSeparateRosters: true,
      lateShiftProductivityFactor: 1,
      scenarioStartThresholds: null,
      schedulingPolicy: "工期足够时仅提供顺序单白班；不足时先尝试每道工序各1组的白班多工序搭接，仍不足再增加整数白班班组搭接；原早晚班及多班组白班顺序方案继续供比较。搭接仅限GPT明确判断允许的组合，每日1个8小时白班，各班组人员独立配置，增组产能及容纳条件需核实。所有方案均保留技术前置及显式等待限制，前置完成后次日才开工。",
    },
  };
}
