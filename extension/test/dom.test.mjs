import test from "node:test";
import assert from "node:assert/strict";
import { document as makeDocument, element } from "./helpers/fake-dom.mjs";
import { loadClassicScript } from "./helpers/classic-script.mjs";

// content/dom.js is a classic script; load it the way Node loads CommonJS.
const DOM = loadClassicScript("../content/dom.js");

test("setNativeValue writes through the prototype setter and fires input + change", () => {
  const doc = makeDocument();
  const input = element("input", { value: "" });
  doc.body.appendChild(input);

  let valueOnElement = null;
  Object.defineProperty(input, "value", {
    get: () => valueOnElement,
    set(v) {
      valueOnElement = v;
    },
    configurable: true,
  });

  DOM.setNativeValue(input, "typed text");
  assert.equal(valueOnElement, "typed text");
  assert.deepEqual(input.events.map((e) => e.type), ["input", "change"]);
});

test("setNativeValue falls back to a plain assignment when there is no prototype setter", () => {
  const doc = makeDocument();
  const input = element("textarea");
  doc.body.appendChild(input);
  DOM.setNativeValue(input, "hello");
  assert.equal(input.value, "hello");
  assert.deepEqual(input.events.map((e) => e.type), ["input", "change"]);
});

test("setNativeValue handles contenteditable boxes", () => {
  const doc = makeDocument();
  const box = element("div", { contentEditable: true });
  doc.body.appendChild(box);
  DOM.setNativeValue(box, "rich text");
  assert.equal(box.textContent, "rich text");
  assert.equal(box.focused, true);
  assert.equal(box.events[0].type, "input");
});

test("buildSelector prefers a unique id", () => {
  const doc = makeDocument();
  const box = element("textarea", { id: "prompt-box" });
  doc.body.appendChild(box);
  assert.equal(DOM.buildSelector(box, doc), "#prompt-box");
});

test("buildSelector falls back to a unique data attribute", () => {
  const doc = makeDocument();
  const box = element("textarea", { attributes: { "data-testid": "prompt-input" } });
  doc.body.appendChild(box);
  assert.equal(DOM.buildSelector(box, doc), 'textarea[data-testid="prompt-input"]');
});

test("buildSelector builds an nth-of-type path when nothing else is unique", () => {
  const doc = makeDocument();
  const wrap = element("div");
  doc.body.appendChild(wrap);
  wrap.appendChild(element("textarea"));
  const second = element("textarea");
  wrap.appendChild(second);
  const selector = DOM.buildSelector(second, doc);
  assert.match(selector, /textarea:nth-of-type\(2\)$/);
  assert.equal(doc.querySelectorAll(selector).length, 1);
});

test("resolveInput prefers the learned selector over the adapter guesses", () => {
  const doc = makeDocument();
  const wrong = element("textarea", { attributes: { placeholder: "describe your image" }, rectWidth: 500, rectHeight: 200 });
  const right = element("input", { id: "real-box" });
  doc.body.appendChild(wrong);
  doc.body.appendChild(right);
  const found = DOM.resolveInput(doc, { input: ["textarea"] }, "#real-box");
  assert.equal(found, right);
});

test("resolveInput picks the largest visible textarea when nothing is configured", () => {
  const doc = makeDocument();
  const small = element("textarea", { attributes: { placeholder: "search" }, rectWidth: 120, rectHeight: 24 });
  const big = element("textarea", { attributes: { placeholder: "script" }, rectWidth: 600, rectHeight: 300 });
  doc.body.appendChild(small);
  doc.body.appendChild(big);
  assert.equal(DOM.resolveInput(doc, { input: [] }), big);
});

test("findButton scores an exact label above a substring match", () => {
  const doc = makeDocument();
  const generateAnother = element("button", { text: "Generate another" });
  const generate = element("button", { text: "Generate" });
  doc.body.appendChild(generateAnother);
  doc.body.appendChild(generate);
  assert.equal(DOM.findButton(doc, { words: ["generate"] }), generate);
});

test("findButton ignores hidden, disabled and excluded buttons", () => {
  const doc = makeDocument();
  const hidden = element("button", { text: "Generate", rectWidth: 0, rectHeight: 0 });
  const disabled = element("button", { text: "Generate", disabled: true });
  const cancel = element("button", { text: "Cancel generate" });
  const real = element("button", { text: "Create" });
  for (const el of [hidden, disabled, cancel, real]) doc.body.appendChild(el);
  assert.equal(DOM.findButton(doc, { words: ["generate", "create"], exclude: ["cancel"] }), real);
});

test("findButton reads aria-label when the button has no text", () => {
  const doc = makeDocument();
  const icon = element("button", { text: "", attributes: { "aria-label": "Generate image" } });
  doc.body.appendChild(icon);
  assert.equal(DOM.findButton(doc, { words: ["generate"] }), icon);
});

test("findButton returns null rather than a wrong button", () => {
  const doc = makeDocument();
  doc.body.appendChild(element("button", { text: "Save" }));
  assert.equal(DOM.findButton(doc, { words: ["generate"] }), null);
});

test("scanImages keeps artwork and drops logos, icons and placeholders", () => {
  const doc = makeDocument();
  const art = element("img", { src: "https://cdn.artistly.ai/out/1.png", naturalWidth: 1024, naturalHeight: 1024 });
  const logo = element("img", { src: "https://cdn.artistly.ai/logo.png", naturalWidth: 512, naturalHeight: 512 });
  const tiny = element("img", { src: "https://cdn.artistly.ai/out/2.png", naturalWidth: 64, naturalHeight: 64 });
  const icon = element("img", { src: "https://cdn.artistly.ai/avatar.png", naturalWidth: 512, naturalHeight: 512 });
  for (const el of [art, logo, tiny, icon]) doc.body.appendChild(el);

  const found = DOM.scanImages(doc, { seen: new Set() }, { minWidth: 384, minHeight: 384 });
  // Spread into a local array: scanImages runs in another realm, so deepStrictEqual
  // would reject its Array prototype even when the contents match.
  assert.deepEqual([...found.map((f) => f.src)], ["https://cdn.artistly.ai/out/1.png"]);
});

test("scanImages reports each image once", () => {
  const doc = makeDocument();
  doc.body.appendChild(element("img", { src: "https://cdn.artistly.ai/out/1.png", naturalWidth: 1024, naturalHeight: 1024 }));
  const state = { seen: new Set() };
  assert.equal(DOM.scanImages(doc, state).length, 1);
  assert.equal(DOM.scanImages(doc, state).length, 0);
});

test("scanImages skips an image that has not finished loading", () => {
  const doc = makeDocument();
  doc.body.appendChild(element("img", { src: "https://cdn.artistly.ai/out/1.png", naturalWidth: 1024, naturalHeight: 1024, complete: false }));
  assert.equal(DOM.scanImages(doc, { seen: new Set() }).length, 0);
});

test("scanImages accepts blob urls, which is how a canvas-based site exposes output", () => {
  const doc = makeDocument();
  doc.body.appendChild(element("img", { src: "blob:https://app.artistly.ai/abc", naturalWidth: 1024, naturalHeight: 1024 }));
  assert.equal(DOM.scanImages(doc, { seen: new Set() }).length, 1);
});

test("normalizeText collapses whitespace and case", () => {
  assert.equal(DOM.normalizeText("  Generate   VIDEO "), "generate video");
});
