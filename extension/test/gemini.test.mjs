import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_IMAGE_MODEL, DEFAULT_MODEL, GeminiError, generate, generateImage, listModels } from "../src/gemini.js";

function fakeFetch(scripted = []) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url, init, body: init.body ? JSON.parse(init.body) : null });
    const script = scripted.shift() ?? { status: 200, json: {} };
    return {
      ok: (script.status ?? 200) < 400,
      status: script.status ?? 200,
      headers: { get: (name) => script.headers?.[name.toLowerCase()] ?? null },
      json: async () => script.json ?? {},
      text: async () => (typeof script.text === "string" ? script.text : JSON.stringify(script.json ?? {})),
    };
  };
  return { calls, impl };
}

const okText = (text) => ({
  status: 200,
  json: { candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }] },
});

test("generate authenticates with the header, never the query string", async () => {
  const { calls, impl } = fakeFetch([okText("hello")]);
  await generate({ apiKey: "secret-key", prompt: "hi", fetchImpl: impl, retries: 0 });
  assert.equal(calls[0].init.headers["x-goog-api-key"], "secret-key");
  assert.ok(!calls[0].url.includes("key="), "the key must not appear in the URL");
});

test("generate targets the configured model endpoint", async () => {
  const { calls, impl } = fakeFetch([okText("hello")]);
  await generate({ apiKey: "k", model: "gemini-2.5-flash-lite", prompt: "hi", fetchImpl: impl, retries: 0 });
  assert.equal(calls[0].url, `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent`);
});

test("generate sends the prompt as a user turn and returns the text", async () => {
  const { calls, impl } = fakeFetch([okText("  spaced answer  ")]);
  const result = await generate({ apiKey: "k", prompt: "write a script", fetchImpl: impl, retries: 0 });
  assert.equal(calls[0].body.contents[0].role, "user");
  assert.equal(calls[0].body.contents[0].parts[0].text, "write a script");
  assert.equal(result.text, "  spaced answer  ");
  assert.equal(result.finishReason, "STOP");
});

test("generate refuses to run without a key instead of calling the API", async () => {
  const { calls, impl } = fakeFetch([]);
  await assert.rejects(() => generate({ apiKey: "", prompt: "hi", fetchImpl: impl }), GeminiError);
  assert.equal(calls.length, 0);
});

test("a 404 tells the user how to switch models", async () => {
  const { impl } = fakeFetch([{ status: 404, json: { error: { message: "models/gemini-2.5-flash is not found", status: "NOT_FOUND" } } }]);
  const error = await generate({ apiKey: "k", model: "gemini-2.5-flash", prompt: "hi", fetchImpl: impl, retries: 0 }).catch((e) => e);
  assert.equal(error.status, 404);
  assert.match(error.hint, /\/models/);
  assert.match(error.hint, /\/model/);
});

test("a 429 is retried and then succeeds", async () => {
  const { calls, impl } = fakeFetch([{ status: 429, json: { error: { message: "quota" } } }, okText("ok")]);
  const result = await generate({ apiKey: "k", prompt: "hi", fetchImpl: impl, retries: 1 });
  assert.equal(calls.length, 2);
  assert.equal(result.text, "ok");
});

test("a 400 is not retried", async () => {
  const { calls, impl } = fakeFetch([{ status: 400, json: { error: { message: "API key not valid" } } }]);
  await assert.rejects(() => generate({ apiKey: "k", prompt: "hi", fetchImpl: impl, retries: 3 }), GeminiError);
  assert.equal(calls.length, 1);
});

test("an invalid key explains itself", async () => {
  const { impl } = fakeFetch([{ status: 400, json: { error: { message: "API key not valid. Please pass a valid API key." } } }]);
  const error = await generate({ apiKey: "k", prompt: "hi", fetchImpl: impl, retries: 0 }).catch((e) => e);
  assert.match(error.hint, /Gemini API key was rejected/);
});

test("a safety block surfaces the reason", async () => {
  const { impl } = fakeFetch([{ status: 200, json: { promptFeedback: { blockReason: "SAFETY" } } }]);
  await assert.rejects(() => generate({ apiKey: "k", prompt: "hi", fetchImpl: impl, retries: 0 }), /Blocked by safety filter/);
});

test("MAX_TOKENS is retried, a terminal empty response is not", async () => {
  const retryable = fakeFetch([{ status: 200, json: { candidates: [{ content: { parts: [] }, finishReason: "MAX_TOKENS" }] } }, okText("ok")]);
  assert.equal((await generate({ apiKey: "k", prompt: "hi", fetchImpl: retryable.impl, retries: 1 })).text, "ok");
  assert.equal(retryable.calls.length, 2);

  const terminal = fakeFetch([{ status: 200, json: { candidates: [{ content: { parts: [] }, finishReason: "SAFETY" }] } }]);
  await assert.rejects(() => generate({ apiKey: "k", prompt: "hi", fetchImpl: terminal.impl, retries: 3 }));
  assert.equal(terminal.calls.length, 1);
});

test("generateImage pulls base64 out of inlineData", async () => {
  const { impl } = fakeFetch([
    {
      status: 200,
      json: {
        candidates: [
          {
            content: { parts: [{ text: "here you go" }, { inlineData: { mimeType: "image/png", data: "aGVsbG8=" } }] },
            finishReason: "STOP",
          },
        ],
      },
    },
  ]);
  const images = await generateImage({ apiKey: "k", prompt: "a doodle", fetchImpl: impl, retries: 0 });
  assert.equal(images.length, 1);
  assert.equal(images[0].mimeType, "image/png");
  assert.equal(images[0].data, "aGVsbG8=");
});

test("generateImage explains what to do when the model returns only text", async () => {
  const { impl } = fakeFetch([okText("I cannot draw")]);
  const error = await generateImage({ apiKey: "k", prompt: "a doodle", fetchImpl: impl, retries: 0 }).catch((e) => e);
  assert.match(error.message, /no image data/);
  assert.match(error.hint, /Artistly/);
});

test("generateImage also accepts the snake_case field name", async () => {
  const { impl } = fakeFetch([
    { status: 200, json: { candidates: [{ content: { parts: [{ inline_data: { mime_type: "image/jpeg", data: "abc" } }] } }] } },
  ]);
  const images = await generateImage({ apiKey: "k", prompt: "x", fetchImpl: impl, retries: 0 });
  assert.equal(images[0].mimeType, "image/jpeg");
});

test("listModels strips the models/ prefix and filters to generateContent", async () => {
  const { impl } = fakeFetch([
    {
      status: 200,
      json: {
        models: [
          { name: "models/gemini-2.5-flash", supportedGenerationMethods: ["generateContent"] },
          { name: "models/embedding-001", supportedGenerationMethods: ["embedContent"] },
        ],
      },
    },
  ]);
  const models = await listModels({ apiKey: "k", fetchImpl: impl });
  assert.deepEqual(models.map((m) => m.name), ["gemini-2.5-flash"]);
});

test("the defaults are the models Google still serves", () => {
  assert.equal(DEFAULT_MODEL, "gemini-2.5-flash");
  assert.equal(DEFAULT_IMAGE_MODEL, "gemini-2.5-flash-image");
});
