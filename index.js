bot.on("message:text", async (ctx) => {
  try {
    const { text } = await generateText({
      model: groq("llama-3.3-70b-versatile"),
      system: "Do not use markdown formatting, bold text, asterisks (**), or special symbols in your responses. Output clean, plain text only.",
      prompt: ctx.message.text,
    });
    await ctx.reply(text);
  } catch (error) {
    console.error("Error generating response:", error);
    await ctx.reply("माफ गर्नुहोला, म्यासेज प्रोसेस गर्दा त्रुटि भयो।");
  }
});
