import test from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } from "jose";
import { createPublicApp, createPublicPool } from "../src/public-server.js";
import { createPublicAuth, loadPublicConfig, principalFromClaims } from "../src/public-auth.js";
import { migrateDatabase, PostgresProductivityStore } from "../src/cloud-stores.js";

const config = loadPublicConfig({
  PUBLIC_ORIGIN: "https://workforce.example", AUTH0_ISSUER_BASE_URL: "https://synthetic.auth0.com",
  AUTH0_CLIENT_ID: "synthetic-client", AUTH0_CLIENT_SECRET: "synthetic-not-a-real-secret",
  SESSION_SECRET: "synthetic-session-secret-at-least-32-bytes", DATABASE_URL: "postgresql://test:test@localhost/test",
  ADMIN_SUBJECTS: "auth0|admin",
});
const keys = await generateKeyPair("RS256");
const jwk = await exportJWK(keys.publicKey);
const keySet = createLocalJWKSet({ keys: [{ ...jwk, kid: "synthetic-key", alg: "RS256", use: "sig" }] });
const csrf = "S".repeat(43);
const definitions = [
  { id: "synthetic-steel", name: "人工测试钢筋绑扎", division: "主体结构工程", subitem: "钢筋工程", category: "钢筋工", unit: "t", output: 10, crew: { 钢筋工: 4 } },
  { id: "synthetic-pour", name: "人工测试混凝土浇筑", division: "主体结构工程", subitem: "混凝土工程", category: "混凝土工", unit: "m³", output: 100, crew: { 混凝土工: 4 } },
].map((entry) => ({ ...entry, mode: "crew_day", status: "confirmed", workContent: entry.name }));

async function token(subject = "auth0|alice", scope = "workforce:read workforce:write", audience = config.audience) {
  return new SignJWT({ scope, name: `Synthetic ${subject}`, isAdmin: true, roles: ["admin"] })
    .setProtectedHeader({ alg: "RS256", kid: "synthetic-key" }).setIssuer(config.issuer)
    .setAudience(audience).setSubject(subject).setIssuedAt().setExpirationTime("5m").sign(keys.privateKey);
}

async function fixture(t, { sessionSubject = null } = {}) {
  // Real PostgreSQL SQL with an exclusive single-backend pool lease. This does
  // not claim to simulate independent PostgreSQL backend lock scheduling.
  const database = await PGlite.create();
  let pending = Promise.resolve();
  async function lease() {
    const previous = pending; let release;
    pending = new Promise((resolve) => { release = resolve; });
    await previous; return release;
  }
  const execute = async (sql, values) => sql.includes("CREATE TABLE IF NOT EXISTS")
    ? (await database.exec(sql)).at(-1) : database.query(sql, values);
  const pool = {
    async connect() { const release = await lease(); return { query: execute, release }; },
    async query(sql, values) { const release = await lease(); try { return await execute(sql, values); } finally { release(); } },
  };
  await migrateDatabase(pool);
  const admin = new PostgresProductivityStore(pool, { isAdmin: true });
  for (const definition of definitions) await admin.upsert(definition);
  // Only an injected SDK double can establish fixture cookies. There is no
  // production switch, header or request field that bypasses OIDC verification.
  const auth = createPublicAuth(config, { jwtKeySet: keySet, oidcFactory: (options) => (req, _res, next) => {
    if (sessionSubject) {
      req[options.session.name] = { workforceCsrf: csrf };
      req.oidc = { isAuthenticated: () => true, idTokenClaims: { iss: config.issuer, sub: sessionSubject, name: "Synthetic cookie user" } };
    }
    next();
  } });
  const app = createPublicApp({ config, pool, auth });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); await database.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  async function call(path, { bearer, method = "GET", body, headers = {}, redirect = "follow" } = {}) {
    const response = await fetch(origin + path, { method, redirect, headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}), ...headers,
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const raw = await response.text();
    return { status: response.status, headers: response.headers, raw,
      body: response.headers.get("content-type")?.includes("application/json") ? JSON.parse(raw) : raw };
  }
  return { call, pool };
}

