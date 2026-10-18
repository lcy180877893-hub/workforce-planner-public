import express from "express";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import pg from "pg";
import path from "node:path";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpServer, cloudReviewInputSchema, cloudPlanInputSchema, requestHash, validatePublicInput } from "./mcp.js";
import { buildProjectReviewContext } from "./project-review.js";
import { generateWorkforcePlan } from "./planner.js";
import { PostgresHistoryStore, PostgresProductivityStore } from "./cloud-stores.js";
import { createPublicAuth, loadPublicConfig, requirePrincipal, protectedResourceMetadata, oauthChallenge } from "./public-auth.js";

export const PUBLIC_VERSION = "0.19.0-rc.1";
const PUBLIC_DIR = fileURLToPath(new URL("../public", import.meta.url));
const account = (principal) => ({ id: principal.id, displayName: principal.displayName, isAdmin: principal.isAdmin });
const badRequest = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });

// Use the system CA store and hostname verification. Never accept an insecure
// database URL override (pg's sslmode URL parsing can replace an explicit SSL object).
export function createPublicPool(config) {
  let url;
  try { url = new URL(config.databaseUrl); } catch { throw new Error("DATABASE_URL 格式不正确"); }
  if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname || !url.username || !url.password || url.hash) {
    throw new Error("DATABASE_URL 必须是完整的 PostgreSQL 连接地址");
  }
  for (const key of ["ssl", "sslmode", "sslcert", "sslkey", "sslrootcert", "sslpassword"]) url.searchParams.delete(key);
  if (url.searchParams.has("options")) throw new Error("数据库地址不能覆盖服务器会话选项");
  return new pg.Pool({ connectionString: url.href, ssl: { rejectUnauthorized: true },
    max: 5, idleTimeoutMillis: 30000, connectionTimeoutMillis: 10000, query_timeout: 15000 });
}

function createLimiter({ windowMs = 60000, maximum = 60 } = {}) {
  const entries = new Map();
  return (key) => {
    const now = Date.now();
    if (entries.size >= 10000) for (const [id, value] of entries) if (value.until <= now) entries.delete(id);
    if (!entries.has(key) && entries.size >= 10000) throw badRequest("访问较多，请稍后重试", 429);
    const entry = entries.get(key);
    if (!entry || entry.until <= now) { entries.set(key, { count: 1, until: now + windowMs }); return; }
    if (++entry.count > maximum) throw badRequest("操作过于频繁，请稍后重试；未重复生成方案", 429);
  };
}

