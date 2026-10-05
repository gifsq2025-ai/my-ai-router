// MV3 service worker: Telegram polling, pipeline driver, downloads, tab control.
//
// Chrome can terminate this worker at any moment, so nothing important lives in memory.
// The project, the image queue and the poll offset are all in chrome.storage, and each
// pipeline stage is persisted before the next one starts — a restart resumes rather than
// losing a 3 minute run.
import { TelegramClient, verifyToken } from "./src/telegram.js";
import { DEFAULT_MODEL, generate as geminiGenerate, listModels } from "./src/gemini.js";
import { chromeStore, emptyProject, projectSummary } from "./src/store.js";
import { createRouter, SITES } from "./src/router.js";
import { nextRunnableStage, progressPercent } from "./src/pipeline.js";

const store = chromeStore();
const log = (...args) => console.log("[vva]", ...args);

const CONTENT_FILES = ["content/dom.js", "content/sites.js", "content/player.js", "content/content.js"];

// ---------- Telegram (token can change at runtime, so the client is resolved per call) ----------

let clientCache = null;
let clientToken = null;

async function telegramClient() {
  const config = await store.getConfig();
  if (!config.telegramToken) throw new Error("No Telegram bot token configured.");
  if (!clientCache || clientToken !== config.telegramToken) {
    clientCache = new TelegramClient({ token: config.telegramToken, logger: log });
    clientToken = config.telegramToken;
  }
  return clientCache;
}

const telegram = {
  sendText: (chatId, text) => telegramClient().then((c) => c.sendText(chatId, text)),
  sendDocument: (chatId, filename, content) => telegramClient().then((c) => c.sendDocument(chatId, filename, content)),
  sendChatAction: (chatId, action) => telegramClient().then((c) => c.sendChatAction(chatId, action)),
};

// ---------- browser side ----------

const browser = {
  async openSites(names) {
    const opened = [];
    for (const name of names) {
      const url = SITES[name];
      if (!url) continue;
      const origin = new URL(url).origin;
      const existing = await chrome.tabs.query({ url: `${origin}/*` });
      if (existing[0]) await chrome.tabs.update(existing[0].id, { active: false });
      else await chrome.tabs.create({ url, active: false });
      opened.push(name);
    }
    // Let the SPA hydrate before the content script starts hunting for inputs.
    await new Promise((resolve) => setTimeout(resolve, 3000));
    return opened;
  },

  /** Message an open site tab, injecting the content script first if it loaded before us. */
  async notifySite(name, message) {
    const url = SITES[name];
    if (!url) return { ok: false, error: `unknown site ${name}` };
    const origin = new URL(url).origin;
    const [tab] = await chrome.tabs.query({ url: `${origin}/*` });
    if (!tab) return { ok: false, error: `no ${name} tab open` };
    try {
      return { ok: true, result: await chrome.tabs.sendMessage(tab.id, message) };
    } catch {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: CONTENT_FILES });
      return { ok: true, result: await chrome.tabs.sendMessage(tab.id, message), injected: true };
    }
  },

  async sendToActiveTab(message) {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab) return "no active tab";
    try {
      const result = await chrome.tabs.sendMessage(tab.id, message);
      return result ?? "no video on this page";
    } catch {
      return "cannot reach that page - reload the tab so the content script attaches";
    }
  },

  download({ url, filename }) {
    return new Promise((resolve) => {
      chrome.downloads.download({ url, filename, conflictAction: "uniquify", saveAs: false }, (id) => {
        const error = chrome.runtime.lastError?.message;
        if (error) {
          log(`download failed for ${filename}: ${error}`);
          resolve({ ok: false, error });
          return;
        }
        resolve({ ok: true, id });
      });
    });
  },

  downloadDataUrl({ dataUrl, filename }) {
    return browser.download({ url: dataUrl, filename });
  },
};

const gemini = { generate: geminiGenerate, fetchImpl: (...args) => fetch(...args) };
const router = createRouter({ store, telegram, gemini, browser, log });

// ---------- polling ----------

let polling = false;
let lastConflictWarning = 0;

/** One long-poll round. Returns { stop } or { backoff } so the loop can rest. */
export async function pollOnce() {
  const config = await store.getConfig();
  if (!config.telegramPolling || !config.telegramToken) return { stop: true };

  const client = await telegramClient();
  const state = await store.getState();
  const { updates, ok, conflict, error } = await client.getUpdates({ offset: state.offset || 0, timeout: 25 });

  if (conflict) {
    // Two long-pollers on one token — typically the Render bot in ../index.js.
    await store.setState({ lastError: error.hint, lastErrorAt: Date.now() });
    if (Date.now() - lastConflictWarning > 5 * 60 * 1000 && config.chatId) {
      lastConflictWarning = Date.now();
      await client.sendText(config.chatId, `Warning: ${error.hint}`).catch(() => {});
    }
    return { backoff: 15000 };
  }

  if (!ok) {
    await store.setState({ lastError: `${error.message}${error.hint ? `\n${error.hint}` : ""}`, lastErrorAt: Date.now() });
    if (error.status === 401) {
      await store.setConfig({ telegramPolling: false });
      return { stop: true };
    }
    return { backoff: 5000 };
  }

  await store.setState({ lastError: "" });
  for (const update of updates) {
    await store.setState({ offset: update.update_id + 1 });
    const message = update.message;
    if (!message?.text) continue;
    const chatId = message.chat.id;

    if (!config.chatId || String(config.chatId) !== String(chatId)) {
      await client
        .sendText(chatId, `Not authorised. Your chat id is ${chatId}.\nPaste it into the extension options to take control.`)
        .catch(() => {});
      continue;
    }
    try {
      await router.handle(chatId, message.text);
    } catch (err) {
      log("command failed:", err);
      await client.sendText(chatId, `Command failed: ${err.message}`).catch(() => {});
    }
  }
  return {};
}

