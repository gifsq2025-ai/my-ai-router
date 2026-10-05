import test from "node:test";
import assert from "node:assert/strict";
import { isVideoCommand } from "./commands.mjs";

test("every pipeline command is routed to the video agent", () => {
  for (const cmd of ["/topics x", "/pick 2", "/approve", "/status", "/srt", "/images 3", "/model gemini-2.5-pro", "/open tools", "/queue", "/pause"]) {
    assert.equal(isVideoCommand(cmd), true, cmd);
  }
});

test("a bare number is treated as picking a topic", () => {
  assert.equal(isVideoCommand("3"), true);
  assert.equal(isVideoCommand("12"), true);
});

test("ordinary chat messages still go to the general bot", () => {
  for (const msg of ["hello", "what is the weather", "3 ways to cook eggs", "/unknownthing", ""]) {
    assert.equal(isVideoCommand(msg), false, msg);
  }
});

test("command matching is case-insensitive", () => {
  assert.equal(isVideoCommand("/APPROVE"), true);
});
