import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { productivityData } from "./productivity-data.js";
import { validateEntry } from "./productivity-store.js";

export const PUBLIC_STORE_LIMITS = Object.freeze({
  planBytes: 1024 * 1024,
  historyPerUser: 100,
  historyTotal: 500,
  savesPerUserPerDay: 20,
  productivityBytes: 32 * 1024,
  productivityEntries: 500,
  personalProductivityTotal: 5000,
});

function failure(message, statusCode) {
  return Object.assign(new Error(message), { statusCode });
}

function requiredText(value, label, max = 200) {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw failure(`${label}缺失或格式不正确`, 400);
  }
  return value;
}

function jsonPayload(value, limit, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw failure(`${label}必须为对象`, 400);
  }
  let serialized;
  try { serialized = JSON.stringify(value); } catch {
    throw failure(`${label}不是有效 JSON`, 400);
  }
  if (Buffer.byteLength(serialized, "utf8") > limit) {
    throw failure(`${label}超过公开免费版存储大小限制`, 413);
  }
  return serialized;
}

async function transaction(pool, operation, lockId) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // pg transactions must retain this same checked-out client throughout.
    if (lockId) await client.query("SELECT pg_advisory_xact_lock($1)", [lockId]);
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    if (error.code === "23514") throw failure("保存内容超出字段或大小限制", 400);
    throw error;
  } finally {
    client.release();
  }
}

function historyRecord(row) {
  if (!row) return null;
  return {
    id: row.id,
    createdAt: new Date(row.created_at).toISOString(),
    ...(row.request_id ? { requestId: row.request_id, requestInputHash: row.request_input_hash } : {}),
    plan: row.plan,
  };
}

function notFound() { return failure("未找到这条测算历史记录", 404); }
function conflict() { return failure("此测算请求标识已用于其他工程量或施工审查，请重新发起测算", 409); }

export class PostgresHistoryStore {
  #pool;
  #userId;
  #limits;

  // userId is supplied ONLY by the server after issuer/sub verification.
  // No plan, query string, tool argument or JSON owner field may select it.
  constructor(pool, userId, { limits = {} } = {}) {
    this.#pool = pool;
    this.#userId = requiredText(userId, "已验证用户标识");
    // Trusted deployment configuration only; never spread request JSON here.
    this.#limits = { ...PUBLIC_STORE_LIMITS };
    for (const key of ["planBytes", "historyPerUser", "historyTotal", "savesPerUserPerDay"]) {
      if (limits[key] === undefined) continue;
      if (!Number.isSafeInteger(limits[key]) || limits[key] < 1
        || (key === "planBytes" && limits[key] > 1900 * 1024)
        || (key === "historyPerUser" && limits[key] > 100)) {
        throw failure(`存储部署配置 ${key} 无效`, 500);
      }
      this.#limits[key] = limits[key];
    }
  }

  async list() {
    const { rows } = await this.#pool.query(
      `SELECT id, created_at, request_id,
        plan->'project' AS project, plan->'summary' AS summary,
        COALESCE(plan->'workItems', '[]'::jsonb) AS work_items
       FROM public_plan_history WHERE user_id = $1
       ORDER BY created_at DESC, id DESC LIMIT 100`, [this.#userId],
    );
    return rows.map((row) => ({
      id: row.id,
      createdAt: new Date(row.created_at).toISOString(),
      ...(row.request_id ? { requestId: row.request_id } : {}),
      project: row.project,
      summary: row.summary,
      workItemNames: (row.work_items ?? []).map((item) => item.name),
      workItemRemarks: [...new Set((row.work_items ?? [])
        .flatMap((item) => [item.divisionRemark, item.remark]).filter(Boolean))],
    }));
  }

  async get(id) {
    // Compare as text so invalid UUIDs have the same 404 response as other users' IDs.
    const { rows } = await this.#pool.query(
      "SELECT * FROM public_plan_history WHERE user_id = $1 AND id::text = $2",
      [this.#userId, String(id)],
    );
    if (!rows[0]) throw notFound();
    return historyRecord(rows[0]);
  }

  async findByRequestId(requestId) {
    const { rows } = await this.#pool.query(
      "SELECT * FROM public_plan_history WHERE user_id = $1 AND request_id = $2",
      [this.#userId, requiredText(requestId, "请求标识")],
    );
    return historyRecord(rows[0]);
  }

