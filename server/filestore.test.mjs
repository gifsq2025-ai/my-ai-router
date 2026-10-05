import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileStore } from "./filestore.mjs";

const dir = mkdtempSync(join(tmpdir(), "vva-"));
const path = join(dir, "state.json");

test("setConfig merges defaults and persists to disk", async () => {
  const store = fileStore(path);
  const next = await store.setConfig({ geminiKey: "k" });
  const onDisk = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(onDisk["vva:config"].geminiKey, "k");
  assert.equal(next.geminiKey, "k");
  // Unset fields fall back to defaults rather than disappearing.
  assert.equal(next.downloadFolder, "viral");
});

test("a second store instance reads what the first wrote", async () => {
  const first = fileStore(path);
  await first.setProject({ stage: "topics", topics: ["a"] });
  const second = fileStore(path);
  assert.equal((await second.getProject()).stage, "topics");
});

test("patchProject merges without losing earlier fields", async () => {
  const store = fileStore(path);
  await store.setProject({ stage: "topics", niche: "habits" });
  await store.patchProject({ stage: "script" });
  const project = await store.getProject();
  assert.equal(project.stage, "script");
  assert.equal(project.niche, "habits");
});

test("setProject(null) clears the project", async () => {
  const store = fileStore(path);
  await store.setProject({ stage: "done" });
  await store.setProject(null);
  assert.equal(await store.getProject(), null);
});

test("state and queue round-trip", async () => {
  const store = fileStore(path);
  await store.setState({ auto: true, chatId: "1" });
  await store.setQueue({ clonevoice: { text: "hi" }, artistly: null });
  assert.equal((await store.getState()).auto, true);
  assert.equal((await store.getQueue()).clonevoice.text, "hi");
});

test("a corrupt file starts empty instead of crashing the bot", async () => {
  const bad = join(dir, "bad.json");
  const { writeFileSync } = await import("node:fs");
  writeFileSync(bad, "{not json");
  const store = fileStore(bad);
  assert.equal(await store.getProject(), null);
  assert.ok(existsSync(bad));
});
