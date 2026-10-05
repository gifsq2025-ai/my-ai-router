// A JSON-file-backed store with the same surface the router expects from
// chrome.storage, so the pipeline survives Render restarts.
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { DEFAULT_CONFIG } from "../extension/src/store.js";

const KEYS = {
  config: "vva:config",
  project: "vva:project",
  queue: "vva:queue",
  state: "vva:state",
};

export function fileStore(path) {
  let data = {};
  const load = () => {
    try {
      if (existsSync(path)) data = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      data = {};
    }
  };
  const save = () => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(data, null, 2));
  };
  load();

  return {
    _path: path,
    _data: data,
    async getConfig() {
      return { ...DEFAULT_CONFIG, ...(data[KEYS.config] || {}) };
    },
    async setConfig(patch) {
      const next = { ...DEFAULT_CONFIG, ...(data[KEYS.config] || {}), ...patch };
      data[KEYS.config] = next;
      save();
      return next;
    },
    async getProject() {
      return data[KEYS.project] || null;
    },
    async setProject(project) {
      const next = project === null ? null : { ...project, updatedAt: Date.now() };
      data[KEYS.project] = next;
      save();
      return next;
    },
    async patchProject(patch) {
      const current = (await this.getProject()) || {};
      return this.setProject({ ...current, ...patch });
    },
    async getQueue() {
      return data[KEYS.queue] || { clonevoice: null, artistly: null };
    },
    async setQueue(queue) {
      data[KEYS.queue] = queue;
      save();
      return queue;
    },
    async getState() {
      return data[KEYS.state] || {};
    },
    async setState(patch) {
      const next = { ...(data[KEYS.state] || {}), ...patch };
      data[KEYS.state] = next;
      save();
      return next;
    },
  };
}