function projectInput() {
  return { project: { name: "合成多账号项目", context: "整体施工，不分区流水；其他准备工作已完成", startDate: "2026-10-01", endDate: "2026-11-01" },
    workItems: [
      { itemId: "steel-work", divisionId: "structure", subitemId: "steel-sub", activityId: "synthetic-steel", quantity: 20, unit: "t" },
      { itemId: "pour-work", divisionId: "structure", subitemId: "pour-sub", activityId: "synthetic-pour", quantity: 100, unit: "m³" },
    ] };
}
function review(context) {
  return { fingerprint: context.fingerprint, summary: "合成测试，钢筋整项完成验收后浇筑",
    reviewedItemIds: ["steel-work", "pour-work"],
    itemDecisions: ["steel-work", "pour-work"].map((itemId) => ({ itemId, sequenceStatus: "determined", reason: "测试条件已明确整体技术先后与独立资源" })),
    dependencies: [{ beforeItemId: "steel-work", afterItemId: "pour-work", reason: "钢筋整项完成并验收后才浇筑" }],
    parallelGroups: [], assumptions: [], questions: [] };
}

test("website serves public mode at every HTML entry; no private files or cache", async (t) => {
  const { call } = await fixture(t);
  const root = await call("/");
  assert.equal(root.status, 200);
  assert.ok(root.raw.indexOf("/public-release.js") < root.raw.indexOf("/public-mode.js"));
  assert.match(root.headers.get("cache-control"), /no-store/);
  assert.match(root.headers.get("content-security-policy"), /frame-ancestors 'self'/);
  for (const path of ["/index.html", "/INDEX.HTML", "/%69ndex.html", "/index.html/"]) {
    const response = await call(path, { redirect: "manual" });
    assert.equal(response.status, 302, path); assert.equal(response.headers.get("location"), "/");
  }
  for (const path of ["/.env", "/data/plan-history.json", "/src/cloud-stores.js", "/release-manifest.json"]) assert.equal((await call(path)).status, 404);
  assert.match((await call("/public-release.js")).raw, /WORKFORCE_PUBLIC_MODE = true/);
  assert.equal((await call("/health")).body.version, "0.19.0-rc.1");
  assert.equal((await call("/ready")).status, 200);
  assert.equal((await call("/api/session")).body.authenticated, false);
});

test("HTTP identity is verified JWT, never body, role, account hint or wrong audience", async (t) => {
  const { call } = await fixture(t);
  for (const path of ["/api/productivity", "/api/workforce-history"]) {
    const rejected = await call(path, { headers: { "X-User-Id": "auth0|admin" } });
    assert.equal(rejected.status, 401); assert.match(rejected.headers.get("www-authenticate"), /error_description=/);
  }
  assert.equal((await call("/api/productivity", { bearer: "bad-token" })).status, 401);
  assert.equal((await call("/api/productivity", { bearer: await token("auth0|alice", undefined, "wrong-audience") })).status, 401);
  const alice = await token();
  const session = await call("/api/session", { bearer: alice });
  assert.equal(session.body.user.isAdmin, false, "forged JWT role is ignored even when token is signed");
  assert.equal((await call("/api/productivity", { bearer: alice })).body.items.length, 2);
  assert.equal((await call("/api/productivity", { bearer: alice, headers: { "X-Workforce-Account": "other-user" } })).status, 401);
  assert.equal((await call("/api/productivity", { bearer: alice, method: "POST", body: { ...definitions[0], isAdmin: true, userId: "auth0|admin" } })).status, 403);
  assert.equal((await call("/api/productivity/synthetic-steel", { bearer: alice, method: "DELETE" })).status, 403);
  const readOnly = await call("/api/project-review", { bearer: await token("auth0|reader", "workforce:read"), method: "POST", body: projectInput() });
  assert.equal(readOnly.status, 403); assert.match(readOnly.headers.get("www-authenticate"), /insufficient_scope/);
  assert.equal((await call("/api/productivity/synthetic-steel", { bearer: await token("auth0|admin"), method: "PUT", body: { ...definitions[0], output: 11 } })).status, 200);
});

