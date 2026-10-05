import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRouter } from "../extension/src/router.js";
import { fileStore } from "./filestore.mjs";
import { grammyTelegram } from "./grammy-adapter.mjs";
import { mobileBrowser } from "./mobile-browser.mjs";

const LONG_SCRIPT = Array.from({ length: 300 }, (_, i) => `word${i}`).join(" ");

function fakeGemini() {
  const generate = async ({ prompt }) => {
    const cues = [...prompt.matchAll(/^\[(\d{1,2}:\d{1,2})\]\s(.+)$/gm)];
    let text;
    if (prompt.includes("viral YouTube strategist")) text = Array.from({ length: 5 }, (_, i) => `${i + 1}. Title ${i + 1}`).join("\n");
    else if (prompt.includes("YouTube narration script")) text = LONG_SCRIPT;
    else if (prompt.includes("Split this narration")) text = Array.from({ length: 45 }, (_, i) => `[${String(Math.floor(i / 10)).padStart(2, "0")}:${String((i * 6) % 60).padStart(2, "0")}] line ${i}`).join("\n");
    else if (prompt.includes("doodle-style illustration")) text = cues.map((m) => `[${m[1]}] | scene ${m[2].slice(0, 20)}`).join("\n");
    else if (prompt.includes("YouTube metadata")) text = "TITLE: Mobile title\nDESCRIPTION:\nHook.\nBody.\n#a #b\nTAGS: a, b";
    else if (prompt.includes("1280x720")) text = "thumb prompt";
    else text = "OK";
    return { text, finishReason: "STOP", images: [] };
  };
  return { generate };
}

async function settle(router, timeoutMs = 8000) {
  const started = Date.now();
  while (router.isRunning() && Date.now() - started < timeoutMs) await new Promise((r) => setTimeout(r, 5));
  if (router.isRunning()) throw new Error("did not settle");
}

test("the mobile (Telegram) path runs the whole pipeline and delivers real files", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vva-mobile-"));
  const store = fileStore(join(dir, "state.json"));
  await store.setConfig({ geminiKey: "k", chatId: "42", telegramPolling: false, autoOpenTabs: false });

  const calls = [];
  const api = {
    sendMessage: async (chat, text) => calls.push({ method: "sendMessage", chat, text }),
    sendDocument: async (chat, file) => calls.push({ method: "sendDocument", chat, name: file.name }),
    sendChatAction: async () => {},
  };
  const telegram = grammyTelegram({ api, makeInputFile: (buf, name) => ({ buf, name }) });
  const photos = [];
  const browser = mobileBrowser({ telegram, chatProvider: () => 42, sendPhoto: async (c, b, n) => photos.push(n) });
  const router = createRouter({ store, telegram, gemini: fakeGemini(), browser });

  await router.handle(42, "/topics habits");
  await settle(router);
  await router.handle(42, "1");
  await settle(router);
  await router.handle(42, "/approve");
  await settle(router);

  const project = await store.getProject();
  assert.equal(project.stage, "done");

  const docs = calls.filter((c) => c.method === "sendDocument").map((c) => c.name);
  for (const expected of ["script.txt", "timestamps.txt", "image_prompts.txt", "captions.srt", "metadata.txt"]) {
    assert.ok(docs.includes(expected), `missing ${expected} in ${docs.join(", ")}`);
  }
  // The state file on disk matches, so a Render restart resumes cleanly.
  assert.equal((await store.getProject()).meta.title, "Mobile title");
});
