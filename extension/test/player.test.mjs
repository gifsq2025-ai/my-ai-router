import test from "node:test";
import assert from "node:assert/strict";
import { document as makeDocument } from "./helpers/fake-dom.mjs";
import { loadClassicScript } from "./helpers/classic-script.mjs";

const PLAYER = loadClassicScript("../content/player.js");

function docWithVideos(videos) {
  const doc = makeDocument();
  doc.querySelectorAll = (selector) => (selector === "video" ? videos : []);
  return doc;
}

const shortClip = { duration: 15, currentTime: 0, paused: true, volume: 1, muted: false, playbackRate: 1, play() {}, pause() {} };
const main = {
  duration: 600,
  currentTime: 10,
  paused: true,
  volume: 1,
  muted: false,
  playbackRate: 1,
  played: 0,
  textTracks: [],
  play() {
    this.played++;
    this.paused = false;
  },
  pause() {
    this.paused = true;
  },
};

test("pickVideo chooses the longest video, ignoring previews and ads", () => {
  assert.equal(PLAYER.pickVideo(docWithVideos([shortClip, main])), main);
});

test("every tool reports clearly when the page has no video", () => {
  const doc = docWithVideos([]);
  for (const tool of ["play", "pause", "seek", "skip", "speed", "volume", "mute", "state", "get_captions"]) {
    assert.equal(PLAYER.runTool(doc, tool, { value: 1 }), "no video on this page");
  }
});

test("play and pause control the video", () => {
  const doc = docWithVideos([main]);
  assert.equal(PLAYER.runTool(doc, "play"), "playing");
  assert.equal(main.played, 1);
  assert.equal(PLAYER.runTool(doc, "pause"), "paused");
});

test("seek clamps to the video length", () => {
  const doc = docWithVideos([main]);
  PLAYER.runTool(doc, "seek", { value: 99999 });
  assert.equal(main.currentTime, 600);
  PLAYER.runTool(doc, "seek", { value: -50 });
  assert.equal(main.currentTime, 0);
});

test("seek rejects a non-numeric argument", () => {
  assert.match(PLAYER.runTool(docWithVideos([main]), "seek", { text: "the middle" }), /needs a number/);
});

test("skip moves relative to the current position", () => {
  const doc = docWithVideos([main]);
  main.currentTime = 100;
  PLAYER.runTool(doc, "skip", { value: 30 });
  assert.equal(main.currentTime, 130);
  PLAYER.runTool(doc, "skip", { value: -200 });
  assert.equal(main.currentTime, 0);
});

test("speed validates its range", () => {
  const doc = docWithVideos([main]);
  assert.equal(PLAYER.runTool(doc, "speed", { value: 1.5 }), "speed 1.5x");
  assert.equal(main.playbackRate, 1.5);
  assert.match(PLAYER.runTool(doc, "speed", { value: 50 }), /between 0.25 and 16/);
});

test("volume accepts both 0-1 and 0-100", () => {
  const doc = docWithVideos([main]);
  PLAYER.runTool(doc, "volume", { value: 0.4 });
  assert.equal(main.volume, 0.4);
  PLAYER.runTool(doc, "volume", { value: 80 });
  assert.equal(main.volume, 0.8);
});

test("mute toggles", () => {
  const doc = docWithVideos([main]);
  main.muted = false;
  assert.equal(PLAYER.runTool(doc, "mute"), "muted");
  assert.equal(PLAYER.runTool(doc, "mute"), "unmuted");
});

test("state reports time, length and speed", () => {
  const doc = docWithVideos([main]);
  main.currentTime = 42;
  const state = PLAYER.runTool(doc, "state");
  assert.equal(state.currentTime, 42);
  assert.equal(state.duration, 600);
  assert.equal(typeof state.paused, "boolean");
});

test("get_captions enables a disabled track before reading cues", () => {
  const track = { language: "en", mode: "disabled", cues: [{ startTime: 0, text: "Hello there" }] };
  const video = { ...main, textTracks: [track] };
  const text = PLAYER.runTool(docWithVideos([video]), "get_captions");
  assert.equal(track.mode, "hidden");
  assert.equal(text, "[0s] Hello there");
});

test("get_captions distinguishes 'no track' from 'not loaded yet'", () => {
  assert.equal(PLAYER.runTool(docWithVideos([{ ...main, textTracks: [] }]), "get_captions"), "no captions on this video");
  const empty = { ...main, textTracks: [{ language: "en", mode: "showing", cues: [] }] };
  assert.match(PLAYER.runTool(docWithVideos([empty]), "get_captions"), /not loaded yet/);
});

test("an unknown tool lists what is available", () => {
  assert.match(PLAYER.runTool(docWithVideos([main]), "rewind"), /Available: play, pause/);
});
