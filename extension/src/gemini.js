// Minimal Gemini REST client. Dependency-injected fetch so it is unit testable and
// works unchanged in a service worker.

export const DEFAULT_MODEL = "gemini-2.5-flash";
export const DEFAULT_IMAGE_MODEL = "gemini-2.5-flash-image";
export const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";

export class GeminiError extends Error {
  constructor(message, { status, code, model, hint } = {}) {
    super(message);
    this.name = "GeminiError";
    this.status = status;
    this.code = code;
    this.model = model;
    this.hint = hint;
  }
}

const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function hintFor(status, model, body) {
  if (status === 404) {
    return `"${model}" is not available to this API key. Google gates some models per-account. ` +
      `Send /models to list the models your key can call, then /model <name> to switch.`;
  }
  if (status === 400) {
    const msg = String(body?.error?.message || "");
    if (/API key not valid/i.test(msg)) return "The Gemini API key was rejected. Re-check it in the extension options.";
    if (/exceeded|quota/i.test(msg)) return "Request was rejected as too large or quota was exceeded. Try a smaller script.";
  }
  if (status === 401 || status === 403) return "The Gemini API key is invalid or lacks permission for this model.";
  if (status === 429) return "Rate limited. The agent retries automatically; if it persists, wait a minute.";
  return "";
}

/**
 * One generateContent call.
 * @returns {Promise<{text:string, finishReason:string, images:Array<{mimeType:string,data:string}>, raw:object}>}
 */
export async function generate({
  apiKey,
  model = DEFAULT_MODEL,
  prompt,
  temperature = 0.8,
  maxOutputTokens = 8192,
  baseUrl = GEMINI_BASE,
  fetchImpl = fetch,
  retries = 3,
  signal,
  logger = () => {},
}) {
  if (!apiKey) throw new GeminiError("No Gemini API key configured.", { hint: "Open the extension options and paste your key." });

  const url = `${baseUrl}/models/${encodeURIComponent(model)}:generateContent`;
  const body = {
    contents: [{ role: "user", parts: [{ text: String(prompt) }] }],
    generationConfig: { temperature, maxOutputTokens },
  };

  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      const backoff = Math.min(15000, 700 * 2 ** (attempt - 1));
      logger(`gemini retry ${attempt}/${retries} in ${backoff}ms`);
      await sleep(backoff + Math.floor(Math.random() * 250));
    }

    let res;
    try {
      res = await fetchImpl(url, {
        method: "POST",
        // Header auth, not ?key= — keeps the key out of URLs, logs and referrers.
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify(body),
        signal,
      });
    } catch (networkError) {
      lastError = new GeminiError(`Network error: ${networkError.message}`, { model, status: 0 });
      continue;
    }

    let json = {};
    const rawText = await res.text().catch(() => "");
    try {
      json = rawText ? JSON.parse(rawText) : {};
    } catch {
      json = { parseError: rawText.slice(0, 300) };
    }

    if (!res.ok) {
      const message = json?.error?.message || `HTTP ${res.status}`;
      const err = new GeminiError(message, {
        status: res.status,
        code: json?.error?.status,
        model,
        hint: hintFor(res.status, model, json),
      });
      if (RETRYABLE.has(res.status)) {
        const retryAfter = Number(res.headers?.get?.("retry-after"));
        if (Number.isFinite(retryAfter) && retryAfter > 0) await sleep(Math.min(20000, retryAfter * 1000));
        lastError = err;
        continue;
      }
      throw err;
    }

    if (json.promptFeedback?.blockReason) {
      throw new GeminiError(`Blocked by safety filter: ${json.promptFeedback.blockReason}`, { model, status: 200 });
    }

    const candidate = json.candidates?.[0];
    if (!candidate) {
      throw new GeminiError("Gemini returned no candidates.", { model, status: 200, hint: "Try again or rephrase the topic." });
    }

    const parts = candidate.content?.parts || [];
    const text = parts.map((p) => p.text || "").join("");
    const images = parts
      .filter((p) => p.inlineData?.data || p.inline_data?.data)
      .map((p) => {
        const d = p.inlineData || p.inline_data;
        return { mimeType: d.mimeType || d.mime_type || "image/png", data: d.data };
      });

    if (!text && !images.length) {
      const reason = candidate.finishReason || "unknown";
      if (RETRYABLE_EMPTY.has(reason)) {
        lastError = new GeminiError(`Empty response (finishReason=${reason}).`, { model, status: 200 });
        continue;
      }
      throw new GeminiError(`Empty response (finishReason=${reason}).`, { model, status: 200 });
    }

    return { text, finishReason: candidate.finishReason || "STOP", images, raw: json };
  }
  throw lastError || new GeminiError("Gemini request failed.", { model });
}

const RETRYABLE_EMPTY = new Set(["MAX_TOKENS", "RECITATION", "OTHER"]);

/** List the models this key can actually call. Solves Google's per-account model gating. */
export async function listModels({ apiKey, baseUrl = GEMINI_BASE, fetchImpl = fetch, pageSize = 200 }) {
  const res = await fetchImpl(`${baseUrl}/models?pageSize=${pageSize}`, {
    headers: { "x-goog-api-key": apiKey },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new GeminiError(json?.error?.message || `HTTP ${res.status}`, { status: res.status });
  return (json.models || [])
    .filter((m) => (m.supportedGenerationMethods || []).includes("generateContent"))
    .map((m) => ({ name: String(m.name || "").replace(/^models\//, ""), description: m.description || "" }));
}

/** Text-to-image via Gemini (Nano Banana style). Returns base64 PNG/JPEG bytes. */
export async function generateImage(options) {
  const result = await generate({
    ...options,
    model: options.model || DEFAULT_IMAGE_MODEL,
    temperature: options.temperature ?? 1,
    maxOutputTokens: options.maxOutputTokens ?? 8192,
  });
  if (!result.images.length) {
    throw new GeminiError("Image model returned no image data.", {
      model: options.model || DEFAULT_IMAGE_MODEL,
      hint: `Try a different image model with /model, or switch the image provider back to Artistly in options.`,
    });
  }
  return result.images;
}
