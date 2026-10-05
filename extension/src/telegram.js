import { chunkText } from "./text.js";

export const TELEGRAM_BASE = "https://api.telegram.org";

export class TelegramError extends Error {
  constructor(message, { status, code, description, hint } = {}) {
    super(message);
    this.name = "TelegramError";
    this.status = status;
    this.code = code;
    this.description = description;
    this.hint = hint;
  }
}

/**
 * Telegram Bot API client.
 *
 * Notable: Telegram answers 409 when a second process long-polls the same token.
 * That is exactly what happens if the Render bot in ../index.js is still running,
 * so we detect it and say so instead of silently losing messages.
 */
export class TelegramClient {
  constructor({ token, fetchImpl, baseUrl = TELEGRAM_BASE, logger = () => {} }) {
    if (!token) throw new TelegramError("No Telegram bot token configured.");
    this.token = token;
    // Resolved per call rather than captured here: the worker caches one client per
    // token, and binding `fetch` at construction would freeze whatever was global then.
    this.fetchImpl = fetchImpl || ((...args) => fetch(...args));
    this.baseUrl = baseUrl;
    this.logger = logger;
  }

  async call(method, payload = {}) {
    const res = await this.fetchImpl(`${this.baseUrl}/bot${this.token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.ok === false) {
      const description = json.description || `HTTP ${res.status}`;
      throw new TelegramError(description, {
        status: res.status,
        code: json.error_code,
        description,
        hint: hintFor(res.status, json.error_code, description),
      });
    }
    return json.result;
  }

  /** Long-poll. Returns { updates, ok }. Never throws on transport errors. */
  async getUpdates({ offset = 0, timeout = 25 } = {}) {
    try {
      const updates = await this.call("getUpdates", { offset, timeout, allowed_updates: ["message"] });
      return { updates: updates || [], ok: true };
    } catch (error) {
      // 409 is normal-ish during a handover; anything else deserves a hint.
      if (error.status === 409) {
        this.logger("telegram conflict: another process is polling this bot");
        return { updates: [], ok: false, conflict: true, error };
      }
      return { updates: [], ok: false, error };
    }
  }

  /** Send text, split into Telegram-safe chunks. */
  async sendText(chatId, text, extra = {}) {
    const chunks = chunkText(text, 3900);
    if (!chunks.length) return [];
    const out = [];
    for (const chunk of chunks) {
      out.push(await this.call("sendMessage", { chat_id: chatId, text: chunk, ...extra }));
    }
    return out;
  }

  /** Upload a text file. Blob/FormData are available in service workers. */
  async sendDocument(chatId, filename, content, caption) {
    const form = new FormData();
    form.append("chat_id", String(chatId));
    if (caption) form.append("caption", String(caption).slice(0, 1000));
    form.append("document", new Blob([String(content)], { type: "text/plain;charset=utf-8" }), filename);
    const res = await this.fetchImpl(`${this.baseUrl}/bot${this.token}/sendDocument`, { method: "POST", body: form });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.ok === false) {
      throw new TelegramError(json.description || `HTTP ${res.status}`, { status: res.status, description: json.description });
    }
    return json.result;
  }

  async sendChatAction(chatId, action = "typing") {
    return this.call("sendChatAction", { chat_id: chatId, action }).catch(() => null);
  }
}

function hintFor(status, code, description) {
  if (status === 409 || code === 409) {
    return "Another process is already polling this bot token (for example the Render bot in index.js). " +
      "Either stop that bot or create a second bot with @BotFather and use its token here.";
  }
  if (status === 401 || code === 401) return "Bot token rejected by Telegram. Re-copy it from @BotFather.";
  if (status === 400 && /chat not found/i.test(String(description))) {
    return "Bot has never been messaged by this chat id. Send /start to your bot first.";
  }
  if (code === 429) return "Telegram rate limit. Slow down.";
  return "";
}

/** Confirm a token works and return the bot's own username. */
export async function verifyToken({ token, fetchImpl = fetch, baseUrl = TELEGRAM_BASE }) {
  const client = new TelegramClient({ token, fetchImpl, baseUrl });
  const me = await client.call("getMe");
  return { id: me.id, username: me.username, firstName: me.first_name };
}

/**
 * Pull the chat id of whoever last messaged the bot.
 * Used by the options page so the user never has to find their own numeric id.
 */
export async function discoverChatId({ token, fetchImpl = fetch, baseUrl = TELEGRAM_BASE }) {
  const client = new TelegramClient({ token, fetchImpl, baseUrl });
  const updates = await client.call("getUpdates", { limit: 20, timeout: 0 });
  const chats = [];
  for (const u of updates || []) {
    const chat = u.message?.chat || u.channel_post?.chat || u.callback_query?.message?.chat;
    if (chat && !chats.some((c) => c.id === chat.id)) {
      chats.push({ id: chat.id, title: chat.title || chat.username || chat.first_name || "unknown" });
    }
  }
  return chats;
}
