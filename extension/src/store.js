// Storage abstraction. The extension uses chrome.storage.local; tests use memory.

export const CONFIG_KEY = "vva:config";
export const PROJECT_KEY = "vva:project";
export const QUEUE_KEY = "vva:queue";
export const STATE_KEY = "vva:state";

export const DEFAULT_CONFIG = {
  geminiKey: "",
  geminiModel: "gemini-2.5-flash",
  geminiImageModel: "gemini-2.5-flash-image",
  telegramToken: "",
  chatId: "",
  telegramPolling: true,
  imageProvider: "artistly", // "artistly" | "gemini"
  autoOpenTabs: true,
  openPlayerTools: false,
  minDelayMs: 5000,
  maxDelayMs: 15000,
  generateWaitMs: 20000,
  imagesPerPrompt: 1,
  downloadFolder: "viral",
  wordsPerMinute: 150,
  topicCount: 5,
  selectors: {}, // { clonevoice: {input, generate}, artistly: {...} }
};

export function chromeStore(area = chrome.storage.local) {
  return {
    async get(keys) {
      return area.get(keys);
    },
    async set(obj) {
      return area.set(obj);
    },
    async remove(keys) {
      return area.remove(keys);
    },
    async getConfig() {
      const data = await area.get(CONFIG_KEY);
      return { ...DEFAULT_CONFIG, ...(data[CONFIG_KEY] || {}) };
    },
    async setConfig(patch) {
      const current = await this.getConfig();
      const next = { ...current, ...patch };
      await area.set({ [CONFIG_KEY]: next });
      return next;
    },
    async getProject() {
      const data = await area.get(PROJECT_KEY);
      return data[PROJECT_KEY] || null;
    },
    async setProject(project) {
      const next = { ...project, updatedAt: Date.now() };
      await area.set({ [PROJECT_KEY]: next });
      return next;
    },
    async patchProject(patch) {
      const current = (await this.getProject()) || {};
      return this.setProject({ ...current, ...patch });
    },
    async getQueue() {
      const data = await area.get(QUEUE_KEY);
      return data[QUEUE_KEY] || { clonevoice: null, artistly: null };
    },
    async setQueue(queue) {
      await area.set({ [QUEUE_KEY]: queue });
      return queue;
    },
    async getState() {
      const data = await area.get(STATE_KEY);
      return data[STATE_KEY] || {};
    },
    async setState(patch) {
      const current = await this.getState();
      const next = { ...current, ...patch };
      await area.set({ [STATE_KEY]: next });
      return next;
    },
  };
}

/** In-memory implementation with the same surface, for tests. */
export function memoryStore(initial = {}) {
  const data = { ...initial };
  const store = {
    data,
    async get(keys) {
      const list = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(list.filter((k) => k in data).map((k) => [k, data[k]]));
    },
    async set(obj) {
      Object.assign(data, obj);
    },
    async remove(keys) {
      for (const k of Array.isArray(keys) ? keys : [keys]) delete data[k];
    },
  };
  return {
    ...store,
    async getConfig() {
      return { ...DEFAULT_CONFIG, ...(data[CONFIG_KEY] || {}) };
    },
    async setConfig(patch) {
      const next = { ...DEFAULT_CONFIG, ...(data[CONFIG_KEY] || {}), ...patch };
      data[CONFIG_KEY] = next;
      return next;
    },
    async getProject() {
      return data[PROJECT_KEY] || null;
    },
    async setProject(project) {
      const next = { ...project, updatedAt: Date.now() };
      data[PROJECT_KEY] = next;
      return next;
    },
    async patchProject(patch) {
      const current = (await this.getProject()) || {};
      return this.setProject({ ...current, ...patch });
    },
    async getQueue() {
      return data[QUEUE_KEY] || { clonevoice: null, artistly: null };
    },
    async setQueue(queue) {
      data[QUEUE_KEY] = queue;
      return queue;
    },
    async getState() {
      return data[STATE_KEY] || {};
    },
    async setState(patch) {
      const next = { ...(data[STATE_KEY] || {}), ...patch };
      data[STATE_KEY] = next;
      return next;
    },
  };
}

/** A fresh, empty project record. */
export function emptyProject() {
  return {
    stage: "idle",
    niche: "",
    topicsRaw: "",
    topics: [],
    picked: "",
    script: "",
    lines: [],
    timestampedText: "",
    prompts: [],
    imagePromptsText: "",
    promptBatch: 0,
    srt: "",
    meta: null,
    thumbPrompt: "",
    error: "",
    log: [],
  };
}

export function projectSummary(project) {
  if (!project) return "No project yet. Send /topics <niche> to start.";
  const lines = [
    `Stage: ${project.stage}`,
    `Niche: ${project.niche || "-"}`,
    `Topic: ${project.picked || "-"}`,
    `Script: ${project.script ? `${project.script.split(/\s+/).filter(Boolean).length} words` : "-"}`,
    `Cues: ${project.lines?.length || 0}`,
    `Image prompts: ${project.prompts?.length || 0}`,
    `SRT: ${project.srt ? "ready" : "-"}`,
    `Metadata: ${project.meta?.title || "-"}`,
  ];
  if (project.error) lines.push(`Last error: ${project.error}`);
  return lines.join("\n");
}
