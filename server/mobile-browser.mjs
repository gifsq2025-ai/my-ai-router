// On a phone there is no browser to automate, so the "browser" actions degrade into
// helpful Telegram messages: links to open, and generated images sent as photos.
export const SITE_URLS = {
  clonevoice: "https://app.clonevoice.ai/dashboard",
  artistly: "https://app.artistly.ai/dashboard",
  videoexpress: "https://app.videoexpress.ai/",
};

export function mobileBrowser({ telegram, chatProvider, sendPhoto }) {
  return {
    async openSites(names) {
      const chat = chatProvider();
      const urls = (names || []).map((n) => SITE_URLS[n]).filter(Boolean);
      if (chat && urls.length) {
        await telegram.sendText(chat, "Open these on your phone, then upload the files I sent:\n" + urls.join("\n"));
      }
      return names;
    },
    async notifySite() {
      return { ok: false, error: "Auto-fill runs in the desktop extension. On mobile, open the site and upload the files the bot sent." };
    },
    async sendToActiveTab() {
      return "Video playback tools run in the desktop extension.";
    },
    async downloadDataUrl({ dataUrl, filename }) {
      const chat = chatProvider();
      if (!chat || !sendPhoto) return { ok: false, error: "no chat to send to" };
      const base64 = String(dataUrl).split(",")[1] || "";
      if (!base64) return { ok: false, error: "bad data url" };
      await sendPhoto(chat, Buffer.from(base64, "base64"), filename);
      return { ok: true };
    },
  };
}
