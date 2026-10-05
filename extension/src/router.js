import { DEFAULT_IMAGE_MODEL, GeminiError, generateImage, listModels } from "./gemini.js";
import { FLOW, nextRunnableStage, planImages, progressPercent, runStage, stageDone } from "./pipeline.js";
import { cleanModelText, formatClockstamp } from "./text.js";
import { emptyProject, projectSummary } from "./store.js";

const HELP = `Viral Video Agent

/topics <niche>    get 5 video titles
1-9                pick a title, writes the script
/approve           timestamps, image prompts, SRT, metadata
/status            where the project is
/stop              stop the running pipeline
/reset             start over

/script            send script.txt
/timestamps        send timestamps.txt
/prompts           send image_prompts.txt
/srt               send captions.srt
/meta              send metadata.txt

/open tools        open CloneVoice, Artistly, VideoExpress
/open artistly     open one site
/pause  /resume    pause or resume the Artistly image loop
/queue             image loop progress

/images [n]        render n images with Gemini instead of Artistly
/model <name>      switch text model
/imagemodel <name> switch image model
/models            list models your key can call
/test              verify the Gemini key

/video play|pause|seek 30|speed 1.5|state
/ask <question>    question about the active tab's captions`;

export const SITES = {
  clonevoice: "https://app.clonevoice.ai/dashboard",
  artistly: "https://app.artistly.ai/dashboard",
  videoexpress: "https://app.videoexpress.ai/",
};

/**
 * Turns Telegram messages into pipeline actions and vice versa.
 * Every dependency is injected so this runs identically under node:test.
 */
