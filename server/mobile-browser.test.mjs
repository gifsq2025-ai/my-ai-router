import test from "node:test";
import assert from "node:assert/strict";
import { mobileBrowser, SITE_URLS } from "./mobile-browser.mjs";

function harness(chat = 42) {
  const sent = [];
  const photos = [];
  const telegram = { sendText: async (id, text) => sent.push({ id, text }) };
  const sendPhoto = async (id, buf, name) => photos.push({ id, name, bytes: buf.length });
  const browser = mobileBrowser({ telegram, chatProvider: () => chat, sendPhoto });
  return { sent, photos, browser };
}

test("openSites sends the phone user the links instead of opening tabs", async () => {
  const { sent, browser } = harness();
  await browser.openSites(["clonevoice", "videoexpress"]);
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /app\.clonevoice\.ai/);
  assert.match(sent[0].text, /app\.videoexpress\.ai/);
});

test("notifySite explains that auto-fill is desktop-only", async () => {
  const { browser } = harness();
  const result = await browser.notifySite("artistly", {});
  assert.equal(result.ok, false);
  assert.match(result.error, /desktop/);
});

test("downloadDataUrl decodes the image and sends it as a photo", async () => {
  const { photos, browser } = harness();
  const b64 = Buffer.from("fakepng", "utf8").toString("base64");
  const result = await browser.downloadDataUrl({ dataUrl: `data:image/png;base64,${b64}`, filename: "viral/img_000.png" });
  assert.equal(result.ok, true);
  assert.equal(photos.length, 1);
  assert.equal(photos[0].name, "viral/img_000.png");
  assert.equal(photos[0].bytes, Buffer.from("fakepng", "utf8").length);
});

test("downloadDataUrl with no chat reports a failure instead of crashing", async () => {
  const { browser } = harness(null);
  const result = await browser.downloadDataUrl({ dataUrl: "data:image/png;base64,AA==", filename: "x.png" });
  assert.equal(result.ok, false);
});

test("site urls point at the three dashboards", () => {
  assert.equal(Object.keys(SITE_URLS).length, 3);
  assert.match(SITE_URLS.artistly, /artistly\.ai/);
});
