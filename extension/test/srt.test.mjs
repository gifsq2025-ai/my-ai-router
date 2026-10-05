import test from "node:test";
import assert from "node:assert/strict";
import { buildSrt, totalDurationSeconds } from "../src/srt.js";

function parseSrt(srt) {
  return srt
    .split("\n\n")
    .filter(Boolean)
    .map((block) => {
      const [index, times, ...rest] = block.split("\n");
      const [start, end] = times.split(" --> ");
      return { index: Number(index), start, end, text: rest.filter((line) => line !== "").join(" ") };
    });
}

const toSeconds = (stamp) => {
  const [h, m, s] = stamp.split(",")[0].split(":").map(Number);
  return h * 3600 + m * 60 + s;
};

test("buildSrt numbers cues sequentially from 1", () => {
  const srt = buildSrt([
    { seconds: 0, text: "alpha" },
    { seconds: 5, text: "beta" },
    { seconds: 10, text: "gamma" },
  ]);
  assert.deepEqual(parseSrt(srt).map((c) => c.index), [1, 2, 3]);
});

test("buildSrt ends each cue before the next one starts", () => {
  const cues = parseSrt(
    buildSrt([
      { seconds: 0, text: "alpha" },
      { seconds: 5, text: "beta" },
      { seconds: 10, text: "gamma" },
    ])
  );
  assert.ok(toSeconds(cues[0].end) < toSeconds(cues[1].start));
  assert.ok(toSeconds(cues[1].end) < toSeconds(cues[2].start));
});

test("buildSrt gives the final cue a words-per-minute duration instead of 1 second", () => {
  const cues = parseSrt(buildSrt([{ seconds: 0, text: "one two three four five six seven eight nine ten" }]));
  const length = toSeconds(cues[0].end) - toSeconds(cues[0].start);
  assert.ok(length >= 3 && length <= 12, `expected a few seconds, got ${length}`);
});

test("buildSrt clamps an absurd gap to the maximum", () => {
  const cues = parseSrt(
    buildSrt([
      { seconds: 0, text: "alpha" },
      { seconds: 600, text: "beta" },
    ])
  );
  assert.ok(toSeconds(cues[0].end) - toSeconds(cues[0].start) <= 12);
});

test("buildSrt drops empty cues without breaking the numbering", () => {
  const cues = parseSrt(
    buildSrt([
      { seconds: 0, text: "alpha" },
      { seconds: 5, text: "   " },
      { seconds: 10, text: "gamma" },
    ])
  );
  assert.deepEqual(cues.map((c) => c.text), ["alpha", "gamma"]);
  assert.deepEqual(cues.map((c) => c.index), [1, 2]);
});

test("buildSrt returns an empty string for no cues rather than a broken file", () => {
  assert.equal(buildSrt([]), "");
});

test("buildSrt output matches the SRT timestamp shape", () => {
  const srt = buildSrt([{ seconds: 0, text: "alpha" }]);
  assert.match(srt, /^1\n\d{2}:\d{2}:\d{2},\d{3} --> \d{2}:\d{2}:\d{2},\d{3}\n/m);
});

test("totalDurationSeconds estimates the runtime from the last cue", () => {
  const total = totalDurationSeconds([
    { seconds: 0, text: "alpha" },
    { seconds: 120, text: "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen" },
  ]);
  assert.ok(total > 120 && total < 130, `got ${total}`);
});
