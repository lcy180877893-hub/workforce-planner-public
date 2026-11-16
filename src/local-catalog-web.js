import express from "express";
import { spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createLocalProductivityStore } from "./local-productivity-store.js";

const assets = ["app.js", "calendar.js", "plan-visualizations.js", "public-mode.js", "schedule-charts.js", "styles.css"];
const contentPolicy = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

export async function startLocalCatalogEditor({ store = createLocalProductivityStore(), port = 0 } = {}) {
  const app = express();
  const token = randomBytes(32).toString("hex");
  const tokenBytes = Buffer.from(token);
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    const host = "127.0.0.1:" + req.socket.localPort;
    res.set({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": contentPolicy });
    if (req.get("host") !== host || (req.get("origin") !== undefined && req.get("origin") !== "http://" + host)) {
      return res.status(403).json({ error: "请从本机打开工效库。" });
    }
    next();
  });

  app.get("/", async (_req, res) => {
    const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
    res.type("html").send(html.replace("<head>", '<head>\n<script src="/local-mode.js"></script>'));
  });
  app.get("/local-mode.js", (_req, res) => res.type("js").send("globalThis.WORKFORCE_PUBLIC_MODE = true; globalThis.WORKFORCE_LOCAL_CATALOG = true;"));
  for (const asset of assets) {
    app.get("/" + asset, async (_req, res) => res.type(asset.endsWith(".css") ? "css" : "js").send(await readFile(new URL("../public/" + asset, import.meta.url))));
  }
  app.use("/api", (req, res, next) => {
    const supplied = Buffer.from(req.get("X-CSRF-Token") || "");
    if (supplied.length !== tokenBytes.length || !timingSafeEqual(supplied, tokenBytes)) {
      return res.status(403).json({ error: "请重新双击打开本机工效库。" });
    }
    if (["POST", "PUT"].includes(req.method) && !req.is("application/json")) {
      return res.status(415).json({ error: "工效数据须使用 JSON 格式。" });
    }
    next();
  }, express.json({ limit: "64kb" }));
  app.get("/api/session", (_req, res) => res.json({ authenticated: false, accessMode: "local", account: null, csrfToken: token }));
  app.get("/api/productivity", async (req, res) => res.json({ items: await store.list(req.query) }));
  app.post("/api/productivity", async (req, res) => {
    if (req.body?.id) return res.status(400).json({ error: "请从列表中选择已有工效后编辑。" });
    res.status(201).json({ saved: await store.upsert(req.body) });
  });
  app.put("/api/productivity/:id", async (req, res) => {
    if (!req.body || Array.isArray(req.body)) return res.status(400).json({ error: "请填写要修改的工效。" });
    res.json({ saved: await store.upsert({ ...req.body, id: req.params.id }, { mustExist: true }) });
  });
  app.delete("/api/productivity/:id", async (req, res) => res.json({ deleted: await store.delete(req.params.id) }));
  app.use((_req, res) => res.status(404).json({ error: "未找到该页面或工效操作。" }));
  app.use((error, _req, res, _next) => {
    const status = Number(error.statusCode || error.status);
    if (error.type === "entity.parse.failed") return res.status(400).json({ error: "工效数据格式有误。" });
    if (error.type === "entity.too.large") return res.status(413).json({ error: "工效条目过大。" });
    if ([400, 404, 409, 413, 415, 422].includes(status)) return res.status(status).json({ error: error.message });
    res.status(500).json({ error: "本机工效库暂时无法读写，请检查数据目录后重试。" });
  });

  try {
    const server = await new Promise((accept, reject) => {
      const listener = app.listen(port, "127.0.0.1", (error) => error ? reject(error) : accept(listener));
    });
    return {
      url: "http://127.0.0.1:" + server.address().port + "/#" + token,
      async close() {
        try { await new Promise((done) => server.close(done)); }
        finally { store.close(); }
      },
    };
  } catch (error) {
    store.close();
    throw error;
  }
}

async function main() {
  const editor = await startLocalCatalogEditor();
  console.log("本机工效库已启动。使用期间请保留此窗口，关闭窗口即可退出。\n" + editor.url);
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { void editor.close(); });
  if (process.argv.includes("--open")) {
    const command = process.platform === "win32" ? "explorer.exe" : process.platform === "darwin" ? "open" : "xdg-open";
    const browser = spawn(command, [editor.url], { windowsHide: true, stdio: "ignore" });
    browser.on("error", () => console.error("浏览器未自动打开，请复制上面的本机地址到浏览器。"));
    browser.unref();
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error("本机工效库启动失败。请检查数据目录能否读写，以及 Node.js 版本是否为 24。"); process.exitCode = 1; });
}
