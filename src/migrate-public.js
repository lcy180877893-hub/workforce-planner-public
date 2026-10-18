import { loadPublicConfig } from "./public-auth.js";
import { createPublicPool } from "./public-server.js";
import { migrateDatabase, seedPublicProductivity } from "./cloud-stores.js";

// Only the explicit public database URL is used; never load a local .env or JSON store.
async function migrate() {
  const pool = createPublicPool(loadPublicConfig(process.env));
  try { await migrateDatabase(pool); await seedPublicProductivity(pool); console.log("公开数据库结构与默认公共工效初始化完成；未导入私有历史。"); }
  finally { await pool.end(); }
}
migrate().catch(() => { console.error("公开数据库初始化未完成，请在安全的部署设置中检查连接及证书。未读取私有本机数据。"); process.exitCode = 1; });
