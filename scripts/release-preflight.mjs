import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Deliberately exact: adding a release file requires review here AND in .gitignore.
// This is a publication safeguard, not a replacement for human secret/security review.
export const RELEASE_FILES = Object.freeze([
  ".gitignore", ".env.example", "README.md", "LICENSE", "DEPLOYMENT.md", "RELEASE-STATUS.md",
  "package.json", "pnpm-lock.yaml", "render.yaml", "release-manifest.json",
  "scripts/release-preflight.mjs", "sql/001-public.sql",
  "src/chatgpt-ui.js", "src/cloud-stores.js", "src/mcp.js", "src/migrate-public.js",
  "src/planner.js", "src/productivity-data.js", "src/productivity-expansion.js",
  "src/productivity-hierarchy.js", "src/productivity-store.js", "src/project-review.js",
  "src/public-auth.js", "src/public-server.js", "src/scheduler.js", "src/workflow.js",
  "public/app.js", "public/calendar.js", "public/chatgpt-bridge.js", "public/chatgpt-ui.js",
  "public/chatgpt.css", "public/index.html", "public/plan-visualizations.js",
  "public/public-mode.js", "public/schedule-charts.js", "public/styles.css",
  "test/chatgpt-bridge.test.js", "test/chatgpt-bundle.test.js",
  "test/chatgpt-ui.test.js", "test/cloud-mcp.test.js", "test/cloud-stores.test.js",
  "test/mcp.test.js", "test/multi-crew-overlap.test.js",
  "test/plan-visualizations.test.js", "test/planner.test.js", "test/productivity-store.test.js",
  "test/project-review.test.js", "test/public-auth.test.js", "test/public-frontend.test.js",
  "test/public-service.test.js", "test/release-preflight.test.js", "test/resource-scheduling.test.js",
  "test/resource-ui.test.js", "test/reviewed-planner.test.js", "test/schedule-charts.test.js",
  "test/single-crew-overlap.test.js", "test/fixtures/resource-preview.mjs",
]);

