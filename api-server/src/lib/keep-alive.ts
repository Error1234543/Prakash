import https from "node:https";
import http from "node:http";
import { logger } from "./logger.js";

const PING_INTERVAL_MS = 14 * 60 * 1000; // every 14 minutes (Render free tier sleeps at 15m)

function getSelfUrl(port: number): string | null {
  // On Render, RENDER_EXTERNAL_URL is the public URL
  const renderUrl = process.env.RENDER_EXTERNAL_URL;
  if (renderUrl) {
    return `${renderUrl}/api/healthz`;
  }
  // Fallback: ping localhost
  return `http://localhost:${port}/api/healthz`;
}

export function startKeepAlive(port: number): void {
  const url = getSelfUrl(port);
  if (!url) return;

  logger.info({ url }, "Keep-alive pinger started");

  setInterval(() => {
    const lib = url.startsWith("https") ? https : http;
    const req = lib.get(url, (res) => {
      logger.info({ statusCode: res.statusCode }, "Keep-alive ping sent");
    });
    req.on("error", (err) => {
      logger.warn({ err }, "Keep-alive ping failed");
    });
    req.end();
  }, PING_INTERVAL_MS);
}
