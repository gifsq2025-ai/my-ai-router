const $ = (id) => document.getElementById(id);
const PROJECT = "vva:project";
const QUEUE = "vva:queue";
const CONFIG = "vva:config";

function send(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
      else resolve(response);
    });
  });
}

function renderTopics(project) {
  const list = $("topic-list");
  list.innerHTML = "";
  (project?.topics || []).forEach((topic, index) => {
    const button = document.createElement("button");
    button.className = "topic";
    button.textContent = `${index + 1}. ${topic}`;
    button.title = "Write the script for this topic";
    if (project.picked === topic) button.classList.add("picked");
    button.onclick = async () => {
      button.disabled = true;
      await send({ type: "VVA_START_TOPIC", num: index + 1 });
      await refresh();
    };
    list.appendChild(button);
  });
}

async function refresh() {
  const data = await chrome.storage.local.get([PROJECT, QUEUE, CONFIG, "vva:state"]);
  const project = data[PROJECT] || null;
  const config = data[CONFIG] || {};
  const state = data["vva:state"] || {};

  $("stage").textContent = state.runningStage ? `running: ${state.runningStage}` : project?.stage || "idle";
  $("topic").textContent = project?.picked || project?.niche || "-";
  $("cues").textContent = project?.lines?.length || 0;
  $("prompts").textContent = project?.prompts?.length || 0;

  const percent = project?.stage === "done" ? 100 : state.runningStage ? 50 : 0;
  $("bar-fill").style.width = `${percent}%`;

  if (project?.error || state.lastError) {
    $("error").hidden = false;
    $("error").textContent = project?.error || state.lastError;
  } else {
    $("error").hidden = true;
  }

  $("hint").textContent =
    config.geminiKey && config.telegramToken
      ? "Control everything from Telegram, or from here."
      : "Set your Gemini key and Telegram token in ⚙ first.";

  renderTopics(project);
}

$("btn-topics").onclick = async () => {
  const niche = $("niche").value.trim() || "human psychology";
  $("btn-topics").disabled = true;
  $("btn-topics").textContent = "Working…";
  const response = await send({ type: "VVA_TOPICS", niche });
  $("btn-topics").disabled = false;
  $("btn-topics").textContent = "Topics";
  if (!response.ok) {
    $("error").hidden = false;
    $("error").textContent = response.error;
  }
  await refresh();
};

$("btn-approve").onclick = async () => {
  const response = await send({ type: "VVA_START" });
  if (!response.ok) {
    $("error").hidden = false;
    $("error").textContent = response.error || "Cannot start. Check your settings.";
  }
  await refresh();
};

$("btn-stop").onclick = async () => {
  await send({ type: "VVA_STOP" });
  await refresh();
};

$("btn-pause").onclick = () => send({ type: "VVA_SITE_ACTION", name: "artistly", action: "VVA_PAUSE" });
$("btn-resume").onclick = () => send({ type: "VVA_SITE_ACTION", name: "artistly", action: "VVA_RESUME" });

$("btn-copy-prompts").onclick = async () => {
  const data = await chrome.storage.local.get(PROJECT);
  await navigator.clipboard.writeText(data[PROJECT]?.imagePromptsText || "");
  $("btn-copy-prompts").textContent = "Copied";
  setTimeout(() => ($("btn-copy-prompts").textContent = "Copy prompts"), 1200);
};

$("btn-copy-meta").onclick = async () => {
  const data = await chrome.storage.local.get(PROJECT);
  const meta = data[PROJECT]?.meta;
  const text = meta ? `${meta.title}\n\n${meta.description}\n\n${meta.tags.join(", ")}` : "";
  await navigator.clipboard.writeText(text);
  $("btn-copy-meta").textContent = meta ? "Copied" : "Nothing yet";
  setTimeout(() => ($("btn-copy-meta").textContent = "Copy metadata"), 1200);
};

for (const button of document.querySelectorAll("[data-site]")) {
  button.onclick = () => send({ type: "VVA_OPEN", names: [button.dataset.site] });
}

$("open-options").onclick = () => chrome.runtime.openOptionsPage();

refresh();
setInterval(refresh, 1500);
