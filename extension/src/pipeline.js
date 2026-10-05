import {
  imagePromptsPrompt,
  metadataPrompt,
  reusePlanPrompt,
  scriptPrompt,
  thumbnailPrompt,
  timestampsPrompt,
  topicsPrompt,
} from "./prompts.js";
import { buildSrt } from "./srt.js";
import { cleanModelText, formatClockstamp, parseMetadata, parseNumberedList, parsePromptLines, parseTimestampLines, wordCount } from "./text.js";

export const FLOW = ["topics", "script", "timestamps", "prompts", "assets"];
export const PROMPT_BATCH_SIZE = 20;

const STYLE_TAIL =
  ", no photorealism, no 3D render, no gradients, no drop shadows, no textures, no realistic faces, no anime style, flat black line art only";

export const STAGE_LABELS = {
  idle: "waiting for a niche",
  topics: "topics generated",
  script: "script written",
  timestamps: "subtitles timed",
  prompts: "image prompts written",
  assets: "SRT + metadata ready",
  done: "complete",
};

export function prerequisitesMet(project, stage) {
  switch (stage) {
    case "topics":
      return Boolean(project?.niche);
    case "script":
      return Boolean(project?.picked);
    case "timestamps":
      return wordCount(project?.script) >= 100;
    case "prompts":
      return (project?.lines || []).length > 0;
    case "assets":
      return (project?.lines || []).length > 0 && Boolean(project?.script);
    default:
      return false;
  }
}

/** Which stage should run next given what the project already holds. */
export function nextRunnableStage(project) {
  if (!project) return null;
  for (const stage of FLOW) {
    if (!stageDone(project, stage) && prerequisitesMet(project, stage)) return stage;
  }
  return null;
}

export function stageDone(project, stage) {
  if (!project) return false;
  switch (stage) {
    case "topics":
      return (project.topics || []).length > 0;
    case "script":
      return wordCount(project.script) >= 100;
    case "timestamps":
      return (project.lines || []).length > 0;
    case "prompts":
      return (project.prompts || []).length >= (project.lines || []).length && (project.lines || []).length > 0;
    case "assets":
      return Boolean(project.srt) && Boolean(project.meta?.title);
    default:
      return false;
  }
}

/**
 * Run one stage. Returns { patch, done, message }.
 * `patch` is merged into the project and persisted by the caller, so a service-worker
 * restart resumes from the last completed stage instead of losing 3 minutes of work.
 */