export function createPublicApp({ config, pool, auth = createPublicAuth(config) }) {
  if (!config || !pool || !auth) throw new Error("公开服务必须显式配置认证与数据库，不能回退到私有文件存储");
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use((req, res, next) => {
    res.set({ "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" });
    if (req.path !== "/mcp") res.set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'self'");
    next();
  });
  app.get("/health", (_req, res) => res.json({ ok: true, service: "workforce-planner-public", version: PUBLIC_VERSION }));
  app.get("/ready", async (_req, res) => {
    try { await pool.query("SELECT id FROM public_productivity LIMIT 1"); res.json({ ok: true }); }
    catch { res.status(503).json({ ok: false, error: "数据库尚未就绪" }); }
  });
  app.get(["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"], (_req, res) => res.json(protectedResourceMetadata(config)));
  app.use(express.json({ limit: "768kb" }));

  // Bearer-only MCP: website cookies, user-id headers and project fields cannot
  // select the principal. Anonymous discovery is safe; tools enforce OAuth below.
  const mcpLimit = createLimiter({ maximum: 90 });
  app.post("/mcp", async (req, res, next) => {
    try {
      if (req.headers.origin && ![config.origin, "https://chatgpt.com", "https://chat.openai.com"].includes(req.headers.origin)) {
        throw badRequest("此来源不允许访问 MCP", 403);
      }
      const principal = await auth.resolvePrincipal(req, { allowSession: false });
      mcpLimit(principal?.id || `anonymous:${req.ip}`);
      const catalog = new PostgresProductivityStore(pool, { isAdmin: principal?.isAdmin === true });
      const history = principal ? new PostgresHistoryStore(pool, principal.id) : null;
      const server = createMcpServer(catalog, history, { cloudMode: true, principal, authConfig: config });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => { void transport.close().catch(() => {}); void server.close().catch(() => {}); });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) { next(error); }
  });
  app.all("/mcp", (_req, res) => res.status(405).set("Allow", "POST").json({ error: "Use POST for stateless MCP" }));

  // Standard OIDC library handles login, callback, encrypted secure cookies and
  // POST-only CSRF-checked local logout. No password or model API is implemented.
  app.use(auth.websiteMiddleware);
  app.get("/api/session", async (req, res, next) => {
    try {
      const principal = await auth.resolvePrincipal(req);
      res.json(principal ? { authenticated: true, user: account(principal), csrfToken: auth.csrfToken(req) }
        : { authenticated: false, loginUrl: "/login" });
    } catch (error) { next(error); }
  });
  const apiLimit = createLimiter({ maximum: 90 });
  app.use("/api", async (req, _res, next) => {
    try {
      req.publicPrincipal = requirePrincipal(await auth.resolvePrincipal(req), ["workforce:read"]);
      // This header is only a stale-view guard, never an identity selector.
      if (req.headers["x-workforce-account"] && req.headers["x-workforce-account"] !== req.publicPrincipal.id) {
        throw badRequest("登录账号已变化，请重新打开页面", 401);
      }
      _res.set("X-Workforce-Account", req.publicPrincipal.id);
      apiLimit(req.publicPrincipal.id);
      if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) requirePrincipal(req.publicPrincipal, ["workforce:write"]);
      next();
    } catch (error) { next(error); }
  }, auth.csrfGuard);
  const stores = (req) => ({
    catalog: new PostgresProductivityStore(pool, { isAdmin: req.publicPrincipal.isAdmin === true }),
    history: new PostgresHistoryStore(pool, req.publicPrincipal.id),
  });
  app.get("/api/gpt-status", (_req, res) => res.json({ configured: true,
    message: "施工顺序由你已连接公开插件的 ChatGPT 会话判断；本站不调用模型 API。" }));
  app.get("/api/productivity", async (req, res, next) => {
    try { res.json({ items: await stores(req).catalog.list({ search: String(req.query.search || "").slice(0, 200), status: String(req.query.status || "") }) }); }
    catch (error) { next(error); }
  });
  const admin = (req, _res, next) => req.publicPrincipal.isAdmin ? next() : next(badRequest("只有管理员可以维护公共工效库", 403));
  for (const method of ["post", "put"]) app[method](method === "post" ? "/api/productivity" : "/api/productivity/:id", admin, async (req, res, next) => {
    try { res.json({ saved: await stores(req).catalog.upsert({ ...req.body, ...(req.params.id ? { id: req.params.id } : {}) }) }); }
    catch (error) { next(error); }
  });
  app.delete("/api/productivity/:id", admin, async (req, res, next) => {
    try { res.json({ deleted: await stores(req).catalog.delete(req.params.id) }); } catch (error) { next(error); }
  });
  app.get("/api/workforce-history", async (req, res, next) => {
    try { res.json({ items: await stores(req).history.list() }); } catch (error) { next(error); }
  });
  app.get("/api/workforce-history/:id", async (req, res, next) => {
    try { res.json({ record: await stores(req).history.get(req.params.id) }); } catch (error) { next(error); }
  });
  app.delete("/api/workforce-history/:id", async (req, res, next) => {
    try { res.json({ deleted: await stores(req).history.delete(req.params.id) }); } catch (error) { next(error); }
  });
  app.post("/api/project-review", async (req, res, next) => {
    try {
      const input = cloudReviewInputSchema.parse(req.body);
      validatePublicInput(input, true);
      res.json({ ...await buildProjectReviewContext(input, stores(req).catalog), requestId: randomUUID() });
    } catch (error) { next(error); }
  });
  // This endpoint accepts a COMPLETE, fingerprint-checked review only. The website
  // prepares a prompt instead of silently calling a model or inventing dependencies.
  app.post("/api/workforce-plan", async (req, res, next) => {
    try {
      const { requestId, ...input } = cloudPlanInputSchema.parse(req.body);
      validatePublicInput(input, true);
      const { catalog, history } = stores(req);
      const inputHash = requestHash(input);
      const prior = await history.findByRequestId(requestId);
      if (prior) {
        if (prior.requestInputHash !== inputHash) throw badRequest("请求编号已用于其他输入，请重新发起测算", 409);
        return res.json({ ...prior.plan, history: { id: prior.id, createdAt: prior.createdAt }, account: account(req.publicPrincipal) });
      }
      const plan = await generateWorkforcePlan(input, catalog);
      const { record } = await history.addRequest(plan, { requestId, requestInputHash: inputHash });
      res.json({ ...record.plan, history: { id: record.id, createdAt: record.createdAt }, account: account(req.publicPrincipal) });
    } catch (error) { next(error); }
  });
  app.use("/api", (_req, res) => res.status(404).json({ error: "接口不存在" }));
  app.get("/public-release.js", (_req, res) => res.type("application/javascript").send("globalThis.WORKFORCE_PUBLIC_MODE = true;"));
  app.get("/", async (_req, res, next) => {
    try {
      const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
      res.type("html").send(html.replace("<head>", '<head>\n<script src="/public-release.js"></script>'));
    } catch (error) { next(error); }
  });
  // Only the injected root handler serves HTML. Encoded/case-variant index paths
  // must never return the legacy HTML without the public-mode identity guard.
  app.use((req, res, next) => {
    let requested;
    try { requested = decodeURIComponent(req.path).toLowerCase(); } catch { return next(badRequest("页面地址不正确")); }
    if (requested.endsWith(".html") || requested.endsWith(".html/")) return res.redirect(302, "/");
    return [".js", ".css"].includes(path.extname(requested)) ? next() : res.status(404).type("text").send("页面不存在");
  }, express.static(PUBLIC_DIR, { index: false, dotfiles: "deny", etag: false, maxAge: 0 }));
  app.use((_req, res) => res.status(404).type("text").send("页面不存在"));
  app.use((error, _req, res, _next) => {
    if (res.headersSent) return;
    const raw = Number(error.statusCode ?? error.status);
    const status = error.name === "ZodError" ? 400 : [400, 401, 403, 404, 409, 413, 429].includes(raw) ? raw : 503;
    if (status === 401 || error.code === "insufficient_scope") res.set("WWW-Authenticate", oauthChallenge(config, error.code));
    if (status === 429) res.set("Retry-After", "60");
    res.status(status).json({ error: status === 503 ? "服务暂不可用，请稍后重试；未使用私有本机数据或模型 API。"
      : error.name === "ZodError" ? "项目输入不完整或格式不正确" : error.message });
  });
  return app;
}

async function main() {
  const config = loadPublicConfig(process.env);
  const pool = createPublicPool(config);
  // Migration is an explicit separate deployment step, never an HTTP request.
  await pool.query("SELECT id FROM public_productivity LIMIT 1");
  const app = createPublicApp({ config, pool });
  const port = Number(process.env.PORT || 3000);
  const server = app.listen(port, "0.0.0.0", () => console.log(`公开版候选服务 ${PUBLIC_VERSION} 已启动`));
  const stop = () => server.close(() => { void pool.end().finally(() => process.exit(0)); });
  process.once("SIGTERM", stop); process.once("SIGINT", stop);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error("公开服务启动失败：请核对认证、数据库与迁移配置。未启动私有回退模式。"); process.exitCode = 1; });
}
