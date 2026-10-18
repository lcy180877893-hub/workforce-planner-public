import test from "node:test";
import assert from "node:assert/strict";
import { Script } from "node:vm";
import { readFile } from "node:fs/promises";
import { buildWorkforceUI, WORKFORCE_UI_URI, WORKFORCE_UI_MIME, uiResourceMetadata } from "../src/chatgpt-ui.js";

test("内嵌界面复用四页网站并将所有资源内联，不连接外部域名", async () => {
  const html = await buildWorkforceUI();
  assert.equal(WORKFORCE_UI_URI, "ui://workforce/planner-v0.18.0.html");
  assert.equal(WORKFORCE_UI_MIME, "text/html;profile=mcp-app");
  for (const id of ["planner", "ratios", "history", "library"]) assert.ok(html.includes(`id="${id}"`));
  assert.match(html, /data-chatgpt-app="true"/);
  assert.doesNotMatch(html, /<script[^>]*\bsrc=/i);
  assert.doesNotMatch(html, /<link[^>]*\brel="stylesheet"/i);
  assert.doesNotMatch(html, /<iframe\b/i);
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length, 3);
  for (const [, script] of scripts) assert.doesNotThrow(() => new Script(script));
  assert.deepEqual(uiResourceMetadata.ui.csp, { connectDomains: [], resourceDomains: [], frameDomains: [] });
});

test("独立网站不加载ChatGPT连接层，继续保留原网站入口", async () => {
  const index = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  assert.match(index, /src="\/app\.js\?v=/);
  assert.match(index, /href="\/styles\.css\?v=/);
  assert.doesNotMatch(index, /chatgpt-bridge\.js|data-chatgpt-app/);
});