export function createRouter({ store, telegram, gemini, browser, log = () => {} }) {
  let running = null;
  let stopAfter = null;

  const say = (chatId, text) => telegram.sendText(chatId, text).catch((e) => log(`send failed: ${e.message}`));
  const sendFile = (chatId, filename, content) =>
    telegram.sendDocument(chatId, filename, content).catch((e) => log(`file failed: ${e.message}`));

  async function callGemini(prompt, overrides = {}) {
    const config = await store.getConfig();
    return gemini.generate({ apiKey: config.geminiKey, model: config.geminiModel, prompt, ...overrides });
  }

  function formatError(error) {
    if (error instanceof GeminiError) return `Gemini error${error.status ? ` (${error.status})` : ""}: ${error.message}${error.hint ? `\n${error.hint}` : ""}`;
    return `Error: ${error.message}`;
  }

  async function deliverArtifacts(chatId, stage, project) {
    if (stage === "script" && project.script) await sendFile(chatId, "script.txt", project.script);
    if (stage === "timestamps" && project.timestampedText) await sendFile(chatId, "timestamps.txt", project.timestampedText);
    if (stage === "prompts" && project.imagePromptsText) await sendFile(chatId, "image_prompts.txt", project.imagePromptsText);
    if (stage === "assets") {
      if (project.srt) await sendFile(chatId, "captions.srt", project.srt);
      if (project.meta) {
        const meta = [
          `TITLE: ${project.meta.title}`,
          "",
          "DESCRIPTION:",
          project.meta.description,
          "",
          `TAGS: ${project.meta.tags.join(", ")}`,
          "",
          "THUMBNAIL PROMPT:",
          project.thumbPrompt,
        ].join("\n");
        await sendFile(chatId, "metadata.txt", meta);
      }
    }
  }

  /** Publish the payloads the content scripts pick up. */
  async function publishQueue(project) {
    const config = await store.getConfig();
    const items = planImages(project.prompts || [], { imagesPerPrompt: config.imagesPerPrompt });
    await store.setQueue({
      clonevoice: { text: project.script || "", updatedAt: Date.now() },
      artistly: {
        items,
        cursor: 0,
        status: "idle",
        folder: config.downloadFolder,
        minDelayMs: config.minDelayMs,
        maxDelayMs: config.maxDelayMs,
        generateWaitMs: config.generateWaitMs,
        updatedAt: Date.now(),
      },
    });
    return items;
  }

  async function runFlow(chatId) {
    const maxIterations = 60;
    try {
      for (let i = 0; i < maxIterations; i++) {
        const project = await store.getProject();
        const state = await store.getState();
        if (state.auto === false) {
          await say(chatId, "Stopped. Send /approve to continue where it left off.");
          return;
        }
        const stage = nextRunnableStage(project);
        if (!stage) break;

        await store.setState({ runningStage: stage, runningSince: Date.now() });
        await telegram.sendChatAction(chatId, "typing");
        await say(chatId, `Working: ${stage} (${progressPercent(project)}%)`);

        const config = await store.getConfig();
        let result;
        try {
          result = await runStage(stage, project, {
            config,
            log,
            generate: (opts) => gemini.generate({ apiKey: config.geminiKey, ...opts }),
          });
        } catch (error) {
          await store.patchProject({ error: error.message });
          await say(
            chatId,
            `${formatError(error)}\nThe project is saved at stage "${project.stage}". Fix it and send /approve to resume.`
          );
          return;
        }

        const updated = await store.setProject({ ...project, ...result.patch });
        await deliverArtifacts(chatId, stage, updated);
        if (stage !== "prompts") await say(chatId, result.message);
        // Human-in-the-loop checkpoints: topics and the script wait for approval.
        if (stopAfter === stage) break;
      }
    } finally {
      // Always clear the lock, even on an error return, or resumeIfNeeded stalls.
      await store.setState({ runningStage: null });
    }
  }

  async function finish(chatId) {
    const project = await store.getProject();
    const config = await store.getConfig();
    if (!project) return;
    const items = await publishQueue(project);
    const generated = items.filter((i) => i.kind === "generate").length;
    const reused = items.length - generated;
    if (config.autoOpenTabs) await browser.openSites(["clonevoice", "artistly", "videoexpress"]).catch(() => {});
    await say(
      chatId,
      [
        "Done. Files sent above.",
        "",
        `Images: ${generated} to generate, ${reused} reused from an earlier scene.`,
        "",
        "1. CloneVoice tab - script is pasted, pick a calm voice, generate, download the MP3.",
        `2. Artistly tab - the loop starts on its own and saves to Downloads/${config.downloadFolder}/`,
        "3. VideoExpress tab - upload the MP3, the images and captions.srt, then export 1080p.",
        "",
        "/pause and /resume control the image loop. /queue shows progress.",
      ].join("\n")
    );
  }

  /**
   * Fire-and-forget so the poll loop keeps reading commands such as /stop.
   * `stopAfter` is the human checkpoint: "/topics" stops after topics, "/pick" after
   * the script, and only "/approve" runs the rest unattended.
   */
  function startFlow(chatId, options = {}) {
    if (running) return false;
    stopAfter = options.stopAfter || null;
    running = (async () => {
      try {
        await runFlow(chatId);
        const project = await store.getProject();
        if (stageDone(project, "assets")) await finish(chatId);
      } catch (error) {
        log(`flow crashed: ${error.stack || error.message}`);
        await say(chatId, `Pipeline crashed: ${error.message}`);
      } finally {
        running = null;
        stopAfter = null;
      }
    })();
    return true;
  }

  async function handle(chatId, rawText) {
    const text = String(rawText || "").trim();
    if (!text) return;
    const [cmd, ...rest] = text.split(/\s+/);
    const arg = rest.join(" ").trim();
    const name = cmd.toLowerCase();

    if (name === "/start" || name === "/help") return say(chatId, HELP);

    if (name === "/status") {
      const project = await store.getProject();
      const state = await store.getState();
      const extra = state.runningStage ? `\nRunning now: ${state.runningStage} (${progressPercent(project)}%)` : "";
      return say(chatId, projectSummary(project) + extra);
    }

    if (name === "/topics") {
      const niche = arg || "human psychology";
      const config = await store.getConfig();
      // Start from the full record so no field is ever undefined for the UI.
      await store.setProject({ ...emptyProject(), niche });
      await say(chatId, `Asking Gemini for ${config.topicCount} topics on "${niche}"…`);
      const started = startFlow(chatId, { stopAfter: "topics" });
      if (!started) await say(chatId, "A pipeline is already running. Send /stop first.");
      return;
    }

    if (/^\d{1,2}$/.test(text) || name === "/pick") {
      const project = await store.getProject();
      if (!project?.topics?.length) return say(chatId, "No topics yet. Send /topics <niche> first.");
      const n = Number(/^\d{1,2}$/.test(text) ? text : arg);
      const topic = project.topics[n - 1];
      if (!topic) return say(chatId, `Pick a number between 1 and ${project.topics.length}.`);
      await store.patchProject({ picked: topic, script: "", stage: "topics", error: "" });
      await say(chatId, `Writing the script for:\n${topic}\nThis takes about a minute.`);
      startFlow(chatId, { stopAfter: "script" });
      return;
    }

    if (name === "/approve" || name === "/run" || name === "/continue") {
      const project = await store.getProject();
      if (!project) return say(chatId, "Nothing to run. Send /topics <niche> first.");
      const next = nextRunnableStage(project);
      if (!next) return say(chatId, "Everything is already built. Send /reset to start a new video.");
      await store.setState({ auto: true });
      if (!startFlow(chatId)) return say(chatId, "Already running. /status shows progress.");
      return say(chatId, `Resuming from "${next}". I will message you after each stage.`);
    }

    if (name === "/stop") {
      await store.setState({ auto: false });
      return say(chatId, "Stopping after the current stage finishes.");
    }

    if (name === "/reset") {
      await store.setProject(emptyProject());
      await store.setState({ auto: false, runningStage: null });
      return say(chatId, "Project cleared.");
    }

    if (name === "/script" || name === "/timestamps" || name === "/prompts" || name === "/srt" || name === "/meta") {
      const project = await store.getProject();
      const map = {
        "/script": ["script.txt", project?.script],
        "/timestamps": ["timestamps.txt", project?.timestampedText],
        "/prompts": ["image_prompts.txt", project?.imagePromptsText],
        "/srt": ["captions.srt", project?.srt],
        "/meta": ["metadata.txt", project?.meta ? `TITLE: ${project.meta.title}\n\nDESCRIPTION:\n${project.meta.description}\n\nTAGS: ${project.meta.tags.join(", ")}\n\nTHUMBNAIL PROMPT:\n${project.thumbPrompt}` : ""],
      };
      const [filename, content] = map[name];
      if (!content) return say(chatId, "Not built yet. /status shows where things are.");
      return sendFile(chatId, filename, content);
    }

    if (name === "/open") {
      const target = (arg || "tools").toLowerCase();
      const names = target === "tools" ? ["clonevoice", "artistly", "videoexpress"] : [target];
      const unknown = names.filter((n) => !SITES[n]);
      if (unknown.length) return say(chatId, `Unknown site: ${unknown.join(", ")}. Use ${Object.keys(SITES).join(", ")} or "tools".`);
      await browser.openSites(names);
      return say(chatId, `Opened: ${names.join(", ")}`);
    }

    if (name === "/pause") {
      const queue = await store.getQueue();
      if (!queue.artistly) return say(chatId, "No image queue yet. Send /approve first.");
      await store.setQueue({ ...queue, artistly: { ...queue.artistly, status: "paused" } });
      return say(chatId, "Image loop paused. /resume to continue.");
    }

    if (name === "/resume") {
      const queue = await store.getQueue();
      if (!queue.artistly) return say(chatId, "No image queue yet.");
      await store.setQueue({ ...queue, artistly: { ...queue.artistly, status: "running" } });
      await browser.notifySite("artistly", { action: "VVA_RESUME" });
      return say(chatId, "Image loop resumed.");
    }

    if (name === "/queue") {
      const queue = await store.getQueue();
      const a = queue.artistly;
      if (!a) return say(chatId, "No image queue yet. Send /approve first.");
      const done = a.items.slice(0, a.cursor).filter((i) => i.file).length;
      return say(chatId, `Status: ${a.status}\nProgress: ${a.cursor}/${a.items.length}\nSaved: ${done} files\nNext: ${(a.items[a.cursor]?.prompt || "-").slice(0, 160)}`);
    }

    if (name === "/models") {
      const config = await store.getConfig();
      if (!config.geminiKey) return say(chatId, "No Gemini API key set. Open the extension options.");
      try {
        const models = await listModels({ apiKey: config.geminiKey, fetchImpl: gemini.fetchImpl });
        const text = models.map((m) => `• ${m.name}`).join("\n") || "No models returned.";
        return say(chatId, `Models your key can call (${models.length}):\n${text}\n\nSwitch with /model <name>`);
      } catch (error) {
        return say(chatId, formatError(error));
      }
    }

    if (name === "/model") {
      if (!arg) return say(chatId, "Usage: /model gemini-2.5-flash");
      await store.setConfig({ geminiModel: arg });
      return say(chatId, `Text model set to ${arg}. /test checks it.`);
    }

    if (name === "/imagemodel") {
      await store.setConfig({ geminiImageModel: arg || DEFAULT_IMAGE_MODEL });
      return say(chatId, `Image model set to ${arg || DEFAULT_IMAGE_MODEL}.`);
    }

    if (name === "/test") {
      const config = await store.getConfig();
      try {
        const out = await callGemini("Reply with exactly: OK");
        return say(chatId, `Gemini ${config.geminiModel} works. It said: ${cleanModelText(out.text).slice(0, 80)}`);
      } catch (error) {
        return say(chatId, formatError(error));
      }
    }

    if (name === "/images") {
      const project = await store.getProject();
      if (!project?.prompts?.length) return say(chatId, "No prompts yet. Send /approve first.");
      const limit = Math.max(1, Math.min(20, Number(arg) || 3));
      const config = await store.getConfig();
      const queue = await store.getQueue();
      const start = queue.artistly?.cursor || 0;
      const targets = queue.artistly.items.filter((i) => i.kind === "generate").slice(start, start + limit);
      await say(chatId, `Rendering ${targets.length} images with ${config.geminiImageModel}…`);
      let ok = 0;
      for (const item of targets) {
        try {
          const images = await generateImage({
            apiKey: config.geminiKey,
            model: config.geminiImageModel,
            prompt: item.prompt,
            fetchImpl: gemini.fetchImpl,
          });
          const ext = (images[0].mimeType || "image/png").includes("jpeg") ? "jpg" : "png";
          await browser.downloadDataUrl({
            dataUrl: `data:${images[0].mimeType};base64,${images[0].data}`,
            filename: `${config.downloadFolder}/img_${String(item.index).padStart(3, "0")}.${ext}`,
          });
          ok++;
        } catch (error) {
          await say(chatId, `Image ${item.index} failed: ${error.message}${error.hint ? `\n${error.hint}` : ""}`);
        }
      }
      return say(chatId, `Saved ${ok}/${targets.length} images to Downloads/${config.downloadFolder}/`);
    }

    if (name === "/video") {
      const parts = arg.split(/\s+/).filter(Boolean);
      const tool = parts[0];
      if (!tool) return say(chatId, "Usage: /video play|pause|seek 30|speed 1.5|state");
      const result = await browser.sendToActiveTab({ vva: "player", tool, args: parsePlayerArgs(parts.slice(1)) });
      return say(chatId, typeof result === "string" ? result : JSON.stringify(result, null, 2));
    }

    if (name === "/ask") {
      if (!arg) return say(chatId, "Usage: /ask what does he say about focus?");
      const captions = await browser.sendToActiveTab({ vva: "player", tool: "get_captions", args: {} });
      if (typeof captions !== "string" || !captions.trim() || captions.startsWith("no captions")) {
        return say(chatId, "No captions on the active tab, so there is nothing to ask about.");
      }
      const out = await callGemini(
        `Answer using ONLY this transcript. If it is not covered, say so.\n\nTRANSCRIPT:\n${captions.slice(0, 20000)}\n\nQUESTION: ${arg}`
      );
      return say(chatId, cleanModelText(out.text));
    }

    return say(chatId, `Unknown command "${cmd}". Send /help.`);
  }

  return { handle, startFlow, isRunning: () => Boolean(running) };
}

function parsePlayerArgs(parts) {
  if (!parts.length) return {};
  const first = Number(parts[0]);
  if (Number.isFinite(first)) return { value: first };
  return { text: parts.join(" ") };
}

export { FLOW, formatClockstamp };