  async #save(plan, metadata) {
    // A plan may contain arbitrary project text; it never becomes an ownership selector.
    const serialized = jsonPayload(metadata ? { ...plan, requestId: metadata.requestId } : plan,
      this.#limits.planBytes, "测算方案");
    return transaction(this.#pool, async (client) => {
      if (metadata) {
        const { rows } = await client.query(
          "SELECT * FROM public_plan_history WHERE user_id = $1 AND request_id = $2",
          [this.#userId, metadata.requestId],
        );
        if (rows[0]) {
          if (rows[0].request_input_hash !== metadata.requestInputHash) throw conflict();
          return { record: historyRecord(rows[0]), created: false };
        }
      }
      const { rows: counts } = await client.query(
        `SELECT count(*)::integer AS total,
          count(*) FILTER (WHERE user_id = $1)::integer AS personal
         FROM public_plan_history`, [this.#userId],
      );
      if (counts[0].personal >= this.#limits.historyPerUser) {
        throw failure(`个人历史已达 ${this.#limits.historyPerUser} 条，请先删除不需要的记录`, 429);
      }
      if (counts[0].total >= this.#limits.historyTotal) {
        throw failure("公开免费版历史存储已满，请联系管理员；未删除任何历史", 429);
      }
      const { rows: usage } = await client.query(
        `INSERT INTO public_plan_usage (user_id, usage_day, saved_count)
         VALUES ($1, CURRENT_DATE, 1)
         ON CONFLICT (user_id) DO UPDATE SET usage_day = CURRENT_DATE,
           saved_count = CASE WHEN public_plan_usage.usage_day = CURRENT_DATE
             THEN public_plan_usage.saved_count + 1 ELSE 1 END
         RETURNING saved_count`, [this.#userId],
      );
      if (usage[0].saved_count > this.#limits.savesPerUserPerDay) {
        throw failure(`今日新增方案已达公开免费版 ${this.#limits.savesPerUserPerDay} 次上限，请明日再试`, 429);
      }
      const { rows } = await client.query(
        `INSERT INTO public_plan_history (id, user_id, request_id, request_input_hash, plan)
         VALUES ($1, $2, $3, $4, $5::jsonb) RETURNING *`,
        [randomUUID(), this.#userId, metadata?.requestId ?? null,
          metadata?.requestInputHash ?? null, serialized],
      );
      return { record: historyRecord(rows[0]), created: true };
    }, 710083477);
  }

  async addRequest(plan, { requestId, requestInputHash } = {}) {
    requiredText(requestId, "测算请求标识");
    requiredText(requestInputHash, "测算输入校验值");
    return this.#save(plan, { requestId, requestInputHash });
  }

  async add(plan) {
    const { record } = await this.#save(plan);
    return { id: record.id, createdAt: record.createdAt };
  }

  async delete(id) {
    const { rows } = await this.#pool.query(
      "DELETE FROM public_plan_history WHERE user_id = $1 AND id::text = $2 RETURNING id, created_at",
      [this.#userId, String(id)],
    );
    if (!rows[0]) throw notFound();
    return { id: rows[0].id, createdAt: new Date(rows[0].created_at).toISOString() };
  }
}

function normalizedId(value) {
  return String(value ?? "").trim().toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-").replace(/^-+|-+$/g, "");
}

function roles(input = {}) {
  const output = {};
  for (const [key, rawValue] of Object.entries(input ?? {})) {
    let role = key.trim().replaceAll("中方技术员", "中籍");
    if (role === "外籍") role = "外籍技工";
    const count = Number(rawValue);
    if (role && Number.isFinite(count) && count > 0) output[role] = (output[role] ?? 0) + count;
  }
  return output;
}

function normalizedEntry(entry) {
  const crew = roles(entry.crew);
  return {
    ...entry,
    division: entry.division || "其他工程",
    subitem: entry.subitem || "未分类分项",
    crew,
    roleProductivity: roles(entry.roleProductivity),
    crewText: entry.crewText || Object.entries(crew).map(([role, count]) => `${role}${count}`).join(" + "),
    productivityUnit: entry.productivityUnit || (entry.unit ? `${entry.unit}/班组·8h` : ""),
    workContent: entry.workContent || entry.notes || "",
  };
}

function normalizedPersonalEntry(entry) {
  const normalized = normalizedEntry(entry);
  // A personal user may deliberately clear work content while retaining notes.
  // The legacy shared store continues to use its original notes fallback.
  if (typeof entry.workContent === "string") normalized.workContent = entry.workContent;
  return normalized;
}

function preparedEntry(input, existing, { personal = false } = {}) {
  const id = normalizedId(input.id || `${input.division ?? "其他工程"}-${input.subitem ?? "未分类分项"}-${input.name ?? ""}`);
  requiredText(id, "工效编码");
  const mode = ["equipment_hour", "role_productivity"].includes(input.mode) ? input.mode : "crew_day";
  const productivityUnit = String(input.productivityUnit ?? "").trim();
  const unit = String(input.unit ?? productivityUnit.split("/")[0] ?? "").trim();
  const division = String(input.division ?? existing?.division ?? "其他工程").trim() || "其他工程";
  const subitem = String(input.subitem ?? existing?.subitem ?? "未分类分项").trim() || "未分类分项";
  // Explicit fields only: owner, permissions and provenance from request JSON
  // must never select an account or masquerade as trusted server metadata.
  const entry = (personal ? normalizedPersonalEntry : normalizedEntry)({
    id, division, subitem,
    hierarchyOrder: existing?.division === division && existing?.subitem === subitem ? existing.hierarchyOrder : undefined,
    category: String(input.category ?? "待分类").trim(),
    name: String(input.name ?? "").trim(), unit, mode,
    output: mode === "role_productivity" ? undefined
      : input.output === null || input.output === undefined || input.output === "" ? null : Number(input.output),
    crew: roles(input.crew), roleProductivity: roles(input.roleProductivity),
    crewText: String(input.crewText ?? "").trim(), productivityUnit,
    workContent: String(input.workContent ?? "").trim(),
    equipment: Array.isArray(input.equipment) ? input.equipment.map(String).map((item) => item.trim()).filter(Boolean) : [],
    source: String(input.source ?? "后续补充").trim(), sourcePriority: 3,
    status: ["confirmed", "needs_validation", "unavailable"].includes(input.status) ? input.status : "confirmed",
    notes: String(input.notes ?? "").trim(), updatedAt: new Date().toISOString(),
  });
  validateEntry(entry);
  return entry;
}

function filteredEntries(entries, { search = "", status = "" } = {}) {
  const needle = String(search).trim().toLowerCase();
  return entries.filter((entry) => !status || entry.status === status)
    .filter((entry) => !needle || [entry.id, entry.name, entry.division, entry.subitem,
      entry.category, entry.unit, entry.crewText, entry.productivityUnit, entry.workContent,
      ...Object.keys(entry.roleProductivity)].join(" ").toLowerCase().includes(needle));
}

export class PostgresProductivityStore {
  #pool;
  #isAdmin;

  // The API/tool layer independently checks the verified admin identity.
  // Keep this second authorization check immutable to request data.
  constructor(pool, { isAdmin = false } = {}) {
    this.#pool = pool;
    this.#isAdmin = isAdmin === true;
  }

  #requireAdmin() {
    if (!this.#isAdmin) throw failure("只有管理员可以维护共享工效库", 403);
  }

  async list({ search = "", status = "" } = {}) {
    const { rows } = await this.#pool.query(
      "SELECT entry FROM public_productivity WHERE deleted_at IS NULL ORDER BY created_at, id LIMIT 500",
    );
    const needle = String(search).trim().toLowerCase();
    return rows.map((row) => normalizedEntry(row.entry))
      .filter((entry) => !status || entry.status === status)
      .filter((entry) => !needle || [entry.id, entry.name, entry.division, entry.subitem,
        entry.category, entry.unit, entry.crewText, entry.productivityUnit, entry.workContent,
        ...Object.keys(entry.roleProductivity)].join(" ").toLowerCase().includes(needle));
  }

  async find(id) {
    const { rows } = await this.#pool.query(
      "SELECT entry FROM public_productivity WHERE id = $1 AND deleted_at IS NULL", [String(id)],
    );
    return rows[0] ? normalizedEntry(rows[0].entry) : null;
  }

