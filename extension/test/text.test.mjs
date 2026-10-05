import test from "node:test";
import assert from "node:assert/strict";
import {
  chunkText,
  cleanModelText,
  estimateDurationSeconds,
  formatClockstamp,
  formatSrtTime,
  parseClockstamp,
  parseMetadata,
  parseNumberedList,
  parsePromptLines,
  parseTimestampLines,
  wordCount,
  wrapWords,
} from "../src/text.js";

test("cleanModelText strips fences and markdown noise", () => {
  const raw = "```\n1. **First title**\n2. Second title\n```\n";
  assert.equal(cleanModelText(raw), "1. First title\n2. Second title");
});

test("parseNumberedList sorts by the number the model emitted", () => {
  const raw = "3. Third\n1. First\n2. Second";
  assert.deepEqual(parseNumberedList(raw), ["First", "Second", "Third"]);
});

test("parseNumberedList strips quotes and tolerates separators", () => {
  assert.deepEqual(parseNumberedList('1) "Why you forget names"\n2 - How habits form'), [
    "Why you forget names",
    "How habits form",
  ]);
});

test("parseClockstamp handles mm:ss, hh:mm:ss and fractions", () => {
  assert.equal(parseClockstamp("00:06"), 6);
  assert.equal(parseClockstamp("01:30"), 90);
  assert.equal(parseClockstamp("01:02:03"), 3723);
  assert.equal(parseClockstamp("00:01.500"), 1.5);
  assert.equal(parseClockstamp("nonsense"), null);
});

test("formatSrtTime pads every field to SRT width", () => {
  assert.equal(formatSrtTime(0), "00:00:00,000");
  assert.equal(formatSrtTime(61.5), "00:01:01,500");
  assert.equal(formatSrtTime(3723), "01:02:03,000");
});

test("formatClockstamp switches to hours past an hour", () => {
  assert.equal(formatClockstamp(65), "01:05");
  assert.equal(formatClockstamp(3725), "01:02:05");
});

test("parseTimestampLines parses plain, bolded and dashed cues", () => {
  const lines = parseTimestampLines("[00:00] First line\n**[00:06]** Second line\n00:12 - Third line");
  assert.deepEqual(lines, [
    { seconds: 0, text: "First line" },
    { seconds: 6, text: "Second line" },
    { seconds: 12, text: "Third line" },
  ]);
});

test("parseTimestampLines forces non-decreasing timestamps", () => {
  const lines = parseTimestampLines("[00:30] later\n[00:10] earlier");
  assert.deepEqual(lines.map((l) => l.seconds), [30, 30]);
});

test("parseTimestampLines merges continuation lines instead of dropping narration", () => {
  const lines = parseTimestampLines("[00:00] Start of a sentence\nthat keeps going\n[00:06] Next cue");
  assert.equal(lines.length, 2);
  assert.equal(lines[0].text, "Start of a sentence that keeps going");
});

test("parsePromptLines strips the pipe separator", () => {
  const prompts = parsePromptLines("[00:00] | stick figure on tan background\n[00:06] stick figure on blue background");
  assert.equal(prompts.length, 2);
  assert.equal(prompts[0].prompt, "stick figure on tan background");
  assert.equal(prompts[1].prompt, "stick figure on blue background");
});

test("chunkText keeps every character and never splits a surrogate pair", () => {
  const text = `${"😀".repeat(1000)} tail`;
  const chunks = chunkText(text, 500);
  assert.ok(chunks.length > 3);
  assert.equal(chunks.join(""), text);
  for (const chunk of chunks) assert.ok(chunk.length <= 500);
});

test("chunkText prefers a line boundary over a mid-word cut", () => {
  const text = `${"a".repeat(300)}\n${"b".repeat(300)}`;
  const chunks = chunkText(text, 400);
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0], `${"a".repeat(300)}\n`);
  assert.equal(chunks.join(""), text, "chunking must not lose characters");
});

test("chunkText of empty input yields no messages", () => {
  assert.deepEqual(chunkText(""), []);
});

test("no chunk ever exceeds Telegram's 4096 limit", () => {
  // A long script with newlines and spaces, the shape a real /script reply has.
  const text = Array.from({ length: 400 }, (_, i) => `Line ${i} of the narration with several words in it.`).join("\n");
  const chunks = chunkText(text, 4096);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) assert.ok(chunk.length <= 4096, `chunk of ${chunk.length} would be rejected`);
  assert.equal(chunks.join(""), text);
});

test("parseMetadata reads each labelled section", () => {
  const meta = parseMetadata(
    "TITLE: Why you forget names\nDESCRIPTION:\nHook line.\nBody here.\n#brain #memory\nTAGS: memory, brain, focus"
  );
  assert.equal(meta.title, "Why you forget names");
  assert.ok(meta.description.includes("Hook line."));
  assert.deepEqual(meta.tags, ["memory", "brain", "focus"]);
  assert.deepEqual(meta.hashtags, ["#brain", "#memory"]);
});

test("parseMetadata adds the # back when the model forgets it", () => {
  assert.deepEqual(parseMetadata("TITLE: T\nHASHTAGS: brain, memory").hashtags, ["#brain", "#memory"]);
});

test("estimateDurationSeconds follows the words-per-minute setting", () => {
  assert.equal(estimateDurationSeconds("one two three", 60), 3);
  assert.equal(estimateDurationSeconds("", 150), 0);
});

test("wrapWords caps lines and marks dropped text", () => {
  const long = "word ".repeat(30).trim();
  const lines = wrapWords(long, 20, 2);
  assert.equal(lines.length, 2);
  assert.ok(lines.every((l) => l.length <= 24));
  assert.ok(lines[1].endsWith("…"));
});

test("wordCount ignores stray whitespace", () => {
  assert.equal(wordCount("  one   two \n three "), 3);
  assert.equal(wordCount(""), 0);
});
