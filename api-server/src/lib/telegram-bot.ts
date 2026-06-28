import TelegramBot from "node-telegram-bot-api";
import axios from "axios";
import { pdfBufferToBase64Images } from "./pdf-to-images.js";
import { extractTextFromBase64Image, APIError } from "./ai-client.js";
import { logger } from "./logger.js";

const WELCOME_MESSAGE = `👋 Namaste! Main Gujarati OCR Bot hu.

📄 Mujhe koi bhi PDF bhejo aur main uske questions extract karke is format mein dunga:

Q1. [Question Text]
(1) Option A
(2) Option B
(3) Option C
(4) Option D
ANS: [Correct Option Number]

✅ Gujarati language fully supported
📎 Bas PDF file bhejo — main baaki kaam kar lunga!`;

export function startTelegramBot(): TelegramBot {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not set");

  const bot = new TelegramBot(token, { polling: true });
  logger.info("Telegram bot started with polling");

  bot.onText(/\/start/, (msg) => bot.sendMessage(msg.chat.id, WELCOME_MESSAGE));
  bot.onText(/\/help/, (msg) => bot.sendMessage(msg.chat.id, WELCOME_MESSAGE));

  bot.on("document", async (msg) => {
    const chatId = msg.chat.id;
    const doc = msg.document;
    if (!doc) return;

    if (doc.mime_type !== "application/pdf") {
      await bot.sendMessage(chatId, "❌ Sirf PDF file bhejo.");
      return;
    }
    if (doc.file_size && doc.file_size > 20 * 1024 * 1024) {
      await bot.sendMessage(chatId, "❌ File 20MB se badi hai. Chhoti file bhejo.");
      return;
    }

    const statusMsg = await bot.sendMessage(chatId, "⏳ PDF receive hui. Processing shuru...");
    const edit = (text: string) =>
      bot.editMessageText(text, { chat_id: chatId, message_id: statusMsg.message_id }).catch(() => {});

    try {
      // Step 1: Download PDF
      await edit("📥 PDF download ho rahi hai...");
      const fileLink = await bot.getFileLink(doc.file_id);
      const res = await axios.get<ArrayBuffer>(fileLink, {
        responseType: "arraybuffer",
        timeout: 60_000,
      });
      const pdfBuffer = Buffer.from(res.data);
      logger.info({ fileSize: pdfBuffer.length, fileName: doc.file_name }, "PDF downloaded");

      // Step 2: Convert pages to images
      await edit("🔄 PDF ko images mein convert kar raha hu...");
      const images = await pdfBufferToBase64Images(pdfBuffer);

      if (images.length === 0) {
        await edit("❌ PDF mein koi page nahi mili.");
        return;
      }

      await edit(`📄 ${images.length} pages mili. AI se text extract kar raha hu...`);

      // Step 3: Extract MCQs from each page
      const parts: string[] = [];
      let runningQNum = 1;
      let rateLimitHit = false;

      for (let i = 0; i < images.length; i++) {
        await edit(
          `🧠 Page ${i + 1}/${images.length} process ho rahi hai... (Q${runningQNum} se shuru)`
        );

        try {
          const { text, questionsFound } = await extractTextFromBase64Image(
            images[i],
            runningQNum
          );
          if (text) {
            parts.push(text);
            runningQNum += questionsFound;
          }
        } catch (err) {
          if (err instanceof APIError && err.status === 429) {
            rateLimitHit = true;
            logger.error(err, "API rate limit hit");
            await edit(
              `⚠️ API rate limit aa gayi!\n\n` +
              `✅ ${i} pages process ho gayi (${runningQNum - 1} questions).\n` +
              `❌ ${images.length - i} pages baaki hain.\n\n` +
              `🕐 Thodi der baad dobara same PDF bhejo.`
            );
            break;
          }

          // Non-rate-limit error on a single page — skip and continue
          logger.error(err, `Failed to process page ${i + 1}`);
          parts.push(`[Page ${i + 1} process nahi ho saki — skip]`);
        }
      }

      // No results at all
      if (parts.length === 0) {
        if (!rateLimitHit) {
          await edit("❌ Koi text extract nahi ho saka. Dobara try karo.");
        }
        return;
      }

      // Send results
      const fullText = parts.join("\n\n");
      const totalQ = runningQNum - 1;

      if (!rateLimitHit) {
        await edit(`✅ Done! ${totalQ} questions extract hue. Result bhej raha hu...`);
      }

      if (fullText.length <= 4000) {
        await bot.sendMessage(chatId, fullText);
      } else {
        const buf = Buffer.from(fullText, "utf-8");
        await bot.sendDocument(
          chatId,
          buf,
          { caption: `✅ ${totalQ} questions — ${images.length} pages — "${doc.file_name ?? "PDF"}"` },
          { filename: "extracted_questions.txt", contentType: "text/plain; charset=utf-8" }
        );
      }
    } catch (err) {
      logger.error(err, "Unexpected error processing PDF");
      await edit(
        "❌ Unexpected error aaya. Dobara PDF bhejo.\n\n/help — bot info"
      ).catch(() => bot.sendMessage(chatId, "❌ Error. Dobara try karo."));
    }
  });

  bot.on("message", (msg) => {
    if (msg.document || (msg.text && msg.text.startsWith("/"))) return;
    bot.sendMessage(msg.chat.id, "📎 PDF file bhejo.\n\n/help — bot info");
  });

  bot.on("polling_error", (err) => logger.error(err, "Telegram polling error"));

  return bot;
}
