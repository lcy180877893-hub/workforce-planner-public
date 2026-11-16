import { closeSync, mkdirSync, openSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { bundledProductivityStore, filteredEntries, normalizedId, preparedEntry } from "./cloud-stores.js";

function localPath(value) {
  if (!path.isAbsolute(value) || (process.platform === "win32" && !/^[a-z]:[\\/]/i.test(value))) {
    throw new Error("本机工效数据目录需要使用本机磁盘的绝对路径");
  }
  return value;
}

export function defaultLocalDatabasePath() {
  let directory = process.env.WORKFORCE_LOCAL_DATA_DIR;
  if (!directory) {
    if (process.platform === "win32") {
      directory = path.join(process.env.LOCALAPPDATA || path.join(homedir(), "AppData", "Local"), "WorkforcePlanner");
    } else if (process.platform === "darwin") {
      directory = path.join(homedir(), "Library", "Application Support", "WorkforcePlanner");
    } else {
      directory = path.join(process.env.XDG_DATA_HOME || path.join(homedir(), ".local", "share"), "WorkforcePlanner");
    }
  }
  return path.join(localPath(directory), "productivity.sqlite");
}

function entryWithScope(entry, isLocal) {
  return {
    ...entry,
    catalogScope: isLocal ? "local" : "bundled",
    hasLocalOverride: isLocal && Boolean(bundledProductivityStore.find(entry.id)),
  };
}

function catalogError(message, statusCode) {
  return Object.assign(new Error(message), { statusCode });
}

export function createLocalProductivityStore({ databasePath = defaultLocalDatabasePath() } = {}) {
  localPath(databasePath);
  mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
  closeSync(openSync(databasePath, "a", 0o600));
  const db = new DatabaseSync(databasePath);
  try {
    db.exec(`
      PRAGMA busy_timeout = 10000;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS local_productivity (
        id TEXT PRIMARY KEY NOT NULL,
        entry TEXT
      );
    `);
    const selectOne = db.prepare("SELECT entry FROM local_productivity WHERE id = ?");
    const selectAll = db.prepare("SELECT id, entry FROM local_productivity ORDER BY rowid");
    const write = db.prepare(`
      INSERT INTO local_productivity (id, entry) VALUES (?, ?)
      ON CONFLICT (id) DO UPDATE SET entry = excluded.entry
    `);

    function find(id) {
      const row = selectOne.get(id);
      if (row) return row.entry === null ? null : entryWithScope(JSON.parse(row.entry), true);
      const bundled = bundledProductivityStore.find(id);
      return bundled ? entryWithScope(bundled, false) : null;
    }

    function transaction(operation) {
      // Reserve the write lock before reading the effective entry. Two AI clients
      // or a browser can patch different fields without discarding either change.
      db.exec("BEGIN IMMEDIATE");
      try {
        const result = operation();
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    }

    return {
      list(filters) {
        const entries = new Map(bundledProductivityStore.list().map((entry) => [entry.id, entryWithScope(entry, false)]));
        for (const row of selectAll.all()) {
          if (row.entry === null) entries.delete(row.id);
          else entries.set(row.id, entryWithScope(JSON.parse(row.entry), true));
        }
        return filteredEntries([...entries.values()], filters);
      },
      find,
      upsert(input, { mustExist = false } = {}) {
        if (!input || typeof input !== "object" || Array.isArray(input)) throw catalogError("请提供要保存的工效条目", 400);
        const id = normalizedId(input.id || `${input.division ?? "其他工程"}-${input.subitem ?? "未分类分项"}-${input.name ?? ""}`);
        if (!id) throw catalogError("缺少有效的工效编码", 400);
        return transaction(() => {
          const existing = find(id);
          if (mustExist && !existing) throw catalogError("这条工效已从本机删除，请刷新工效库", 404);
          if (!input.id && existing) throw catalogError("本机已有同编码的工效，请选择该条目后修改，或给新增工效换一个名称", 409);
          const previous = existing ?? bundledProductivityStore.find(id);
          const patch = Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
          if (patch.crew && patch.crewText === undefined) patch.crewText = "";
          if (patch.unit !== undefined && patch.unit !== previous?.unit && patch.productivityUnit === undefined) {
            patch.productivityUnit = "";
          }
          const entry = preparedEntry({ ...previous, ...patch, id }, previous, { personal: true });
          if (previous?.sortOrder !== undefined) entry.sortOrder = previous.sortOrder;
          write.run(id, JSON.stringify(entry));
          return entryWithScope(entry, true);
        });
      },
      delete(id) {
        const key = normalizedId(id);
        return transaction(() => {
          const entry = find(key);
          if (!entry) throw catalogError("本机工效库中没有这条工效", 404);
          // A tombstone also hides a bundled item after restarting or upgrading.
          write.run(key, null);
          return { id: key, name: entry.name, catalogScope: "local", hasLocalOverride: Boolean(bundledProductivityStore.find(key)) };
        });
      },
      close() { if (db.isOpen) db.close(); },
    };
  } catch (error) {
    db.close();
    throw error;
  }
}
