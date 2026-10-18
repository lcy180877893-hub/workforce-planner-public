import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { inspectRelease, RELEASE_FILES } from "../scripts/release-preflight.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "workforce-release-fixture-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const put = async (name, content) => {
    const file = path.join(root, name); await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content, "utf8");
  };
  // Every byte is synthetic. Never copy a real repository, environment or personal data.
  for (const name of RELEASE_FILES) await put(name, name.endsWith(".js") || name.endsWith(".mjs") ? "export {};\n" : "# synthetic release fixture\n");
  await put(".env.example", "# Blank placeholders only\nDATABASE_URL=\nSESSION_SECRET=\n");
  await put("package.json", JSON.stringify({ name: "release-fixture", version: "0.0.0-test", type: "module",
    scripts: { start: "node src/public-server.js", migrate: "node src/migrate-public.js", preflight: "node scripts/release-preflight.mjs" },
    dependencies: { express: "5.3.0" },
  }));
  return { root, put };
}

test("current manifest hashes reviewed files without trusting the stale export baseline", async (t) => {
  const f = await fixture(t);
  await f.put("release-manifest.json", JSON.stringify({ schemaVersion: 1, sourceDigest: "stale", sourceFiles: [] }));
  const first = await inspectRelease(f.root);
  assert.equal(first.schemaVersion, 2);
  assert.equal(first.files.length, RELEASE_FILES.length);
  assert.ok(first.files.every((file) => /^[a-f0-9]{64}$/u.test(file.sha256)));
  assert.deepEqual(first.runtimeFiles, ["public/app.js", "public/chatgpt-bridge.js", "public/chatgpt-ui.js", "public/public-mode.js", "src/migrate-public.js", "src/public-server.js"]);
  await f.put("README.md", "Updated synthetic release documentation.\n");
  const next = await inspectRelease(f.root);
  assert.notEqual(first.sourceDigest, next.sourceDigest);
  assert.notEqual(first.files.find((file) => file.path === "README.md").sha256, next.files.find((file) => file.path === "README.md").sha256);
});

test("dependency and git directories are never traversed, read or included in hashes", async (t) => {
  const f = await fixture(t);
  await f.put("node_modules/unreviewed/.env", "synthetic-unread\n");
  await f.put(".git/config", "synthetic-unread\n");
  const manifest = await inspectRelease(f.root);
  assert.ok(!manifest.files.some((file) => /(?:node_modules|\.git\/)/u.test(file.path)));
});

test("unexpected files, real environment names and private directories fail before reading contents", async (t) => {
  for (const name of ["unexpected.txt", ".env", ".env.local", "data/saved-history.json", "sources/input.xlsx", "connection/tunnel.json"]) {
    await t.test(name, async (st) => {
      const f = await fixture(st); await f.put(name, "This unreviewed content must not be read.\n");
      await assert.rejects(inspectRelease(f.root), /未读取内容/u);
    });
  }
});

test("symbolic links are rejected including a dependency cache link", async (t) => {
  const f = await fixture(t);
  // A directory junction is unprivileged on Windows and remains a link at lstat.
  try { await symlink(path.join(f.root, "public"), path.join(f.root, "node_modules"), process.platform === "win32" ? "junction" : "dir"); }
  catch (error) { if (["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) return t.skip("Host disallows creating synthetic links"); throw error; }
  await assert.rejects(inspectRelease(f.root), /符号链接/u);
});

test("hardcoded keys, credentials and local absolute paths fail without echoing the value", async (t) => {
  const fakeKey = "ghp_" + "x".repeat(36);
  const fakeMachinePath = "C:/" + "Users/synthetic/Desktop/app";
  const samples = [fakeKey, fakeMachinePath, "postgresql:" + "//alice:secret-value@database.invalid/project", "const client" + "Secret = 'unreviewed-credential';",
    "SESSION_" + "SECRET=unreviewed-credential", "-----BEGIN " + "PRIVATE KEY-----"];
  for (const content of samples) {
    const f = await fixture(t); await f.put("README.md", content);
    await assert.rejects(inspectRelease(f.root), (error) => {
      assert.match(error.message, /README\.md:/u); assert.ok(!error.message.includes(content)); return true;
    });
  }
});

test("environment example contains only blank values, not real or plausible sample secrets", async (t) => {
  const f = await fixture(t); await f.put(".env.example", "SESSION_SECRET=not-blank\n");
  await assert.rejects(inspectRelease(f.root), /只能包含空值|硬编码环境凭据/u);
});

test("public start is fixed and neither script nor runtime can activate legacy or model fallbacks", async (t) => {
  const cases = [
    ["package.json", JSON.stringify({ scripts: { start: "node src/server.js", migrate: "node src/migrate-public.js" } }), /start 必须固定/u],
    ["src/public-server.js", "import './plan-history-store.js';\n", /导入越界或未审核/u],
    ["src/public-server.js", "import '../unreviewed.js';\n", /导入越界或未审核/u],
    ["src/public-server.js", "const key = process.env['OPENAI_' + 'API_KEY']; import('arbitrary-package');\n", /动态导入/u],
    ["src/public-server.js", "const store = new ProductivityStore();\n", /私有文件存储回退/u],
    ["src/public-server.js", "import dotenv from 'dotenv';\n", /模型 API、.env 加载/u],
    ["src/public-server.js", "const secret = readFile(new URL('../.env', import.meta.url));\n", /模型 API、.env 加载/u],
    ["src/server.js", "import express from 'express';\n", /未审核文件/u],
  ];
  for (const [file, content, expected] of cases) {
    const f = await fixture(t); await f.put(file, content);
    await assert.rejects(inspectRelease(f.root), expected);
  }
});

test("reviewed local imports are hashed and followed, but the validator does not instantiate private stores", async (t) => {
  const f = await fixture(t);
  await f.put("src/public-server.js", "import './cloud-stores.js';\n");
  await f.put("src/cloud-stores.js", "import { validateEntry } from './productivity-store.js';\nexport { validateEntry };\n");
  await f.put("src/productivity-store.js", "export function validateEntry(value) { return value; }\n");
  const manifest = await inspectRelease(f.root);
  assert.ok(manifest.runtimeFiles.includes("src/productivity-store.js"));
  assert.ok(manifest.runtimeFiles.includes("src/cloud-stores.js"));
});