  async upsert(input) {
    this.#requireAdmin();
    const id = normalizedId(input.id || `${input.division ?? "其他工程"}-${input.subitem ?? "未分类分项"}-${input.name ?? ""}`);
    const existing = await this.find(id);
    const entry = preparedEntry(input, existing);
    const serialized = jsonPayload(entry, PUBLIC_STORE_LIMITS.productivityBytes, "工效条目");
    return transaction(this.#pool, async (client) => {
      const { rows } = await client.query("SELECT count(*)::integer AS total FROM public_productivity");
      const existingAny = await client.query("SELECT id FROM public_productivity WHERE id = $1", [id]);
      if (!existingAny.rows.length && rows[0].total >= PUBLIC_STORE_LIMITS.productivityEntries) {
        throw failure("公开免费版工效库已达到 500 条上限", 429);
      }
      await client.query(
        `INSERT INTO public_productivity (id, entry) VALUES ($1, $2::jsonb)
         ON CONFLICT (id) DO UPDATE SET entry = EXCLUDED.entry, deleted_at = NULL, updated_at = CURRENT_TIMESTAMP`,
        [id, serialized],
      );
      return entry;
    }, 710083478);
  }

  async delete(id) {
    this.#requireAdmin();
    const normalized = normalizedId(id);
    const { rows } = await this.#pool.query(
      `UPDATE public_productivity SET deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND deleted_at IS NULL RETURNING entry`, [normalized],
    );
    if (!rows[0]) throw failure("未找到要删除的工效条目", 404);
    return { id: normalized, name: rows[0].entry.name };
  }
}

