import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createLocalProductivityStore } from "../src/local-productivity-store.js";
import { startLocalCatalogEditor } from "../src/local-catalog-web.js";

test("the one-click editor shares the local catalog and accepts only its own browser session", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "workforce-editor-test-"));
  const databasePath = join(directory, "productivity.sqlite");
  const editor = await startLocalCatalogEditor({ store: createLocalProductivityStore({ databasePath }) });
  const observer = createLocalProductivityStore({ databasePath });
  t.after(async () => {
    await editor.close();
    observer.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 5 });
  });

  const url = new URL(editor.url);
  assert.equal(url.hostname, "127.0.0.1");
  const path = "/api/productivity";
  const token = url.hash.slice(1);
  const headers = { "X-CSRF-Token": token, "Content-Type": "application/json", Origin: url.origin };
  const send = (route, method = "GET", value, extraHeaders) => fetch(url.origin + route, {
    method, headers: { ...headers, ...extraHeaders }, body: value === undefined ? undefined : JSON.stringify(value),
  });
  const html = await (await fetch(url.origin)).text();
  assert.ok(html.includes('/local-mode.js') && !html.includes(token));
  for (const asset of ["local-mode.js", "public-mode.js", "styles.css", "app.js", "calendar.js", "plan-visualizations.js", "schedule-charts.js"]) {
    assert.equal((await fetch(url.origin + "/" + asset)).status, 200, asset);
  }
  assert.equal((await fetch(url.origin + path)).status, 403);
  assert.equal((await send(path, "GET", undefined, { Origin: "https://example.invalid" })).status, 403);
  assert.equal((await fetch(url.origin + "/productivity.sqlite")).status, 404);
  const session = await (await send("/api/session")).json();
  assert.equal(session.accessMode, "local");
  assert.equal(session.authenticated, false);
  assert.equal(session.account, null);

  const trench = "/api/productivity/cross-project-41";
  assert.equal(observer.find("cross-project-41").output, 100);
  assert.equal((await send(trench, "PUT", { output: 50 })).status, 200);
  assert.equal(observer.find("cross-project-41").output, 50);
  const demo = { name: "试验段人工修坡", division: "地基与基础", subitem: "土方开挖", category: "普工", unit: "m", output: 25, crew: { 普工: 2 }, mode: "crew_day", status: "confirmed" };
  const created = await send(path, "POST", demo);
  assert.equal(created.status, 201);
  const { saved } = await created.json();
  assert.equal(saved.catalogScope, "local");
  assert.equal(saved.hasLocalOverride, false);
  const route = path + "/" + encodeURIComponent(saved.id);
  assert.equal(observer.find(saved.id).output, 25);
  assert.equal((await send(path, "POST", demo)).status, 409);
  assert.equal((await send(route, "PUT", { output: -1 })).status, 400);
  assert.equal(observer.find(saved.id).output, 25);
  observer.upsert({ id: saved.id, output: 31 });
  const rows = await (await send(path + "?search=" + encodeURIComponent(demo.name))).json();
  assert.deepEqual(rows.items.map((item) => item.output), [31]);
  assert.equal((await send(route, "DELETE")).status, 200);
  assert.equal(observer.find(saved.id), null);
  assert.equal((await send(route, "PUT", { output: 42 })).status, 404);
  assert.equal(observer.find(saved.id), null);
});