export async function pollLoop() {
  if (polling) return;
  polling = true;
  try {
    for (;;) {
      let outcome;
      try {
        outcome = await pollOnce();
      } catch (error) {
        log("poll crashed:", error.message);
        outcome = { backoff: 5000 };
      }
      if (outcome.stop) return;
      if (outcome.backoff) await new Promise((resolve) => setTimeout(resolve, outcome.backoff));
    }
  } finally {
    polling = false;
  }
}

/** Restart a pipeline that a worker suspension cut short. */
export async function resumeIfNeeded() {
  const state = await store.getState();
  const project = await store.getProject();
  if (!project || state.auto === false || router.isRunning()) return false;
  if (!state.chatId) return false;
  const next = nextRunnableStage(project);
  if (!next) return false;
  // A stage still marked running may be a call the worker was killed in the middle of.
  const stale = !state.runningStage || Date.now() - (state.runningSince || 0) > 4 * 60 * 1000;
  if (!stale) return false;
  log(`resuming pipeline at ${next}`);
  router.startFlow(state.chatId);
  return true;
}

// ---------- messaging ----------

export async function handleMessage(message) {
  switch (message?.type) {
    case "VVA_DOWNLOAD":
      return browser.download({ url: message.url, filename: message.filename });

    case "VVA_DOWNLOAD_DATA":
      return browser.downloadDataUrl({ dataUrl: message.dataUrl, filename: message.filename });

    case "VVA_TEST_GEMINI": {
      const out = await geminiGenerate({
        apiKey: message.apiKey,
        model: message.model || DEFAULT_MODEL,
        prompt: "Reply with exactly: OK",
        maxOutputTokens: 32,
      });
      return { ok: true, text: out.text.slice(0, 120) };
    }

    case "VVA_LIST_MODELS": {
      const models = await listModels({ apiKey: message.apiKey });
      return { ok: true, models: models.map((m) => m.name) };
    }

    case "VVA_TEST_TELEGRAM": {
      const me = await verifyToken({ token: message.token });
      return { ok: true, username: me.username };
    }

    case "VVA_DISCOVER_CHAT": {
      const { discoverChatId } = await import("./src/telegram.js");
      return { ok: true, chats: await discoverChatId({ token: message.token }) };
    }

    case "VVA_START": {
      const config = await store.getConfig();
      if (!config.chatId) return { ok: false, error: "Set your Telegram chat id in options first." };
      await store.setState({ auto: true, chatId: config.chatId });
      const started = router.startFlow(config.chatId);
      return { ok: started, message: started ? "running" : "already running" };
    }

    // Popup-driven starts. Same pipeline as Telegram, no chat required.
    case "VVA_TOPICS": {
      const config = await store.getConfig();
      if (!config.geminiKey) return { ok: false, error: "Add your Gemini API key in the settings first." };
      const previous = (await store.getProject()) || {};
      await store.setProject({
        ...emptyProject(),
        niche: message.niche || previous.niche || "human psychology",
      });
      await store.setState({ auto: true, chatId: config.chatId || null });
      const started = router.startFlow(config.chatId, { stopAfter: "topics" });
      return { ok: started, message: started ? "generating topics" : "already running" };
    }

    case "VVA_START_TOPIC": {
      const config = await store.getConfig();
      const project = await store.getProject();
      const topic = project?.topics?.[Number(message.num) - 1];
      if (!topic) return { ok: false, error: "Pick a topic first — send Topics to generate some." };
      await store.setProject({ ...project, picked: topic, script: "", stage: "topics", error: "" });
      await store.setState({ auto: true, chatId: config.chatId || null });
      const started = router.startFlow(config.chatId, { stopAfter: "script" });
      return { ok: started, message: started ? `writing the script for "${topic}"` : "already running" };
    }

    case "VVA_STOP":
      await store.setState({ auto: false });
      return { ok: true };

    case "VVA_OPEN":
      return { ok: true, opened: await browser.openSites(message.names) };

    case "VVA_SITE_ACTION":
      return browser.notifySite(message.name, { action: message.action });

    case "VVA_STATUS": {
      const project = await store.getProject();
      const state = await store.getState();
      return {
        ok: true,
        summary: projectSummary(project),
        percent: progressPercent(project),
        stage: project?.stage || "idle",
        running: router.isRunning(),
        runningStage: state.runningStage || null,
        lastError: state.lastError || "",
      };
    }

    case "VVA_RESET": {
      await store.setProject(null);
      await store.setState({ auto: false, runningStage: null });
      return { ok: true };
    }

    default:
      return { ok: false, error: `unknown message type ${message?.type}` };
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message)
    .then(sendResponse)
    .catch((error) => sendResponse({ ok: false, error: error.message, hint: error.hint }));
  return true; // keep the reply channel open across the await
});

// ---------- lifecycle ----------

function heartbeat() {
  pollLoop();
  resumeIfNeeded();
}

chrome.alarms.create("vva-heartbeat", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "vva-heartbeat") heartbeat();
});
chrome.runtime.onInstalled.addListener(async () => {
  await store.setConfig({}); // materialise defaults
  chrome.alarms.create("vva-heartbeat", { periodInMinutes: 0.5 });
  heartbeat();
});
chrome.runtime.onStartup.addListener(heartbeat);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes["vva:config"]) {
    clientCache = null; // pick up a new token or key
    heartbeat();
  }
});

heartbeat();

export { browser, router, store, telegramClient };
