import { Bot, InputFile } from "grammy";
import { generateText } from "ai";
import { createGroq } from "@ai-sdk/groq";
import "dotenv/config";
import http from "http";

// The faceless-video pipeline, shared with the Chrome extension and reused here so the
// whole thing also works from the Telegram Android app.
import { createRouter } from "./extension/src/router.js";
import { generate } from "./extension/src/gemini.js";
import { fileStore } from "./server/filestore.mjs";
import { grammyTelegram } from "./server/grammy-adapter.mjs";
import { mobileBrowser } from "./server/mobile-browser.mjs";
import { isVideoCommand } from "./server/commands.mjs";

const groq = createGroq({
  apiKey: process.env.GROQ_API_KEY,
});

const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN);

// ---------- video pipeline over Telegram (mobile-friendly) ----------

let lastChat = null;
const store = fileStore(new URL("./data/video-state.json", import.meta.url).pathname);
const telegram = grammyTelegram({ api: bot.api, makeInputFile: (buf, name) => new InputFile(buf, name) });
const browser = mobileBrowser({
  telegram,
  chatProvider: () => lastChat,
  sendPhoto: (chat, buf, name) => bot.api.sendPhoto(chat, new InputFile(buf, name)).catch(() => {}),
});
const videoRouter = createRouter({
  store,
  telegram,
  gemini: { generate, fetchImpl: (...args) => fetch(...args) },
  browser,
  log: (...args) => console.log("[video]", ...args),
});

// Secrets come from Render env vars, never from code. telegramPolling stays false here
// because grammy (bot.start) is the one receiving updates for this bot.
await store.setConfig({
  geminiKey: process.env.GEMINI_API_KEY || "",
  geminiModel: process.env.GEMINI_MODEL || "gemini-2.5-flash",
  geminiImageModel: process.env.GEMINI_IMAGE_MODEL || "gemini-2.5-flash-image",
  chatId: process.env.VIDEO_CHAT_ID || "",
  telegramPolling: false,
  autoOpenTabs: false,
});

bot.on("message:text", async (ctx) => {
  const text = ctx.message.text;

  if (isVideoCommand(text)) {
    const chatId = ctx.message.chat.id;
    lastChat = chatId;
    const config = await store.getConfig();
    if (config.chatId && String(config.chatId) !== String(chatId)) {
      await ctx.reply("Not authorised for the video agent.").catch(() => {});
      return;
    }
    try {
      await videoRouter.handle(chatId, text);
    } catch (error) {
      console.error("Video command failed:", error);
      await ctx.reply(`Video command failed: ${error.message}`).catch(() => {});
    }
    return;
  }

  // Everything else keeps the original general-purpose Groq behaviour.
  try {
    const { text: answer } = await generateText({
      model: groq("llama-3.3-70b-versatile"),
      system: "Do not use markdown formatting like asterisks (** or *), bold syntax, or hash tags. Send pure plain text without any formatting symbols.",
      prompt: text,
    });
    await ctx.reply(answer);
  } catch (error) {
    console.error("Error generating response:", error);
    await ctx.reply("माफ गर्नुहोला, म्यासेज प्रोसेस गर्दा त्रुटि भयो।");
  }
});

bot.start();

// Render ले Web Port listen गर्न चाहिने Server
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Bot is running 24/7\n");
}).listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
