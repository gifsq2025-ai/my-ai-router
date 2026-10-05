const CONFIG = "vva:config";
const PROJECT = "vva:project";

const TEXT_FIELDS = [
  "geminiKey", "geminiModel", "geminiImageModel", "telegramToken", "chatId",
  "topicCount", "wordsPerMinute", "imagesPerPrompt", "downloadFolder",
  "minDelayMs", "maxDelayMs", "generateWaitMs",
];
const CHECK_FIELDS = ["telegramPolling", "autoOpenTabs"];
const SITES = [
  { key: "clonevoice", label: "CloneVoice" },
  { key: "artistly", label: "Artistly" },
  { key: "videoexpress", label: "VideoExpress" },
];

const $ = (id) => document.getElementById(id);

function send(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
      else resolve(response);
    });
  });
}

function buildSelectorFields(selectors) {
  const host = $("selector-fields");
  host.innerHTML = "";
  for (const site of SITES) {
    const group = document.createElement("div");
    group.className = "selector-group";
    const title = document.createElement("h3");
    title.textContent = site.label;
    group.appendChild(title);
    for (const [role, hint] of [["input", "Text / prompt box"], ["generate", "Generate button"]]) {
      const label = document.createElement("label");
      label.textContent = hint;
      label.htmlFor = `sel_${site.key}_${role}`;
      const input = document.createElement("input");
      input.type = "text";
      input.id = `sel_${site.key}_${role}`;
      input.placeholder = role === "input" ? "textarea" : "button";
      input.value = selectors?.[site.key]?.[role] || "";
      group.appendChild(label);
      group.appendChild(input);
    }
    host.appendChild(group);
  }
}

function readSelectors() {
  const selectors = {};
  for (const site of SITES) {
    const input = $(`sel_${site.key}_input`).value.trim();
    const generate = $(`sel_${site.key}_generate`).value.trim();
    if (input || generate) selectors[site.key] = { ...(input ? { input } : {}), ...(generate ? { generate } : {}) };
  }
  return selectors;
}

async function load() {
  const data = await chrome.storage.local.get([CONFIG, "vva:state"]);
  const config = data[CONFIG] || {};
  for (const field of TEXT_FIELDS) if ($(field)) $(field).value = config[field] ?? "";
  for (const field of CHECK_FIELDS) if ($(field)) $(field).checked = Boolean(config[field]);
  buildSelectorFields(config.selectors);

  const lastError = data["vva:state"]?.lastError;
  if (lastError) {
    $("last-error").hidden = false;
    $("last-error").textContent = lastError;
  }
}

async function save() {
  const patch = {};
  for (const field of TEXT_FIELDS) if ($(field)) patch[field] = $(field).value.trim();
  for (const field of CHECK_FIELDS) if ($(field)) patch[field] = $(field).checked;
  for (const field of ["topicCount", "wordsPerMinute", "imagesPerPrompt", "minDelayMs", "maxDelayMs", "generateWaitMs"]) {
    patch[field] = Number(patch[field]) || 0;
  }
  patch.selectors = readSelectors();
  await chrome.storage.local.set({ [CONFIG]: { ...(await (await chrome.storage.local.get(CONFIG))[CONFIG] || {}), ...patch } });
  $("saved").textContent = "Saved ✓";
  setTimeout(() => ($("saved").textContent = ""), 2000);
}

$("save").onclick = save;

$("toggle-key").onclick = () => {
  const input = $("geminiKey");
  const showing = input.type === "text";
  input.type = showing ? "password" : "text";
  $("toggle-key").textContent = showing ? "show" : "hide";
};

$("btn-test-gemini").onclick = async () => {
  $("btn-test-gemini").textContent = "Testing…";
  const response = await send({ type: "VVA_TEST_GEMINI", apiKey: $("geminiKey").value.trim(), model: $("geminiModel").value.trim() });
  $("btn-test-gemini").textContent = "Test";
  const box = $("last-error");
  if (response.ok) {
    box.hidden = false;
    box.className = "note";
    box.textContent = `Gemini answered: ${response.text}`;
  } else {
    box.hidden = false;
    box.className = "error";
    box.textContent = `${response.error}${response.hint ? `\n${response.hint}` : ""}`;
  }
};

$("btn-list-models").onclick = async () => {
  $("btn-list-models").textContent = "Loading…";
  const response = await send({ type: "VVA_LIST_MODELS", apiKey: $("geminiKey").value.trim() });
  $("btn-list-models").textContent = "List models";
  const list = $("model-list");
  list.innerHTML = "";
  const box = $("last-error");
  if (!response.ok) {
    box.hidden = false;
    box.className = "error";
    box.textContent = `${response.error}${response.hint ? `\n${response.hint}` : ""}`;
    return;
  }
  for (const name of response.models) {
    const option = document.createElement("option");
    option.value = name;
    list.appendChild(option);
  }
  box.hidden = false;
  box.className = "note";
  box.textContent = `${response.models.length} models available to this key. Pick one from the dropdown, then Save.`;
};

$("btn-test-telegram").onclick = async () => {
  const response = await send({ type: "VVA_TEST_TELEGRAM", token: $("telegramToken").value.trim() });
  const box = $("last-error");
  box.hidden = false;
  box.className = response.ok ? "note" : "error";
  box.textContent = response.ok ? `Bot verified: @${response.username}` : `${response.error}${response.hint ? `\n${response.hint}` : ""}`;
};

$("btn-discover").onclick = async () => {
  const response = await send({ type: "VVA_DISCOVER_CHAT", token: $("telegramToken").value.trim() });
  const box = $("last-error");
  box.hidden = false;
  if (!response.ok || !response.chats?.length) {
    box.className = "error";
    box.textContent = response.ok
      ? "No recent messages found. Send /start to your bot, then press Find it again."
      : response.error;
    return;
  }
  box.className = "note";
  box.textContent = response.chats.map((chat) => `${chat.id} — ${chat.title}`).join("\n");
  $("chatId").value = response.chats[0].id;
};

$("reset-project").onclick = async () => {
  await chrome.storage.local.remove([PROJECT, "vva:queue"]);
  await send({ type: "VVA_RESET" });
  $("saved").textContent = "Project cleared";
  setTimeout(() => ($("saved").textContent = ""), 2000);
};

load();
