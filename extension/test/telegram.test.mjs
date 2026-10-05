import test from "node:test";
import assert from "node:assert/strict";
import { TelegramClient, discoverChatId, verifyToken } from "../src/telegram.js";

function fakeFetch(scripted = []) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url, init });
    const script = scripted.shift() ?? { status: 200, json: { ok: true, result: [] } };
    return {
      ok: (script.status ?? 200) < 400,
      status: script.status ?? 200,
      json: async () => script.json ?? { ok: true, result: [] },
    };
  };
  return { calls, impl };
}

const okResult = (result) => ({ status: 200, json: { ok: true, result } });

test("sendText splits a long message into Telegram-sized chunks", async () => {
  const { calls, impl } = fakeFetch();
  const client = new TelegramClient({ token: "t", fetchImpl: impl });
  await client.sendText(42, "x".repeat(9000));
  assert.equal(calls.length, 3);
  for (const call of calls) {
    assert.ok(call.url.endsWith("/sendMessage"));
    assert.ok(JSON.parse(call.init.body).text.length <= 4096);
  }
});

test("sendText of an empty string sends nothing", async () => {
  const { calls, impl } = fakeFetch();
  await new TelegramClient({ token: "t", fetchImpl: impl }).sendText(42, "");
  assert.equal(calls.length, 0);
});

test("a 409 conflict is reported, not thrown, and names the Render bot", async () => {
  const { impl } = fakeFetch([{ status: 409, json: { ok: false, error_code: 409, description: "Conflict: terminated by other getUpdates request" } }]);
  const client = new TelegramClient({ token: "t", fetchImpl: impl });
  const outcome = await client.getUpdates({ offset: 0 });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.conflict, true);
  assert.match(outcome.error.hint, /Render bot/);
});

test("a bad token stops polling instead of hammering Telegram", async () => {
  const { impl } = fakeFetch([{ status: 401, json: { ok: false, error_code: 401, description: "Unauthorized" } }]);
  const outcome = await new TelegramClient({ token: "bad", fetchImpl: impl }).getUpdates({ offset: 0 });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error.status, 401);
  assert.match(outcome.error.hint, /Bot token rejected/);
});

test("sendDocument uploads the file under the right field name", async () => {
  const { calls, impl } = fakeFetch([okResult({ message_id: 1 })]);
  await new TelegramClient({ token: "t", fetchImpl: impl }).sendDocument(42, "captions.srt", "1\n00:00:00,000 --> 00:00:04,000\nhi\n");
  assert.ok(calls[0].url.endsWith("/sendDocument"));
  const form = calls[0].init.body;
  assert.equal(form.get("chat_id"), "42");
  assert.equal(form.get("document").name, "captions.srt");
  assert.equal(await form.get("document").text(), "1\n00:00:00,000 --> 00:00:04,000\nhi\n");
});

test("getUpdates long-polls with an offset", async () => {
  const { calls, impl } = fakeFetch([okResult([{ update_id: 7, message: { chat: { id: 42 }, text: "/status" } }])]);
  const { updates } = await new TelegramClient({ token: "t", fetchImpl: impl }).getUpdates({ offset: 7, timeout: 25 });
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.offset, 7);
  assert.equal(body.timeout, 25);
  assert.equal(updates[0].message.text, "/status");
});

test("verifyToken returns the bot username", async () => {
  const { impl } = fakeFetch([okResult({ id: 1, username: "my_video_bot", first_name: "V" })]);
  const me = await verifyToken({ token: "t", fetchImpl: impl });
  assert.equal(me.username, "my_video_bot");
});

test("discoverChatId dedupes chats and labels them", async () => {
  const { impl } = fakeFetch([
    okResult([
      { message: { chat: { id: 111, first_name: "Me" } } },
      { message: { chat: { id: 111, first_name: "Me" } } },
      { message: { chat: { id: 222, title: "Group" } } },
    ]),
  ]);
  const chats = await discoverChatId({ token: "t", fetchImpl: impl });
  assert.deepEqual(chats, [
    { id: 111, title: "Me" },
    { id: 222, title: "Group" },
  ]);
});

test("a client without a token fails immediately", async () => {
  assert.throws(() => new TelegramClient({ token: "" }), /No Telegram bot token/);
});
