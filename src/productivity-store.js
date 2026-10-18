import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { productivityData } from "./productivity-data.js";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(currentDir, "../data");
const defaultCustomPath = path.join(dataDir, "custom-productivity.json");
const defaultDeletedPath = path.join(dataDir, "deleted-productivity.json");

async function readJson(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

function normalizedId(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function normalizeRoleName(role) {
  const normalized = String(role ?? "").trim().replaceAll("中方技术员", "中籍");
  return normalized === "外籍" ? "外籍技工" : normalized;
}

function normalizeRoleMap(roleMap = {}) {
  const normalized = {};
  for (const [rawRole, rawValue] of Object.entries(roleMap)) {
    const role = normalizeRoleName(rawRole);
    const value = Number(rawValue);
    if (role && Number.isFinite(value) && value > 0) {
      normalized[role] = (normalized[role] ?? 0) + value;
    }
  }
  return normalized;
}

function normalizeEntry(entry) {
  const crew = normalizeRoleMap(entry.crew);
  return {
    ...entry,
    division: entry.division || "其他工程",
    subitem: entry.subitem || "未分类分项",
    roleProductivity: normalizeRoleMap(entry.roleProductivity),
    crew,
    crewText: entry.crewText || Object.entries(crew).map(([role, count]) => `${role}${count}`).join(" + "),
    productivityUnit: entry.productivityUnit || (entry.unit ? `${entry.unit}/班组·8h` : ""),
    workContent: entry.workContent || entry.notes || "",
  };
}

function validateEntry(entry) {
  const errors = [];
  if (!entry.id) errors.push("缺少工效编码");
  if (!entry.name) errors.push("缺少适用分项");
  if (!entry.category) errors.push("缺少工种类型");
  if (entry.status === "unavailable") {
    if (errors.length) {
      const error = new Error(errors.join("；"));
      error.statusCode = 400;
      throw error;
    }
    return;
  }
  if (!entry.unit) errors.push("缺少工程量单位");
  if (entry.category === "待分类") errors.push("请先确认工种类型再设为可用或待核验");
  if (!["role_productivity", "crew_day", "equipment_hour"].includes(entry.mode)) {
    errors.push("工效模式必须是 role_productivity、crew_day 或 equipment_hour");
  }
  if (entry.mode === "equipment_hour") {
    if (!Number.isFinite(Number(entry.output)) || Number(entry.output) <= 0) {
      errors.push("设备小时产量必须是大于0的数值");
    }
  }
  if (entry.mode === "role_productivity") {
    if (!Object.keys(entry.roleProductivity ?? {}).length) {
      errors.push("人员工效至少需要填写1个工种");
    }
  }
  if (entry.mode === "crew_day") {
    if (!Number.isFinite(Number(entry.output)) || Number(entry.output) <= 0) {
      errors.push("班组日产量必须是大于0的数值");
    }
    if (!Object.keys(entry.crew ?? {}).length) {
      errors.push("班组工效必须至少配置1名人员");
    }
  }
  if (errors.length) {
    const error = new Error(errors.join("；"));
    error.statusCode = 400;
    throw error;
  }
}

export class ProductivityStore {
  constructor({ customPath = defaultCustomPath, deletedPath = defaultDeletedPath } = {}) {
    this.customPath = customPath;
    this.deletedPath = deletedPath;
  }

  async list({ search = "", status = "" } = {}) {
    const [custom, deletedIds] = await Promise.all([
      readJson(this.customPath),
      readJson(this.deletedPath),
    ]);
    const customIds = new Set(custom.map((item) => item.id));
    const deleted = new Set(deletedIds);
    const merged = [
      ...productivityData.filter((item) => !customIds.has(item.id)),
      ...custom,
    ]
      .filter((item) => !deleted.has(item.id))
      .map(normalizeEntry);
    const needle = search.trim().toLowerCase();
    return merged
      .filter((item) => !status || item.status === status)
      .filter(
        (item) =>
          !needle ||
          [
            item.id,
            item.name,
            item.division,
            item.subitem,
            item.category,
            item.unit,
            item.crewText,
            item.productivityUnit,
            item.workContent,
            ...Object.keys(item.roleProductivity ?? {}),
          ]
            .join(" ")
            .toLowerCase()
            .includes(needle),
      );
  }

  async find(id) {
    return (await this.list()).find((item) => item.id === id) ?? null;
  }

  async upsert(input) {
    const existingId = input.id ? normalizedId(input.id) : "";
    const existing = existingId
      ? (await this.find(existingId)) ?? productivityData.find((item) => item.id === existingId)
      : null;
    const mode = input.mode === "equipment_hour"
      ? "equipment_hour"
      : input.mode === "role_productivity"
        ? "role_productivity"
        : "crew_day";
    const productivityUnit = String(input.productivityUnit ?? "").trim();
    const unit = String(input.unit ?? productivityUnit.split("/")[0] ?? "").trim();
    const crew = normalizeRoleMap(input.crew);
    const division = String(input.division ?? existing?.division ?? "其他工程").trim() || "其他工程";
    const subitem = String(input.subitem ?? existing?.subitem ?? "未分类分项").trim() || "未分类分项";
    const name = String(input.name ?? "").trim();
    const entry = {
      id: normalizedId(input.id || `${division}-${subitem}-${name}`),
      division,
      subitem,
      hierarchyOrder: existing?.division === division && existing?.subitem === subitem
        ? existing.hierarchyOrder : undefined,
      category: String(input.category ?? "待分类").trim(),
      name,
      unit,
      mode,
      output: mode === "role_productivity" ? undefined
        : input.output === null || input.output === undefined || input.output === "" ? null : Number(input.output),
      roleProductivity: normalizeRoleMap(input.roleProductivity),
      crew,
      crewText: String(input.crewText || Object.entries(crew).map(([role, count]) => `${role}${count}`).join(" + ")).trim(),
      productivityUnit: productivityUnit || (unit ? `${unit}/班组·8h` : ""),
      workContent: String(input.workContent ?? "").trim(),
      equipment: Array.isArray(input.equipment)
        ? input.equipment.map(String).map((item) => item.trim()).filter(Boolean)
        : [],
      source: String(input.source ?? "后续补充").trim(),
      sourcePriority: 3,
      status: ["confirmed", "needs_validation", "unavailable"].includes(input.status) ? input.status : "confirmed",
      notes: String(input.notes ?? "").trim(),
      updatedAt: new Date().toISOString(),
    };
    validateEntry(entry);

    const [custom, deletedIds] = await Promise.all([
      readJson(this.customPath),
      readJson(this.deletedPath),
    ]);
    const index = custom.findIndex((item) => item.id === entry.id);
    if (index >= 0) custom[index] = entry;
    else custom.push(entry);
    const restoredDeletedIds = deletedIds.filter((id) => id !== entry.id);
    await Promise.all([
      writeFile(this.customPath, `${JSON.stringify(custom, null, 2)}\n`, "utf8"),
      writeFile(this.deletedPath, `${JSON.stringify(restoredDeletedIds, null, 2)}\n`, "utf8"),
    ]);
    return normalizeEntry(entry);
  }

  async delete(id) {
    const normalized = normalizedId(id);
    const existing = await this.find(normalized);
    if (!existing) {
      const error = new Error("未找到要删除的工效条目");
      error.statusCode = 404;
      throw error;
    }
    const [custom, deletedIds] = await Promise.all([
      readJson(this.customPath),
      readJson(this.deletedPath),
    ]);
    const nextCustom = custom.filter((item) => item.id !== normalized);
    const nextDeleted = [...new Set([...deletedIds, normalized])];
    await Promise.all([
      writeFile(this.customPath, `${JSON.stringify(nextCustom, null, 2)}\n`, "utf8"),
      writeFile(this.deletedPath, `${JSON.stringify(nextDeleted, null, 2)}\n`, "utf8"),
    ]);
    return { id: normalized, name: existing.name };
  }
}

export { validateEntry };
