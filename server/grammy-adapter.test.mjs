import test from "node:test";
import assert from "node:assert/strict";
import { grammyTelegram } from "./grammy-adapter.mjs";

function fakeApi() {
  const calls = [];
  return {
    calls,
    sendMessage: async (chat, text) => calls.push({ method: "sendMessage", chat, text }),
    sendDocument: async (chat, file) => calls.push({ method: "sendDocument", chat, file }),
    sendChatAction: async (chat, action) => calls.push({ method: "sendChatAction", chat, action }),
  };
}

test("long text is split into Telegram-sized messages", async () => {
  const api = fakeApi();
  const tg = grammyTelegram({ api, makeInputFile: (buf, name) => ({ buf, name }) });
  await tg.sendText(7, "x".repeat(9000));
  const sends = api.calls.filter((c) => c.method === "sendMessage");
  assert.equal(sends.length, 3);
  for (const s of sends) assert.ok(s.text.length <= 4096);
});

test("sendDocument wraps the bytes in an input file with the filename", async () => {
  const api = fakeApi();
  const tg = grammyTelegram({ api, makeInputFile: (buf, name) => ({ buf, name }) });
  await tg.sendDocument(7, "captions.srt", "1\n00:00:00,000 --> 00:00:04,000\nhi\n");
  const doc = api.calls.find((c) => c.method === "sendDocument");
  assert.equal(doc.file.name, "captions.srt");
  assert.equal(doc.file.buf.toString("utf8"), "1\n00:00:00,000 --> 00:00:04,000\nhi\n");
});

test("sendChatAction failures are swallowed so the pipeline keeps going", async () => {
  const api = fakeApi();
  api.sendChatAction = async () => {
    throw new Error("boom");
  };
  const tg = grammyTelegram({ api, makeInputFile: (b, n) => ({ b, n }) });
  await tg.sendChatAction(7, "typing"); // must not throw
  assert.ok(true);
});
