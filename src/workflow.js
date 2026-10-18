const PROCESS_TYPES = new Set(["auto", "other", "rebar", "concrete_cast", "concrete_cure"]);

function invalid(message) {
  const error = new Error(message);
  error.statusCode = 400;
  throw error;
}

function inferredType(entry) {
  const { name = "", category = "" } = entry.result;
  const content = entry.definition?.workContent ?? "";
  if (/预制|工厂浇筑/.test(name) && !/现浇/.test(name)) return "other";
  if ((category === "混凝土工" || /混凝土|砼/.test(name)) && /养护/.test(name)) return "concrete_cure";
  if ((category === "混凝土工" || /混凝土|砼/.test(name)) && /浇筑|浇注/.test(name)) return "concrete_cast";
  if (category === "混凝土工" && /浇筑|浇注/.test(content) && !/养护/.test(content)) return "concrete_cast";
  if (category === "钢筋工" && /绑扎|安装/.test(name)) return "rebar";
  return "other";
}

export function prepareWorkflow(prepared) {
  const warnings = [];
  const checks = [];
  const rebars = [];
  const casts = [];
  const cures = [];

  for (const entry of prepared) {
    const result = entry.result;
    const requested = result.processType || "auto";
    if (!PROCESS_TYPES.has(requested)) invalid(`第${result.sequence}项工序性质无效`);
    result.processType = requested === "auto" ? inferredType(entry) : requested;
    result.dependsOnSequences = [];

    const content = entry.definition?.workContent ?? "";
    if (/(?:混凝土|砼).*(?:浇筑|浇注)/.test(content) && /养护/.test(content)) {
      warnings.push(`第${result.sequence}项“${result.name}”把混凝土浇筑与养护合并在一条工效内，无法单独核对养护工作量及开始时间；建议拆分。`);
    }
    if (result.processType === "rebar") rebars.push(entry);
    if (result.processType === "concrete_cast") casts.push(entry);
    if (result.processType === "concrete_cure") cures.push(entry);
  }

  const usableRebars = rebars.filter((entry) => entry.definition);
  const usableCasts = casts.filter((entry) => entry.definition);
  const usableCures = cures.filter((entry) => entry.definition);

  // Match within a division when possible. If none exists, fall back to the
  // project-wide aggregate sequence; component-level links remain unknown.
  for (const cast of usableCasts) {
    const sameDivision = usableRebars.filter((rebar) => rebar.result.divisionId === cast.result.divisionId);
    for (const rebar of sameDivision.length ? sameDivision : usableRebars) {
      cast.result.dependsOnSequences.push(rebar.result.sequence);
      checks.push(`第${rebar.result.sequence}项钢筋绑扎完成后，才开始第${cast.result.sequence}项混凝土浇筑`);
    }
  }
  for (const cure of usableCures) {
    const sameDivision = usableCasts.filter((cast) => cast.result.divisionId === cure.result.divisionId);
    for (const cast of sameDivision.length ? sameDivision : usableCasts) {
      cure.result.dependsOnSequences.push(cast.result.sequence);
      checks.push(`第${cast.result.sequence}项混凝土浇筑完成后，才开始第${cure.result.sequence}项养护`);
    }
  }

  if (casts.length && !cures.length) {
    warnings.push("已录入现浇混凝土浇筑，但未录入养护工程量；本次方案不含养护劳动力与时间，请补充后重新测算。");
  }
  if (cures.length && !casts.length) {
    warnings.push("已录入养护，但未录入对应浇筑；无法核对养护的开始条件。");
  }
  if (rebars.some((entry) => !entry.definition) && casts.length) {
    warnings.push("部分钢筋工序缺少可用工效，未纳入排程；请补齐后复核浇筑开始时间。");
  }
  if (casts.some((entry) => !entry.definition) && cures.length) {
    warnings.push("部分混凝土浇筑工序缺少可用工效，未纳入排程；请补齐后复核养护开始时间。");
  }
  if (usableRebars.length && usableCasts.length) warnings.push("未录入构件对应关系，暂优先按同分部钢筋完成后浇筑；同分部缺少钢筋时回退到全项目钢筋汇总顺序。分区流水、隐蔽验收须人工复核。");
  if (usableCasts.length > 1 || usableCures.length > 1) warnings.push("存在多项浇筑或养护，暂优先按同分部浇筑完成后养护；该汇总假设不能替代分部位及时养护计划。");
  const orderAdjusted = usableCasts.some((cast) => usableRebars.some((rebar) => rebar.result.sequence > cast.result.sequence))
    || usableCures.some((cure) => usableCasts.some((cast) => cast.result.sequence > cure.result.sequence));
  if (orderAdjusted) {
    warnings.push("录入顺序不作为技术前后置校验；已在测算结果和横道图中按钢筋、浇筑、养护顺序重新排列。");
  }

  return { checks, warnings };
}