test("complete reviewed workflow saves once, preserves construction order and isolates two users", async (t) => {
  const { call } = await fixture(t);
  const alice = await token(); const bob = await token("auth0|bob");
  const input = projectInput();
  assert.equal((await call("/api/workforce-plan", { bearer: alice, method: "POST", body: input })).status, 400, "cannot generate without complete review");
  const prepared = await call("/api/project-review", { bearer: alice, method: "POST", body: input });
  assert.equal(prepared.status, 200);
  assert.match(prepared.body.fingerprint, /^[a-f0-9]{64}$/);
  assert.equal((await call("/api/workforce-history", { bearer: alice })).body.items.length, 0, "prepare never saves history");
  const request = { ...input, constructionReview: review(prepared.body), requestId: "synthetic-idempotent-request", userId: "forged-other-user" };
  const saved = await call("/api/workforce-plan", { bearer: alice, method: "POST", body: request });
  assert.equal(saved.status, 200, saved.raw);
  assert.ok(saved.body.planOptions.length > 0);
  for (const option of saved.body.planOptions) {
    const steel = option.workItems.find((item) => item.itemId === "steel-work");
    const pour = option.workItems.find((item) => item.itemId === "pour-work");
    assert.ok(steel.endDate < pour.startDate, "every option must keep finish-to-start order");
    assert.ok(option.summary.totalPersonDays > 0);
  }
  const id = saved.body.history.id;
  const replay = await call("/api/workforce-plan", { bearer: alice, method: "POST", body: request });
  assert.equal(replay.status, 200); assert.equal(replay.body.history.id, id);
  assert.equal((await call("/api/workforce-history", { bearer: alice })).body.items.length, 1);
  const conflict = await call("/api/workforce-plan", { bearer: alice, method: "POST", body: { ...request, project: { ...input.project, name: "changed" } } });
  assert.equal(conflict.status, 409);
  for (const method of ["GET", "DELETE"]) assert.equal((await call(`/api/workforce-history/${id}`, { bearer: bob, method })).status, 404);
  assert.deepEqual((await call("/api/workforce-history", { bearer: bob })).body.items, []);
  const bobSaved = await call("/api/workforce-plan", { bearer: bob, method: "POST", body: request });
  assert.equal(bobSaved.status, 200); assert.notEqual(bobSaved.body.history.id, id);
  assert.notEqual(bobSaved.body.account.id, saved.body.account.id);
  assert.equal((await call(`/api/workforce-history/${id}`, { bearer: alice })).body.record.plan.workflow.mode, "gpt");
  assert.equal((await call(`/api/workforce-history/${id}`, { bearer: alice, method: "DELETE" })).status, 200);
  assert.equal((await call("/api/workforce-history", { bearer: alice })).body.items.length, 0);
  assert.equal((await call("/api/workforce-history", { bearer: bob })).body.items.length, 1);
});

test("cookie writes need Origin plus CSRF; website cookies never authenticate MCP", async (t) => {
  const { call } = await fixture(t, { sessionSubject: "auth0|cookie" });
  const input = projectInput();
  const current = await call("/api/session");
  assert.equal(current.body.csrfToken, csrf);
  assert.equal((await call("/api/project-review", { method: "POST", body: input })).status, 403);
  assert.equal((await call("/api/project-review", { method: "POST", body: input, headers: { Origin: "https://attacker.example", "X-CSRF-Token": csrf } })).status, 403);
  assert.equal((await call("/api/project-review", { method: "POST", body: input, headers: { Origin: config.origin, "X-CSRF-Token": csrf } })).status, 200);
  assert.equal((await call("/api/project-review", { method: "POST", bearer: "invalid", body: input, headers: { Origin: config.origin, "X-CSRF-Token": csrf } })).status, 401);
  const mcp = await call("/mcp", { method: "POST", headers: { Accept: "application/json, text/event-stream" },
    body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_current_profile", arguments: {} } } });
  assert.equal(mcp.status, 200, mcp.raw);
  assert.equal(mcp.body.result.isError, true);
  assert.match(mcp.body.result._meta["mcp/www_authenticate"][0], /error_description=/);
  assert.equal((await call("/mcp", { method: "POST", headers: { Origin: "https://attacker.example" }, body: {} })).status, 403);
});

test("database URL cannot disable verified TLS through pg parser overrides", async () => {
  for (const suffix of ["", "?ssl=false", "?ssl=0", "?sslmode=disable", "?sslmode=no-verify", "?sslcert=bad&sslkey=bad&sslrootcert=bad"]) {
    const pool = createPublicPool({ databaseUrl: `postgresql://test:test@localhost/test${suffix}` });
    assert.equal(new pool.Client(pool.options).connectionParameters.ssl.rejectUnauthorized, true, suffix);
    await pool.end();
  }
  assert.throws(() => createPublicPool({ databaseUrl: "postgresql://test:test@localhost/test?options=-csearch_path%3Dunsafe" }));
  assert.throws(() => createPublicPool({ databaseUrl: "postgresql://test@localhost/test" }));
  assert.throws(() => createPublicPool({ databaseUrl: "http://test:test@localhost/test" }));
  assert.notEqual(principalFromClaims({ iss: config.issuer, sub: "auth0|alice" }, config).id, "auth0|alice");
});
