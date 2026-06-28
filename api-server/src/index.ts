import app from "./app.js";
import { logger } from "./lib/logger.js";
import { startTelegramBot } from "./lib/telegram-bot.js";
import { startKeepAlive } from "./lib/keep-alive.js";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error("PORT environment variable is required but was not provided.");
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }
  logger.info({ port }, "Server listening");

  // Keep the server awake by self-pinging every 4 minutes
  startKeepAlive(port);
});

// Start Telegram bot
try {
  startTelegramBot();
} catch (err) {
  logger.error(err, "Failed to start Telegram bot");
  process.exit(1);
}
