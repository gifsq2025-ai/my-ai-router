import test from "node:test";
import assert from "node:assert/strict";

// A stub of the chrome.* surface the worker touches, installed before the import.
function installChrome() {
  const store = { data: {} };
  const chrome = {
    _store: store,
    _alarms: [],
    _listeners: { message: [], alarm: [], installed: [], startup: [], storage: [] },
    _tabs: [],
    _createdTabs: [],
    _downloads: [],
    runtime: {
      lastError: undefined,
      onMessage: { addListener: (fn) => chrome._listeners.message.push(fn) },
      onInstalled: { addListener: (fn) => chrome._listeners.installed.push(fn) },
      onStartup: { addListener: (fn) => chrome._listeners.startup.push(fn) },
    },
    alarms: {
      create: (name, options) => chrome._alarms.push({ name, ...options }),
      onAlarm: { addListener: (fn) => chrome._listeners.alarm.push(fn) },
    },
    storage: {
      local: {
        async get(keys) {
          const list = Array.isArray(keys) ? keys : [keys];
          return Object.fromEntries(list.filter((k) => k in store.data).map((k) => [k, store.data[k]]));
        },
        async set(obj) {
          Object.assign(store.data, obj);
        },
        async remove(keys) {
          for (const k of Array.isArray(keys) ? keys : [keys]) delete store.data[k];
        },
      },
      onChanged: { addListener: (fn) => chrome._listeners.storage.push(fn) },
    },
    tabs: {
      async query() {
        return chrome._tabs;
      },
      async create(options) {
        const tab = { id: chrome._createdTabs.length + 1, ...options };
        chrome._createdTabs.push(tab);
        return tab;
      },
      async update() {},
      async sendMessage(_id, message) {
        return message?.vva === "player" ? "playing" : { ok: true };
      },
    },
    scripting: { async executeScript() {} },
    downloads: {
      download(options, callback) {
        chrome._downloads.push(options);
        callback(chrome._downloads.length);
      },
    },
  };
  globalThis.chrome = chrome;
  return chrome;
}

const chromeStub = installChrome();
const worker = await import("../background.js");

const okJson = (result) => ({
  ok: true,
  status: 200,
  headers: { get: () => null },
  text: async () => JSON.stringify(result),
  json: async () => result,
});

/** Fetch stub that answers by URL so one client can serve Telegram and Gemini. */
function installFetch(handlers = {}) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    for (const [needle, handler] of Object.entries(handlers)) {
      if (String(url).includes(needle)) return handler(init);
    }
    return okJson({ ok: true, result: [] });
  };
  return calls;
}

test("the worker registers a heartbeat alarm and a message listener", () => {
  assert.ok(chromeStub._alarms.some((a) => a.name === "vva-heartbeat"), "no heartbeat alarm");
  assert.equal(chromeStub._listeners.message.length, 1);
  assert.ok(chromeStub._listeners.alarm.length >= 1);
});

test("VVA_STATUS answers with a summary even before anything exists", async () => {
  const response = await worker.handleMessage({ type: "VVA_STATUS" });
  assert.equal(response.ok, true);
  assert.match(response.summary, /No project yet/);
  assert.equal(response.percent, 0);
  assert.equal(response.stage, "idle");
});

test("an unknown message type is rejected instead of throwing", async () => {
  const response = await worker.handleMessage({ type: "VVA_NOPE" });
  assert.equal(response.ok, false);
  assert.match(response.error, /unknown message type/);
});

test("VVA_OPEN creates a tab per site", async () => {
  chromeStub._createdTabs.length = 0;
  const response = await worker.handleMessage({ type: "VVA_OPEN", names: ["clonevoice", "artistly", "videoexpress"] });
  assert.deepEqual(response.opened, ["clonevoice", "artistly", "videoexpress"]);
  assert.deepEqual(chromeStub._createdTabs.map((t) => new URL(t.url).hostname), [
    "app.clonevoice.ai",
    "app.artistly.ai",
    "app.videoexpress.ai",
  ]);
});

test("VVA_DOWNLOAD hands the URL and filename to the downloads API", async () => {
  chromeStub._downloads.length = 0;
  const response = await worker.handleMessage({ type: "VVA_DOWNLOAD", url: "https://cdn.artistly.ai/a.png", filename: "viral/img_000.png" });
  assert.equal(response.ok, true);
  assert.equal(chromeStub._downloads[0].filename, "viral/img_000.png");
  assert.equal(chromeStub._downloads[0].url, "https://cdn.artistly.ai/a.png");
});

test("VVA_TEST_GEMINI reaches the Gemini endpoint with the header", async () => {
  const calls = installFetch({
    "generateContent": () => okJson({ candidates: [{ content: { parts: [{ text: "OK" }] }, finishReason: "STOP" }] }),
  });
  const response = await worker.handleMessage({ type: "VVA_TEST_GEMINI", apiKey: "k", model: "gemini-2.5-flash" });
  assert.equal(response.ok, true);
  assert.equal(response.text, "OK");
  assert.equal(calls[0].init.headers["x-goog-api-key"], "k");
});

test("VVA_LIST_MODELS returns the names the key can call", async () => {
  installFetch({
    "/models?": () =>
      okJson({ models: [{ name: "models/gemini-2.5-flash", supportedGenerationMethods: ["generateContent"] }] }),
  });
  const response = await worker.handleMessage({ type: "VVA_LIST_MODELS", apiKey: "k" });
  assert.deepEqual(response.models, ["gemini-2.5-flash"]);
});

test("VVA_TEST_TELEGRAM reports the bot username", async () => {
  installFetch({ getMe: () => okJson({ ok: true, result: { id: 1, username: "vva_bot" } }) });
  const response = await worker.handleMessage({ type: "VVA_TEST_TELEGRAM", token: "t" });
  assert.equal(response.username, "vva_bot");
});