export async function runStage(stage, project, deps) {
  const { generate, config = {}, log = () => {} } = deps;
  const model = config.geminiModel;

  switch (stage) {
    case "topics": {
      const count = config.topicCount || 5;
      const out = await generate({ model, prompt: topicsPrompt(project.niche, count), temperature: 0.95, maxOutputTokens: 1024 });
      const topics = parseNumberedList(out.text).slice(0, count);
      if (!topics.length) throw new Error("Gemini returned no usable titles. Try a more specific niche.");
      return {
        patch: { topics, topicsRaw: cleanModelText(out.text), stage: "topics", error: "" },
        done: true,
        message: `Here are ${topics.length} topics for "${project.niche}":\n\n` +
          topics.map((t, i) => `${i + 1}. ${t}`).join("\n") +
          `\n\nReply with a number to write the script.`,
      };
    }

    case "script": {
      const out = await generate({ model, prompt: scriptPrompt(project.picked), temperature: 0.85, maxOutputTokens: 8192 });
      const script = cleanModelText(out.text);
      const words = wordCount(script);
      if (words < 200) throw new Error(`Gemini returned only ${words} words. Try again.`);
      log(`script: ${words} words, finishReason=${out.finishReason}`);
      return {
        patch: {
          script,
          stage: "script",
          error: "",
          // A new script invalidates everything derived from it.
          lines: [],
          timestampedText: "",
          prompts: [],
          promptBatch: 0,
          imagePromptsText: "",
          srt: "",
          meta: null,
          thumbPrompt: "",
        },
        done: true,
        message: `Script ready: ${words} words (~${Math.round(words / (config.wordsPerMinute || 150))} min of narration).` +
          `\n\n${script.slice(0, 1200)}${script.length > 1200 ? "\n…" : ""}` +
          `\n\nSend /approve to build timestamps, image prompts, SRT and metadata.`,
      };
    }

    case "timestamps": {
      const out = await generate({
        model,
        prompt: timestampsPrompt(project.script, { wordsPerMinute: config.wordsPerMinute || 150 }),
        temperature: 0.2,
        maxOutputTokens: 8192,
      });
      const lines = parseTimestampLines(out.text);
      if (lines.length < 5) throw new Error(`Only ${lines.length} cues parsed from Gemini's timestamps. Try again.`);
      const text = lines.map((l) => `[${formatClockstamp(l.seconds)}] ${l.text}`).join("\n");
      return {
        patch: { lines, timestampedText: text, stage: "timestamps", error: "" },
        done: true,
        message: `${lines.length} subtitle cues, ending around ${formatClockstamp(lines[lines.length - 1].seconds)}.`,
      };
    }

    case "prompts": {
      const lines = project.lines || [];
      const cursor = project.promptBatch || 0;
      if (cursor >= lines.length) {
        return { patch: { stage: "prompts" }, done: true, message: "Image prompts complete." };
      }
      const batch = lines.slice(cursor, cursor + PROMPT_BATCH_SIZE);
      const out = await generate({
        model,
        prompt: imagePromptsPrompt(batch),
        temperature: 0.9,
        maxOutputTokens: 8192,
      });
      const parsed = parsePromptLines(out.text);
      // Guarantee exactly one prompt per cue, even if Gemini skips or reorders lines.
      const aligned = batch.map((cue, i) => ({
        seconds: cue.seconds,
        text: cue.text,
        prompt: (parsed[i]?.prompt || fallbackPrompt(cue.text)).replace(/\s+/g, " ").trim(),
      }));
      const prompts = [...(project.prompts || []), ...aligned];
      const nextCursor = cursor + batch.length;
      log(`prompts batch ${cursor}-${nextCursor} of ${lines.length}`);
      return {
        patch: { prompts, promptBatch: nextCursor, imagePromptsText: prompts.map((p) => `[${formatClockstamp(p.seconds)}] | ${p.prompt}`).join("\n"), stage: "prompts", error: "" },
        done: nextCursor >= lines.length,
        message: `Image prompts ${nextCursor}/${lines.length}`,
      };
    }

    case "assets": {
      const lines = project.lines || [];
      const srt = buildSrt(lines, { wordsPerMinute: config.wordsPerMinute || 150 });
      if (!srt) throw new Error("No cues to build SRT from.");
      const [metaOut, thumbOut] = await Promise.all([
        generate({ model, prompt: metadataPrompt(project.picked, project.script), temperature: 0.8, maxOutputTokens: 4096 }),
        generate({ model, prompt: thumbnailPrompt(project.picked), temperature: 0.9, maxOutputTokens: 1024 }),
      ]);
      const meta = parseMetadata(metaOut.text);
      if (!meta.title) throw new Error("Gemini returned no TITLE line. Try again.");
      const thumbPrompt = cleanModelText(thumbOut.text).split("\n")[0];
      return {
        patch: { srt, meta, thumbPrompt, stage: "done", error: "" },
        done: true,
        message: `Title: ${meta.title}\nTags: ${meta.tags.length}\nSRT: ${srt.split("\n\n").length} cues`,
      };
    }

    default:
      throw new Error(`Unknown stage "${stage}"`);
  }
}

/** Deterministic prompt for a cue, used when Gemini returns fewer lines than we asked for. */
export function fallbackPrompt(cueText) {
  const scene = String(cueText || "").replace(/[.!?]+$/, "").slice(0, 140);
  return `simple stick figure with a large circular head, dot eyes, thick black outline doodle illustration depicting: ${scene}, single solid background color${STYLE_TAIL}`;
}

/**
 * Mark prompts that are identical to an earlier one so the image step can reuse a
 * rendered file instead of burning another generation (and another 15 seconds).
 */
export function assignReuse(prompts) {
  const seen = new Map();
  return (prompts || []).map((p, index) => {
    const key = String(p.prompt || "")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim();
    if (seen.has(key)) return { ...p, index, reuseOf: seen.get(key) };
    seen.set(key, index);
    return { ...p, index, reuseOf: null };
  });
}

/** The concrete work list handed to the Artistly automation. */
export function planImages(prompts, { imagesPerPrompt = 1 } = {}) {
  const planned = assignReuse(prompts);
  const items = [];
  for (const p of planned) {
    if (p.reuseOf !== null) {
      items.push({ index: p.index, seconds: p.seconds, prompt: p.prompt, copyOf: p.reuseOf, kind: "copy" });
      continue;
    }
    for (let v = 0; v < Math.max(1, imagesPerPrompt); v++) {
      items.push({ index: p.index, seconds: p.seconds, prompt: p.prompt, variant: v, kind: "generate" });
    }
  }
  return items;
}

/** Optional extra Gemini pass that groups near-duplicate prompts. Kept separate so it can fail safely. */
export async function reusePlan(prompts, deps) {
  const out = await deps.generate({
    model: deps.config?.geminiModel,
    prompt: reusePlanPrompt(prompts),
    temperature: 0,
    maxOutputTokens: 4096,
  });
  const json = cleanModelText(out.text).match(/\[[\s\S]*\]/);
  if (!json) return null;
  try {
    const parsed = JSON.parse(json[0]);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function progressPercent(project) {
  const weights = { idle: 0, topics: 15, script: 35, timestamps: 55, prompts: 80, done: 100 };
  if (!project) return 0;
  const base = weights[project.stage] ?? 0;
  if (project.stage === "prompts" && project.lines?.length) {
    return Math.min(80, 55 + Math.round((project.promptBatch / project.lines.length) * 25));
  }
  return base;
}
