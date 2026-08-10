import { Bot } from "grammy";
import { generateText } from "ai";
import { createGroq } from "@ai-sdk/groq";
import "dotenv/config";
import http from "http";

const groq = createGroq({
  apiKey: process.env.GROQ_API_KEY,
});

const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN);

bot.on("message:text", async (ctx) => {
  try {
    const { text } = await generateText({
      model: groq("llama-3.3-70b-versatile"),
      prompt: ctx.message.text,
    });
    await ctx.reply(text);
  } catch (error) {
    console.error("Error generating response:", error);
    await ctx.reply("माफ गर्नुहोला, म्यासेज प्रोसेस गर्दा त्रुटि भयो।");
  }
});

bot.start();

const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Bot is running 24/7\n");
}).listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