test("pollOnce stops cleanly when no token is configured", async () => {
  chromeStub._store.data = {};
  const outcome = await worker.pollOnce();
  assert.deepEqual(outcome, { stop: true });
});

test("pollOnce dispatches an authorised message and advances the offset", async () => {
  chromeStub._store.data = {
    "vva:config": { geminiKey: "k", telegramToken: "tok", chatId: "42", telegramPolling: true },
    "vva:state": { offset: 0 },
  };
  const sent = [];
  installFetch({
    getUpdates: () => okJson({ ok: true, result: [{ update_id: 11, message: { chat: { id: 42 }, text: "/status" } }] }),
    sendMessage: (init) => {
      sent.push(JSON.parse(init.body));
      return okJson({ ok: true, result: { message_id: 1 } });
    },
  });

  const outcome = await worker.pollOnce();
  assert.deepEqual(outcome, {});
  assert.equal(chromeStub._store.data["vva:state"].offset, 12, "the offset must advance or the update replays forever");
  assert.ok(sent.some((m) => /No project yet/.test(m.text)), "the /status reply should have been sent");
});

test("pollOnce refuses a message from an unauthorised chat and tells them their id", async () => {
  chromeStub._store.data = {
    "vva:config": { telegramToken: "tok", chatId: "42", telegramPolling: true },
    "vva:state": { offset: 0 },
  };
  const sent = [];
  installFetch({
    getUpdates: () => okJson({ ok: true, result: [{ update_id: 5, message: { chat: { id: 999 }, text: "/status" } }] }),
    sendMessage: (init) => {
      sent.push(JSON.parse(init.body));
      return okJson({ ok: true, result: {} });
    },
  });
  await worker.pollOnce();
  const rejection = sent.find((m) => m.chat_id === 999);
  assert.ok(rejection, "the stranger should be told no");
  assert.match(rejection.text, /999/);
});

test("a 409 conflict is recorded with the fix, not thrown", async () => {
  chromeStub._store.data = {
    "vva:config": { telegramToken: "tok", chatId: "42", telegramPolling: true },
    "vva:state": { offset: 0 },
  };
  installFetch({
    getUpdates: () => ({
      ok: false,
      status: 409,
      headers: { get: () => null },
      json: async () => ({ ok: false, error_code: 409, description: "Conflict: terminated by other getUpdates request" }),
      text: async () => "",
    }),
  });
  const outcome = await worker.pollOnce();
  assert.equal(outcome.backoff, 15000);
  assert.match(chromeStub._store.data["vva:state"].lastError, /Render bot/);
});

test("a rejected token turns polling off instead of retrying forever", async () => {
  chromeStub._store.data = {
    "vva:config": { telegramToken: "bad", chatId: "42", telegramPolling: true },
    "vva:state": { offset: 0 },
  };
  installFetch({
    getUpdates: () => ({
      ok: false,
      status: 401,
      headers: { get: () => null },
      json: async () => ({ ok: false, error_code: 401, description: "Unauthorized" }),
      text: async () => "",
    }),
  });
  const outcome = await worker.pollOnce();
  assert.equal(outcome.stop, true);
  assert.equal(chromeStub._store.data["vva:config"].telegramPolling, false);
});

test("resumeIfNeeded restarts a run the worker was killed during", async () => {
  chromeStub._store.data = {
    "vva:config": { geminiKey: "k", telegramToken: "tok", chatId: "42", telegramPolling: false, topicCount: 5 },
    "vva:state": { auto: true, chatId: "42", runningStage: "topics", runningSince: Date.now() - 10 * 60 * 1000 },
    "vva:project": { stage: "idle", niche: "habits", topics: [], picked: "", script: "", lines: [], prompts: [], promptBatch: 0 },
  };
  const calls = installFetch({
    generateContent: () =>
      okJson({ candidates: [{ content: { parts: [{ text: "1. Alpha\n2. Beta\n3. Gamma" }] }, finishReason: "STOP" }] }),
    sendMessage: () => okJson({ ok: true, result: {} }),
    sendDocument: () => okJson({ ok: true, result: {} }),
    sendChatAction: () => okJson({ ok: true, result: {} }),
  });

  const resumed = await worker.resumeIfNeeded();
  assert.equal(resumed, true);

  const started = Date.now();
  while (worker.router.isRunning() && Date.now() - started < 5000) await new Promise((r) => setTimeout(r, 5));

  assert.ok(calls.some((c) => c.url.includes("generateContent")), "the resumed run should call Gemini again");
  const project = chromeStub._store.data["vva:project"];
  assert.deepEqual(project.topics, ["Alpha", "Beta", "Gamma"]);
  assert.equal(chromeStub._store.data["vva:state"].runningStage, null, "the lock must be released");
});

test("resumeIfNeeded leaves a freshly started run alone", async () => {
  chromeStub._store.data = {
    "vva:config": { telegramToken: "tok", chatId: "42" },
    "vva:state": { auto: true, chatId: "42", runningStage: "script", runningSince: Date.now() },
    "vva:project": { stage: "topics", topics: ["a"], picked: "a", script: "", lines: [], prompts: [] },
  };
  assert.equal(await worker.resumeIfNeeded(), false, "a stage started seconds ago is not stale");
});

test("resumeIfNeeded does nothing when auto is off", async () => {
  chromeStub._store.data = {
    "vva:config": { telegramToken: "tok", chatId: "42" },
    "vva:state": { auto: false, chatId: "42" },
    "vva:project": { stage: "idle", niche: "x" },
  };
  assert.equal(await worker.resumeIfNeeded(), false);
});
