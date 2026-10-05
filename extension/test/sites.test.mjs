import test from "node:test";
import assert from "node:assert/strict";
import { loadClassicScript } from "./helpers/classic-script.mjs";

const { SITES, selectorsFor, siteForLocation } = loadClassicScript("../content/sites.js");

test("siteForLocation maps each dashboard hostname", () => {
  assert.equal(siteForLocation({ hostname: "app.clonevoice.ai" }).key, "clonevoice");
  assert.equal(siteForLocation({ hostname: "app.artistly.ai" }).key, "artistly");
  assert.equal(siteForLocation({ hostname: "app.videoexpress.ai" }).key, "videoexpress");
});

test("siteForLocation matches subdomains but not lookalike domains", () => {
  assert.equal(siteForLocation({ hostname: "cdn.artistly.ai" }).key, "artistly");
  assert.equal(siteForLocation({ hostname: "notartistly.ai" }), null);
  assert.equal(siteForLocation({ hostname: "youtube.com" }), null);
});

test("only Artistly clicks on its own — voice choice is a human decision", () => {
  assert.equal(SITES.clonevoice.autoClick, false);
  assert.equal(SITES.artistly.autoClick, true);
  assert.equal(SITES.videoexpress.autoClick, false);
});

test("selectorsFor exposes the built-in button words", () => {
  const sels = selectorsFor(SITES.artistly, {});
  assert.deepEqual(sels.words.generate, SITES.artistly.buttons.generate);
  assert.equal(sels.input, "");
});

test("a learned selector overrides the guesses", () => {
  const sels = selectorsFor(SITES.artistly, { artistly: { input: "#prompt", generate: "#go" } });
  assert.equal(sels.input, "#prompt");
  assert.equal(sels.buttons.generate, "#go");
});

test("one site's overrides do not leak into another's", () => {
  const sels = selectorsFor(SITES.clonevoice, { artistly: { input: "#prompt" } });
  assert.equal(sels.input, "");
});

test("every site profile has the fields the content script reads", () => {
  for (const site of Object.values(SITES)) {
    assert.ok(site.url.startsWith("https://"), `${site.key} url`);
    assert.ok(site.hosts.length > 0, `${site.key} hosts`);
    assert.ok(site.buttons.generate.length > 0, `${site.key} button words`);
    assert.ok(site.instructions.length > 0, `${site.key} instructions`);
  }
});
