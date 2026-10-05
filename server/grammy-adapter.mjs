// Bridges the router's transport-agnostic telegram interface onto grammy's bot.api.
// `makeInputFile` is injected (index.js passes grammy's InputFile) so this module stays
// testable without importing grammy.
import { chunkText } from "../extension/src/text.js";

export function grammyTelegram({ api, makeInputFile }) {
  return {
    async sendText(chatId, text) {
      for (const chunk of chunkText(text, 3900)) {
        await api.sendMessage(chatId, chunk).catch(() => {});
      }
    },
    async sendDocument(chatId, filename, content) {
      await api.sendDocument(chatId, makeInputFile(Buffer.from(String(content), "utf8"), filename));
    },
    async sendChatAction(chatId, action) {
      await api.sendChatAction(chatId, action).catch(() => {});
    },
  };
}
