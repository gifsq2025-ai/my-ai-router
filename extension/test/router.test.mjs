import test from "node:test";
import assert from "node:assert/strict";
import { createRouter } from "../src/router.js";
import { memoryStore } from "../src/store.js";

const LONG_SCRIPT = Array.from({ length: 300 }, (_, i) => `word${i}`).join(" ");

function fakeGemini() {
  const calls = [];
  const generate = async ({ prompt, model, apiKey }) => {
    calls.push({ prompt, model, apiKey });
    const cues = [...prompt.matchAll(/^\[(\d{1,2}:\d{1,2})\]\s(.+)$/gm)];
    let text;
    if (prompt.includes("viral YouTube strategist")) {
      text = Array.from({ length: 5 }, (_, i) => `${i + 1}. Title number ${i + 1} about the brain`).join("\n");
    } else if (prompt.includes("YouTube narration script")) text = LONG_SCRIPT;
    else if (prompt.includes("Split this narration")) {
      text = Array.from({ length: 45 }, (_, i) => `[${String(Math.floor(i / 10)).padStart(2, "0")}:${String((i * 6) % 60).padStart(2, "0")}] narration line ${i}`).join("\n");
    } else if (prompt.includes("doodle-style illustration")) {
      text = cues.map((m) => `[${m[1]}] | stick figure scene for: ${m[2].slice(0, 30)}`).join("\n");
    } else if (prompt.includes("YouTube metadata")) {
      text = "TITLE: Why your brain lies to you\nDESCRIPTION:\nHook line.\nBody.\n#brain #mind\nTAGS: brain, mind, habits";
    } else if (prompt.includes("1280x720")) text = "thumbnail prompt here";
    else text = "OK";
    return { text, finishReason: "STOP", images: [] };
  };
  return { calls, generate, fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ models: [] }) }) };
}

function harness(config = {}) {
  const store = memoryStore({ "vva:config": { geminiKey: "key", telegramToken: "tok", chatId: "42", ...config } });
  const sent = [];
  const files = [];
  const opened = [];
  const telegram = {
    sendText: async (chatId, text) => sent.push({ chatId, text }),
    sendDocument: async (chatId, filename, content) => files.push({ chatId, filename, content }),
    sendChatAction: async () => {},
  };
  const browser = {
    openSites: async (names) => opened.push(...names),
    notifySite: async () => ({ ok: true }),
    sendToActiveTab: async (message) => (message.tool === "get_captions" ? "[0s] something about focus" : "playing"),
    downloadDataUrl: async () => ({ ok: true }),
  };
  const gemini = fakeGemini();
  const router = createRouter({ store, telegram, gemini, browser, log: () => {} });
  const text = () => sent.map((m) => m.text).join("\n");
  return { store, sent, files, opened, gemini, router, text };
}

async function settle(router, timeoutMs = 8000) {
  const started = Date.now();
  while (router.isRunning() && Date.now() - started < timeoutMs) await new Promise((r) => setTimeout(r, 5));
  if (router.isRunning()) throw new Error("pipeline did not finish in time");
}

test("/start explains the commands", async () => {
  const h = harness();
  await h.router.handle(42, "/start");
  assert.match(h.text(), /\/topics <niche>/);
});

test("/help and /start are the same thing", async () => {
  const h = harness();
  await h.router.handle(42, "/help");
  assert.match(h.text(), /\/approve/);
});

test("/topics generates titles and stops for a human decision", async () => {
  const h = harness();
  await h.router.handle(42, "/topics human psychology");
  await settle(h.router);

  const project = await h.store.getProject();
  assert.equal(project.topics.length, 5);
  assert.equal(project.stage, "topics");
  assert.equal(project.script, "", "must not write the script before the user picks");
  assert.match(h.text(), /Reply with a number/);
});

test("a bare number picks that title and writes only the script", async () => {
  const h = harness();
  await h.router.handle(42, "/topics habits");
  await settle(h.router);
  await h.router.handle(42, "3");
  await settle(h.router);

  const project = await h.store.getProject();
  assert.equal(project.picked, "Title number 3 about the brain");
  assert.ok(project.script.length > 500);
  assert.equal(project.lines.length, 0, "timestamps wait for /approve");
  assert.ok(h.files.some((f) => f.filename === "script.txt"), "the script is sent as a file");
  assert.match(h.text(), /Send \/approve/);
});

test("a number outside the list is rejected", async () => {
  const h = harness();
  await h.router.handle(42, "/topics habits");
  await settle(h.router);
  await h.router.handle(42, "9");
  assert.match(h.text(), /between 1 and 5/);
});

test("picking before generating topics says so", async () => {
  const h = harness();
  await h.router.handle(42, "2");
  assert.match(h.text(), /No topics yet/);
});

test("/approve runs the rest of the pipeline and delivers every artefact", async () => {
  const h = harness();
  await h.router.handle(42, "/topics habits");
  await settle(h.router);
  await h.router.handle(42, "1");
  await settle(h.router);
  await h.router.handle(42, "/approve");
  await settle(h.router);

  const project = await h.store.getProject();
  assert.equal(project.stage, "done");
  assert.equal(project.lines.length, 45);
  assert.equal(project.prompts.length, 45);
  assert.match(project.srt, /^1\n00:00:00,000 --> /);
  assert.equal(project.meta.title, "Why your brain lies to you");

  const names = h.files.map((f) => f.filename);
  for (const expected of ["script.txt", "timestamps.txt", "image_prompts.txt", "captions.srt", "metadata.txt"]) {
    assert.ok(names.includes(expected), `missing ${expected} in ${names.join(", ")}`);
  }
});