export class PostgresPersonalProductivityStore {
  #pool;
  #userId;

  // Identity is supplied only after issuer/sub verification, never by a tool
  // argument, URL, JSON field, public property or administrator role.
  constructor(pool, verifiedUserId) {
    this.#pool = pool;
    this.#userId = requiredText(verifiedUserId, "已验证用户标识");
  }

  #rejectOwnership(input) {
    if (["userId", "user_id", "ownerId", "owner_id", "owner"].some((key) => Object.hasOwn(input, key))) {
      throw failure("个人工效归属只能由当前已验证登录账号确定，不能在请求中指定", 400);
    }
  }

  async #checkOverlayQuota(client, id) {
    const { rows } = await client.query(
      `SELECT count(*)::integer AS global_total,
       count(*) FILTER (WHERE user_id = $1)::integer AS total,
       count(*) FILTER (WHERE user_id = $1 AND id = $2)::integer AS existing
       FROM public_personal_productivity`, [this.#userId, id],
    );
    if (!rows[0].existing && rows[0].total >= PUBLIC_STORE_LIMITS.productivityEntries) {
      throw failure("公开免费版个人工效修改记录已达到 500 条上限", 429);
    }
    if (!rows[0].existing && rows[0].global_total >= PUBLIC_STORE_LIMITS.personalProductivityTotal) {
      throw failure("公开免费版个人工效存储已满，请联系管理员；未删除任何工效", 429);
    }
  }

  async #entries(client = this.#pool) {
    const { rows } = await client.query(
      `SELECT entry, catalog_scope FROM (
       SELECT s.id, s.entry, s.created_at, 'shared' AS catalog_scope FROM public_productivity s
       WHERE s.deleted_at IS NULL AND NOT EXISTS (
         SELECT 1 FROM public_personal_productivity p WHERE p.user_id = $1 AND p.id = s.id)
       UNION ALL
       SELECT p.id, p.entry, p.created_at, 'personal' AS catalog_scope FROM public_personal_productivity p
       WHERE p.user_id = $1 AND p.deleted_at IS NULL
       ) effective ORDER BY created_at, id`, [this.#userId],
    );
    return rows.map((row) => ({ ...(row.catalog_scope === "personal" ? normalizedPersonalEntry(row.entry) : normalizedEntry(row.entry)), catalogScope: row.catalog_scope,
      hasPersonalOverride: row.catalog_scope === "personal" }));
  }

  async list(filters = {}) {
    return filteredEntries(await this.#entries(), filters);
  }

  async find(id) {
    const { rows } = await this.#pool.query(
      `SELECT s.entry, 'shared' AS catalog_scope FROM public_productivity s
       WHERE s.id = $2 AND s.deleted_at IS NULL AND NOT EXISTS (
         SELECT 1 FROM public_personal_productivity p WHERE p.user_id = $1 AND p.id = s.id)
       UNION ALL
       SELECT p.entry, 'personal' AS catalog_scope FROM public_personal_productivity p
       WHERE p.user_id = $1 AND p.id = $2 AND p.deleted_at IS NULL`, [this.#userId, String(id)],
    );
    return rows[0] ? { ...(rows[0].catalog_scope === "personal" ? normalizedPersonalEntry(rows[0].entry) : normalizedEntry(rows[0].entry)), catalogScope: rows[0].catalog_scope,
      hasPersonalOverride: rows[0].catalog_scope === "personal" } : null;
  }

  async upsert(input) {
    this.#rejectOwnership(input);
    const id = normalizedId(input.id || `${input.division ?? "其他工程"}-${input.subitem ?? "未分类分项"}-${input.name ?? ""}`);
    // Missing/undefined patch fields preserve the current version. Deliberately
    // supplied empty text/arrays are still meaningful and may clear a field.
    const patch = Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
    return transaction(this.#pool, async (client) => {
      await this.#checkOverlayQuota(client, id);
      const effective = await this.#entries(client);
      const existing = effective.find((item) => item.id === id);
      const entry = preparedEntry({ ...existing, ...patch }, existing, { personal: true });
      const serialized = jsonPayload(entry, PUBLIC_STORE_LIMITS.productivityBytes, "个人工效条目");
      if (!effective.some((item) => item.id === id) && effective.length >= PUBLIC_STORE_LIMITS.productivityEntries) {
        throw failure("公开免费版个人工效库已达到 500 条上限", 429);
      }
      await client.query(
        `INSERT INTO public_personal_productivity (user_id, id, entry) VALUES ($1, $2, $3::jsonb)
         ON CONFLICT (user_id, id) DO UPDATE SET entry = EXCLUDED.entry,
           deleted_at = NULL, updated_at = CURRENT_TIMESTAMP`, [this.#userId, id, serialized],
      );
      return { ...entry, catalogScope: "personal", hasPersonalOverride: true };
    }, 710083480);
  }

  async delete(id) {
    const normalized = normalizedId(id);
    return transaction(this.#pool, async (client) => {
      const effective = (await this.#entries(client)).find((item) => item.id === normalized);
      if (!effective) throw failure("未找到要从个人工效库隐藏的条目", 404);
      await this.#checkOverlayQuota(client, normalized);
      const { catalogScope: _scope, hasPersonalOverride: _override, ...entry } = effective;
      await client.query(
        `INSERT INTO public_personal_productivity (user_id, id, entry, deleted_at)
         VALUES ($1, $2, $3::jsonb, CURRENT_TIMESTAMP)
         ON CONFLICT (user_id, id) DO UPDATE SET deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP`,
        [this.#userId, normalized, jsonPayload(entry, PUBLIC_STORE_LIMITS.productivityBytes, "个人工效条目")],
      );
      return { id: normalized, name: entry.name, catalogScope: "personal", hasPersonalOverride: true };
    }, 710083480);
  }
}

// Run explicitly during a controlled release, never per user request.
export async function migrateDatabase(pool) {
  const migration = await readFile(new URL("../sql/001-public.sql", import.meta.url), "utf8");
  await transaction(pool, (client) => client.query(migration), 710083479);
}

// Insert-only, bundled default catalog. Deleted rows remain tombstones, and
// administrator changes are never overwritten by a later restart/seed.
export async function seedPublicProductivity(pool) {
  return transaction(pool, async (client) => {
    for (const sourceEntry of productivityData) {
      const entry = normalizedEntry(sourceEntry);
      const serialized = jsonPayload(entry, PUBLIC_STORE_LIMITS.productivityBytes, "默认工效条目");
      await client.query(
        "INSERT INTO public_productivity (id, entry) VALUES ($1, $2::jsonb) ON CONFLICT (id) DO NOTHING",
        [entry.id, serialized],
      );
    }
  }, 710083478);
}
