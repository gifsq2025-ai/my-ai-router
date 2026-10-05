import test from "node:test";
import assert from "node:assert/strict";
import {
  PROMPT_BATCH_SIZE,
  assignReuse,
  fallbackPrompt,
  nextRunnableStage,
  planImages,
  prerequisitesMet,
  progressPercent,
  runStage,
  stageDone,
} from "../src/pipeline.js";

const LONG_SCRIPT = Array.from({ length: 250 }, (_, i) => `word${i}`).join(" ");

/** A stand-in Gemini that answers based on which prompt template it was handed. */
function fakeGemini(overrides = {}) {
  const calls = [];
  const generate = async ({ prompt, model }) => {
    calls.push({ prompt, model });
    const cueLines = [...prompt.matchAll(/^\[(\d{1,2}:\d{1,2}(?::\d{1,2})?)\]\s(.+)$/gm)];

    let text;
    if (prompt.includes("viral YouTube strategist")) text = overrides.topics ?? "1. Alpha title\n2. Beta title\n3. Gamma title";
    else if (prompt.includes("YouTube narration script")) text = overrides.script ?? LONG_SCRIPT;
    else if (prompt.includes("Split this narration")) text = overrides.timestamps ?? defaultTimestamps();
    else if (prompt.includes("doodle-style illustration")) {
      text = overrides.prompts ?? cueLines.map((m) => `[${m[1]}] | stick figure scene: ${m[2].slice(0, 40)}`).join("\n");
    } else if (prompt.includes("YouTube metadata")) {
      text = overrides.metadata ?? "TITLE: Why your brain lies\nDESCRIPTION:\nHook.\nBody.\n#brain #mind\nTAGS: brain, mind, focus";
    } else if (prompt.includes("1280x720")) text = overrides.thumbnail ?? "a stick figure under a huge clock, flat black line art";
    else text = "OK";
    return { text, finishReason: "STOP", images: [] };
  };
  return { calls, generate };
}

function defaultTimestamps(count = 45) {
  return Array.from({ length: count }, (_, i) => `[${String(Math.floor((i * 6) / 60)).padStart(2, "0")}:${String((i * 6) % 60).padStart(2, "0")}] cue number ${i} with some words`).join("\n");
}

const config = { geminiModel: "gemini-2.5-flash", topicCount: 5, wordsPerMinute: 150 };

test("nextRunnableStage walks the flow in order", () => {
  let project = { niche: "psychology" };
  assert.equal(nextRunnableStage(project), "topics");
  project = { ...project, topics: ["a"] };
  assert.equal(nextRunnableStage(project), null, "no topic picked yet, so nothing can run");
  project = { ...project, picked: "a" };
  assert.equal(nextRunnableStage(project), "script");
  project = { ...project, script: LONG_SCRIPT };
  assert.equal(nextRunnableStage(project), "timestamps");
});

test("prerequisitesMet blocks a stage whose input is missing", () => {
  assert.equal(prerequisitesMet({ script: "too short" }, "timestamps"), false);
  assert.equal(prerequisitesMet({ script: LONG_SCRIPT }, "timestamps"), true);
  assert.equal(prerequisitesMet({ lines: [] }, "prompts"), false);
});

test("the topics stage stores parsed titles and the raw reply", async () => {
  const gemini = fakeGemini();
  const { patch, done, message } = await runStage("topics", { niche: "habits" }, { generate: gemini.generate, config });
  assert.equal(done, true);
  assert.deepEqual(patch.topics, ["Alpha title", "Beta title", "Gamma title"]);
  assert.equal(patch.stage, "topics");
  assert.match(message, /Reply with a number/);
});

test("the topics stage refuses a reply with no usable titles", async () => {
  const gemini = fakeGemini({ topics: "I cannot help with that." });
  await assert.rejects(() => runStage("topics", { niche: "x" }, { generate: gemini.generate, config }), /no usable titles/);
});

test("the script stage clears everything derived from the old script", async () => {
  const gemini = fakeGemini();
  const stale = { picked: "topic", script: "old", lines: [{ seconds: 0, text: "old" }], prompts: [{ prompt: "old" }], srt: "1\n", meta: { title: "old" }, promptBatch: 3 };
  const { patch } = await runStage("script", stale, { generate: gemini.generate, config });
  assert.deepEqual(patch.lines, []);
  assert.deepEqual(patch.prompts, []);
  assert.equal(patch.promptBatch, 0);
  assert.equal(patch.srt, "");
  assert.equal(patch.meta, null);
  assert.equal(patch.stage, "script");
});

test("the script stage rejects a stub reply", async () => {
  const gemini = fakeGemini({ script: "Sorry." });
  await assert.rejects(() => runStage("script", { picked: "t" }, { generate: gemini.generate, config }), /only 1 words/);
});

test("the timestamps stage parses cues into seconds", async () => {
  const gemini = fakeGemini();
  const { patch } = await runStage("timestamps", { script: LONG_SCRIPT }, { generate: gemini.generate, config });
  assert.equal(patch.lines.length, 45);
  assert.equal(patch.lines[0].seconds, 0);
  assert.equal(patch.lines[1].seconds, 6);
  assert.match(patch.timestampedText, /\[00:06\] cue number 1/);
});