test("finishing publishes the image queue and opens the three tools", async () => {
  const h = harness();
  await h.router.handle(42, "/topics habits");
  await settle(h.router);
  await h.router.handle(42, "1");
  await settle(h.router);
  await h.router.handle(42, "/approve");
  await settle(h.router);

  const queue = await h.store.getQueue();
  assert.ok(queue.clonevoice.text.length > 500, "CloneVoice gets the script");
  assert.equal(queue.artistly.items.length, 45);
  assert.equal(queue.artistly.cursor, 0);
  assert.deepEqual(h.opened, ["clonevoice", "artistly", "videoexpress"]);
  assert.match(h.text(), /Done\. Files sent above\./);
});

test("/approve on a fresh project refuses to guess a niche", async () => {
  const h = harness();
  await h.router.handle(42, "/approve");
  assert.match(h.text(), /Nothing to run/);
});

test("/status reports where the project is", async () => {
  const h = harness();
  await h.router.handle(42, "/status");
  assert.match(h.text(), /No project yet/);
  await h.router.handle(42, "/topics habits");
  await settle(h.router);
  await h.router.handle(42, "/status");
  assert.match(h.text(), /Stage: topics/);
});

test("/stop halts an approved run at the next stage", async () => {
  const h = harness();
  await h.router.handle(42, "/topics habits");
  await settle(h.router);
  await h.router.handle(42, "1");
  await settle(h.router);
  await h.router.handle(42, "/approve");
  await h.router.handle(42, "/stop");
  await settle(h.router);
  const state = await h.store.getState();
  assert.equal(state.auto, false);
});

test("a Gemini failure is reported and the project stays resumable", async () => {
  const h = harness();
  h.gemini.generate = async () => {
    throw new Error("model exploded");
  };
  await h.router.handle(42, "/topics habits");
  await settle(h.router);
  assert.match(h.text(), /model exploded/);
  assert.match(h.text(), /send \/approve to resume/);
  const project = await h.store.getProject();
  assert.equal(project.error, "model exploded");
});

test("/script, /srt and friends say so when nothing is built yet", async () => {
  const h = harness();
  await h.router.handle(42, "/srt");
  assert.match(h.text(), /Not built yet/);
});

test("/open validates site names", async () => {
  const h = harness();
  await h.router.handle(42, "/open nonsense");
  assert.match(h.text(), /Unknown site: nonsense/);
  await h.router.handle(42, "/open artistly");
  assert.deepEqual(h.opened, ["artistly"]);
});

test("/queue reports progress from the artistly cursor", async () => {
  const h = harness();
  await h.router.handle(42, "/topics habits");
  await settle(h.router);
  await h.router.handle(42, "1");
  await settle(h.router);
  await h.router.handle(42, "/approve");
  await settle(h.router);

  const queue = await h.store.getQueue();
  await h.store.setQueue({ ...queue, artistly: { ...queue.artistly, cursor: 7, status: "running" } });
  await h.router.handle(42, "/queue");
  assert.match(h.text(), /Progress: 7\/45/);
});

test("/pause and /resume flip the loop status", async () => {
  const h = harness();
  await h.router.handle(42, "/topics habits");
  await settle(h.router);
  await h.router.handle(42, "1");
  await settle(h.router);
  await h.router.handle(42, "/approve");
  await settle(h.router);

  await h.router.handle(42, "/pause");
  assert.equal((await h.store.getQueue()).artistly.status, "paused");
  await h.router.handle(42, "/resume");
  assert.equal((await h.store.getQueue()).artistly.status, "running");
});

test("/model and /imagemodel change what the next call uses", async () => {
  const h = harness();
  await h.router.handle(42, "/model gemini-2.5-pro");
  assert.equal((await h.store.getConfig()).geminiModel, "gemini-2.5-pro");
  await h.router.handle(42, "/topics habits");
  await settle(h.router);
  assert.equal(h.gemini.calls[0].model, "gemini-2.5-pro");
});

test("/test calls Gemini and reports the answer", async () => {
  const h = harness();
  await h.router.handle(42, "/test");
  assert.match(h.text(), /Gemini .* works/);
});

test("/video forwards a tool call to the active tab", async () => {
  const h = harness();
  await h.router.handle(42, "/video play");
  assert.match(h.text(), /playing/);
});

test("/ask answers from the active tab's captions", async () => {
  const h = harness();
  await h.router.handle(42, "/ask what does he say?");
  const captionsCall = h.gemini.calls.find((c) => c.prompt.includes("something about focus"));
  assert.ok(captionsCall, "the transcript should reach Gemini");
});

test("/reset clears the project", async () => {
  const h = harness();
  await h.router.handle(42, "/topics habits");
  await settle(h.router);
  await h.router.handle(42, "/reset");
  assert.equal((await h.store.getProject()).stage, "idle");
});

test("an unknown command points at /help", async () => {
  const h = harness();
  await h.router.handle(42, "/frobnicate");
  assert.match(h.text(), /Unknown command/);
});

test("the Gemini key from storage is passed through", async () => {
  const h = harness({ geminiKey: "my-special-key" });
  await h.router.handle(42, "/topics habits");
  await settle(h.router);
  assert.equal(h.gemini.calls[0].apiKey, "my-special-key");
});