const requiredFiles = [
  ".gitignore", ".env.example", "README.md", "LICENSE", "DEPLOYMENT.md", "package.json", "pnpm-lock.yaml",
  "render.yaml", "scripts/release-preflight.mjs", "sql/001-public.sql",
  "src/public-server.js", "src/public-auth.js", "src/cloud-stores.js", "src/migrate-public.js",
  "src/mcp.js", "src/chatgpt-ui.js", "src/planner.js", "src/productivity-store.js",
  "src/productivity-data.js", "src/productivity-expansion.js", "src/productivity-hierarchy.js", "src/project-review.js",
  "src/workflow.js", "src/scheduler.js", "public/index.html", "public/app.js", "public/public-mode.js",
  "public/calendar.js", "public/chatgpt-bridge.js", "public/chatgpt-ui.js", "public/chatgpt.css",
  "public/styles.css", "public/schedule-charts.js", "public/plan-visualizations.js",
];
const allowed = new Set(RELEASE_FILES);
const allowedDirectories = new Set(RELEASE_FILES.flatMap((name) => {
  const parts = name.split("/"); return parts.slice(0, -1).map((_part, index) => parts.slice(0, index + 1).join("/"));
}));
const skippedRoots = new Set(["node_modules", ".git"]);
const forbiddenNames = new Set(["data", "sources", "connection", "connections", "logs", "backups", ".aws", ".codex"]);
const forbiddenRuntime = /(?:ai-review|planning-service|plan-history-store|public-productivity-store|(?:^|\/)server)\.js$/u;
const safeBuiltins = new Set(["node:crypto", "node:fs/promises", "node:path", "node:url"]);
const knownDependencies = new Set(["@modelcontextprotocol/sdk", "express", "express-openid-connect", "jose", "pg", "zod"]);
const modelSignals = /\b(?:OPENAI_API_KEY|OPENAI_BASE_URL|OPENAI_MODEL|GPT_REVIEW_API_KEY|GPT_REVIEW_MODEL|GPT_REVIEW_BASE_URL)\b|api\.openai\.com|\/v1\/(?:responses|chat\/completions)|\.{1,2}\/\.env\b|\b(?:new\s+(?:ProductivityStore|PlanHistoryStore)|dotenv\b|loadEnvFile\s*\()/u;

function issue(message) { return new Error(`发布前检查失败：${message}`); }
function lineAt(text, index) { return text.slice(0, index).split("\n").length; }
function synthetic(value) {
  return /^(?:test(?:[-_:]|$)|fixture(?:[-_:]|$)|synthetic(?:[-_:]|$)|example(?:[-_:]|$)|not[-_]a[-_]real[-_]|\$\{|<|YOUR_|REPLACE_|CHANGE_)/iu.test(value)
    || /^(?:A|B){32,}$/u.test(value);
}

function scanText(name, text) {
  // Diagnostics identify a location only: never echo the matching credential.
  const patterns = [
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/gu,
    /\b(?:sk-[A-Za-z0-9_-]{20,}|sk_(?:live|test)_[A-Za-z0-9]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[A-Z0-9]{16})\b/gu,
    /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\b/gu,
    /\b[A-Za-z]:[\\/][^\s"'<>]+/gu,
    /\/(?:Users|home|mnt\/data)\/[^\s"'<>]+/gu,
  ];
  for (const pattern of patterns) for (const match of text.matchAll(pattern)) {
    if (name.startsWith("test/") && synthetic(match[0])) continue;
    throw issue(`${name}:${lineAt(text, match.index)} 含疑似凭据、私钥或本机绝对路径`);
  }
  const assignments = /\b(?:api[_-]?key|client[_-]?secret|session[_-]?secret|password|access[_-]?token|refresh[_-]?token)\s*[:=]\s*["']([^"'\r\n]+)["']/giu;
  for (const match of text.matchAll(assignments)) {
    if (!synthetic(match[1])) throw issue(`${name}:${lineAt(text, match.index)} 含硬编码敏感配置`);
  }
  const envAssignments = /^[ \t]*(?:[A-Z0-9_]+_)?(?:API_KEY|CLIENT_SECRET|SESSION_SECRET|PASSWORD|TOKEN|DATABASE_URL)=[ \t]*([^\r\n]+)/gmu;
  for (const match of text.matchAll(envAssignments)) {
    const value = match[1].trim().replace(/^["']|["']$/gu, "");
    if (value && !synthetic(value)) throw issue(`${name}:${lineAt(text, match.index)} 含硬编码环境凭据`);
  }
  const databaseUrls = /postgres(?:ql)?:\/\/([^\s/@:"']+):([^\s/@"']+)@([^\s/"']+)/giu;
  for (const match of text.matchAll(databaseUrls)) {
    const example = ["test", "example", "user"].includes(match[1]) && ["test", "example", "password"].includes(match[2])
      && /^(?:localhost(?::\d+)?|127\.0\.0\.1(?::\d+)?|[^/]*\.example(?::\d+)?)$/u.test(match[3]);
    if (!example) throw issue(`${name}:${lineAt(text, match.index)} 含带凭据的数据库地址`);
  }
  if (name === ".env.example") {
    for (const [index, line] of text.split(/\r?\n/u).entries()) {
      if (!line.trim() || line.trimStart().startsWith("#")) continue;
      if (!/^[A-Z][A-Z0-9_]*=\s*$/u.test(line)) throw issue(`.env.example:${index + 1} 只能包含空值配置项和注释`);
    }
  }
}

function importsOf(text) {
  const imports = [];
  const pattern = /(?:\b(?:import|export)\s+(?:[^;"']*?\s+from\s*)?["']([^"']+)["'])/gu;
  for (const match of text.matchAll(pattern)) imports.push(match[1]);
  if (/\b(?:import|require)\s*\(/u.test(text)) throw issue("公开运行时禁止动态导入或 require 回退；请显式审核静态依赖");
  return imports;
}

export async function inspectRelease(directory) {
  const root = path.resolve(directory);
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw issue("发布根目录必须为真实目录");
  const contents = new Map();
  async function visit(relative = "") {
    const entries = await readdir(path.join(root, relative), { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, "en"))) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      const absolute = path.join(root, ...name.split("/"));
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) throw issue(`${JSON.stringify(name)} 为符号链接或重解析链接`);
      // Neither dependency caches nor Git internals are traversed, read or hashed.
      if (!relative && skippedRoots.has(entry.name) && info.isDirectory()) continue;
      if (forbiddenNames.has(entry.name.toLowerCase()) || (/^\.env(?:\.|$)/iu.test(entry.name) && name !== ".env.example")) {
        throw issue(`${JSON.stringify(name)} 是不允许发布的凭据或私人资料路径（未读取内容）`);
      }
      if (info.isDirectory()) {
        if (!allowedDirectories.has(name)) throw issue(`未审核目录 ${JSON.stringify(name)}（未读取内容）`);
        await visit(name);
      } else {
        if (!info.isFile() || !allowed.has(name)) throw issue(`未审核文件 ${JSON.stringify(name)}（未读取内容）`);
        if (info.size > 2 * 1024 * 1024) throw issue(`${name} 超过源码文件大小限制`);
        const bytes = await readFile(absolute);
        const text = bytes.toString("utf8");
        if (text.includes("\u0000") || !Buffer.from(text, "utf8").equals(bytes)) throw issue(`${name} 不是可审查的 UTF-8 文本`);
        scanText(name, text);
        contents.set(name, { text, bytes });
      }
    }
  }
  await visit();
  for (const name of requiredFiles) if (!contents.has(name)) throw issue(`缺少发布所需文件 ${name}`);
  let pkg;
  try { pkg = JSON.parse(contents.get("package.json").text); } catch { throw issue("package.json 不是有效 JSON"); }
  if (pkg.license !== "MIT") throw issue("开源包的 license 必须为 MIT");
  const licenseText = contents.get("LICENSE").text;
  if (!/^MIT License\r?\n/u.test(licenseText) || !licenseText.includes("Permission is hereby granted, free of charge")
    || !licenseText.includes('THE SOFTWARE IS PROVIDED "AS IS"')) throw issue("LICENSE 缺少 MIT 授权文本");
  if (pkg.scripts?.start !== "node src/public-server.js") throw issue("start 必须固定为 node src/public-server.js，禁止私有/API 回退入口");
  if (pkg.scripts?.migrate !== "node src/migrate-public.js") throw issue("migrate 必须固定为 node src/migrate-public.js");
  if (Object.values(pkg.scripts || {}).some((command) => /(?:dotenv|--env-file|src\/(?:server|ai-review|planning-service)\.js)/u.test(command))) {
    throw issue("发布脚本含 .env 加载、模型 API 或私有服务入口");
  }
  for (const dependency of Object.keys(pkg.dependencies || {})) if (!knownDependencies.has(dependency)) {
    throw issue(`未审核生产依赖 ${JSON.stringify(dependency)}`);
  }
  if (Object.keys(pkg.devDependencies || {}).some((name) => /(?:openai|anthropic|dotenv|langchain)/iu.test(name))) throw issue("开发依赖包含未审核模型 API 或 .env 加载器");
  const visited = new Set();
  function auditRuntime(name) {
    if (visited.has(name)) return;
    visited.add(name);
    if (forbiddenRuntime.test(name)) throw issue(`公开运行时不允许导入 ${name}`);
    const source = contents.get(name)?.text;
    if (source === undefined) throw issue(`公开运行时导入文件缺失或未审核：${name}`);
    if (modelSignals.test(source)) throw issue(`${name} 含模型 API、.env 加载或私有文件存储回退`);
    for (const specifier of importsOf(source)) {
      if (specifier.startsWith(".")) {
        const target = path.posix.normalize(path.posix.join(path.posix.dirname(name), specifier));
        if (target.startsWith("../") || !allowed.has(target)) throw issue(`${name} 导入越界或未审核文件`);
        auditRuntime(target);
      } else if (specifier.startsWith("node:")) {
        if (!safeBuiltins.has(specifier)) throw issue(`${name} 使用未审核系统依赖`);
      } else {
        const dependency = specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0];
        if (!knownDependencies.has(dependency) || !pkg.dependencies?.[dependency]) throw issue(`${name} 使用未审核外部依赖`);
      }
    }
  }
  for (const name of ["src/public-server.js", "src/migrate-public.js", "public/app.js", "public/public-mode.js", "public/chatgpt-ui.js", "public/chatgpt-bridge.js"]) auditRuntime(name);
  const files = [...contents].sort(([a], [b]) => a.localeCompare(b, "en")).map(([name, { bytes }]) => ({
    path: name, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"),
  }));
  return {
    schemaVersion: 2, purpose: "current-public-release-preflight-not-cloud-verification",
    version: pkg.version, sourceDigest: createHash("sha256").update(files.map((file) => `${file.path}\u0000${file.sha256}\n`).join("")).digest("hex"),
    files, runtimeFiles: [...visited].sort(),
    checks: { exactAllowlist: true, noPrivateDataRead: true, staticRuntimeImports: true, credentialScan: true },
    limitations: ["Heuristic secret checks still require human review.", "Cloud login, deployment and live database isolation are not verified by this offline check.", "The older export manifest is provenance only; its hashes are not used as the current baseline."],
  };
}

async function main() {
  if (process.argv.slice(2).some((value) => !["--manifest", "--"].includes(value))) throw issue("仅支持 --manifest；不会自动写入或更新文件");
  const manifest = await inspectRelease(fileURLToPath(new URL("../", import.meta.url)));
  if (process.argv.includes("--manifest")) console.log(JSON.stringify(manifest, null, 2));
  else console.log(`公开版离线发布检查通过：${manifest.files.length} 个审核文件，版本 ${manifest.version}。\n当前 SHA-256 清单：pnpm preflight --manifest\n未读取私人资料、依赖内容或云端，未上传或部署。`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