test("the prompts stage works in batches of 20 and says when it is not finished", async () => {
  const gemini = fakeGemini();
  const lines = Array.from({ length: 45 }, (_, i) => ({ seconds: i * 6, text: `cue ${i}` }));
  let project = { lines, prompts: [], promptBatch: 0 };

  const first = await runStage("prompts", project, { generate: gemini.generate, config });
  assert.equal(first.done, false);
  assert.equal(first.patch.promptBatch, PROMPT_BATCH_SIZE);
  assert.equal(first.patch.prompts.length, 20);

  project = { ...project, ...first.patch };
  const second = await runStage("prompts", project, { generate: gemini.generate, config });
  assert.equal(second.done, false);
  assert.equal(second.patch.promptBatch, 40);

  project = { ...project, ...second.patch };
  const third = await runStage("prompts", project, { generate: gemini.generate, config });
  assert.equal(third.done, true);
  assert.equal(third.patch.prompts.length, 45);
  assert.equal(gemini.calls.length, 3, "exactly one Gemini call per batch");
});

test("the prompts stage backfills a cue Gemini skipped", async () => {
  // Two cues in, one prompt out.
  const gemini = fakeGemini({ prompts: "[00:00] | only one prompt" });
  const { patch } = await runStage("prompts", { lines: [{ seconds: 0, text: "first" }, { seconds: 6, text: "second" }], prompts: [], promptBatch: 0 }, {
    generate: gemini.generate,
    config,
  });
  assert.equal(patch.prompts.length, 2, "there must be one prompt per cue or the image loop desyncs");
  assert.equal(patch.prompts[0].prompt, "only one prompt");
  assert.match(patch.prompts[1].prompt, /second/);
});

test("the assets stage builds the SRT, metadata and thumbnail prompt", async () => {
  const gemini = fakeGemini();
  const lines = [
    { seconds: 0, text: "first line" },
    { seconds: 6, text: "second line" },
  ];
  const { patch } = await runStage("assets", { picked: "topic", script: LONG_SCRIPT, lines }, { generate: gemini.generate, config });
  assert.equal(patch.stage, "done");
  assert.match(patch.srt, /^1\n00:00:00,000 --> /);
  assert.equal(patch.meta.title, "Why your brain lies");
  assert.deepEqual(patch.meta.tags, ["brain", "mind", "focus"]);
  assert.match(patch.thumbPrompt, /stick figure under a huge clock/);
});

test("the assets stage fails loudly when Gemini omits the TITLE line", async () => {
  const gemini = fakeGemini({ metadata: "DESCRIPTION:\nno title here" });
  await assert.rejects(
    () => runStage("assets", { picked: "t", script: LONG_SCRIPT, lines: [{ seconds: 0, text: "x" }] }, { generate: gemini.generate, config }),
    /no TITLE line/
  );
});

test("stageDone only reports done when the artefact actually exists", () => {
  assert.equal(stageDone({ srt: "1\n", meta: { title: "t" } }, "assets"), true);
  assert.equal(stageDone({ srt: "1\n", meta: null }, "assets"), false);
  assert.equal(stageDone({ lines: [{ seconds: 0, text: "a" }], prompts: [{ prompt: "p" }] }, "prompts"), true);
  assert.equal(stageDone({ lines: [{ seconds: 0, text: "a" }], prompts: [] }, "prompts"), false);
});

test("assignReuse points duplicates at the first occurrence", () => {
  const reused = assignReuse([{ prompt: "A" }, { prompt: "a " }, { prompt: "B" }]);
  assert.deepEqual(reused.map((p) => p.reuseOf), [null, 0, null]);
});

test("planImages skips regenerating a reused scene", () => {
  const items = planImages([{ seconds: 0, prompt: "A" }, { seconds: 6, prompt: "a" }, { seconds: 12, prompt: "B" }]);
  assert.deepEqual(items.map((i) => i.kind), ["generate", "copy", "generate"]);
  assert.equal(items[1].copyOf, 0);
});

test("planImages honours imagesPerPrompt for generated scenes only", () => {
  const items = planImages([{ seconds: 0, prompt: "A" }, { seconds: 6, prompt: "a" }], { imagesPerPrompt: 3 });
  assert.equal(items.length, 4);
  assert.equal(items.filter((i) => i.kind === "generate").length, 3);
  assert.equal(items.filter((i) => i.kind === "copy").length, 1);
});

test("fallbackPrompt keeps the style guard so one bad line cannot break the look", () => {
  assert.match(fallbackPrompt("a brain on fire"), /no photorealism/);
  assert.match(fallbackPrompt("a brain on fire"), /a brain on fire/);
});

test("progressPercent never goes backwards through the flow", () => {
  const stages = ["idle", "topics", "script", "timestamps", "prompts", "done"];
  const values = stages.map((stage) => progressPercent({ stage, lines: [], promptBatch: 0 }));
  for (let i = 1; i < values.length; i++) assert.ok(values[i] >= values[i - 1], `${stages[i]} went backwards`);
  assert.equal(progressPercent(null), 0);
});
