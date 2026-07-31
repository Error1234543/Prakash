import { logger } from "./logger.js";

const AI_BASE_URL = "https://router.bynara.id/v1";

// ----- FREE MODELS (from your screenshot) -----
const FREE_MODELS = [
  "mistral-large",          // $0.15 / 1M input
  "agnes-2.5-flash",        // $0.06
  "agnes-2.0-flash",        // $0.03
  "stepfun-3.7-flash",      // $0.04
  "mistral-medium-3-5",     // $0.3
];

// Override via env if you want a specific one
const DEFAULT_MODEL = process.env.BYNARA_MODEL || "mistral-large";

const apiKey = process.env.BYNARA_API_KEY;
if (!apiKey) {
  throw new Error("No API key found. Set BYNARA_API_KEY in environment variables.");
}

export class APIError extends Error {
  public readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "APIError";
    this.status = status;
  }
}

// ... (your buildPrompt, DIAGRAM_TOKENS, isDiagramOption, LETTER_TO_NUM, normaliseBlock, cleanOutput remain exactly the same) ...

/**
 * Calls the Bynara API with a given model.
 * Returns raw content or throws.
 */
async function callBynara(
  base64Image: string,
  model: string,
  startQNum: number,
  mimeType: string = "image/png"
): Promise<string> {
  const body = {
    model,
    max_tokens: 4096,
    temperature: 0.1,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image_url",
            image_url: { url: `data:${mimeType};base64,${base64Image}` },
          },
          { type: "text", text: buildPrompt(startQNum) },
        ],
      },
    ],
  };

  const res = await fetch(`${AI_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new APIError(`Bynara API error: ${res.status} — ${errText}`, res.status);
  }

  const data = (await res.json()) as {
    choices: Array<{ message: { content: string } }>;
  };

  return data.choices[0]?.message?.content?.trim() ?? "";
}

/**
 * Main extraction function with automatic fallback across free models.
 */
export async function extractTextFromBase64Image(
  base64Image: string,
  startQNum: number = 1,
  mimeType: string = "image/png"
): Promise<{ text: string; questionsFound: number }> {
  // Decide which models to try (start with env override, then the whole list)
  let modelsToTry: string[];
  if (process.env.BYNARA_MODEL) {
    modelsToTry = [process.env.BYNARA_MODEL];
  } else {
    modelsToTry = FREE_MODELS;
  }

  let lastError: Error | null = null;

  for (const model of modelsToTry) {
    try {
      logger.info({ model, startQNum }, "Trying model for extraction");
      const raw = await callBynara(base64Image, model, startQNum, mimeType);

      if (raw === "NO_QUESTIONS" || raw.includes("NO_QUESTIONS")) {
        return { text: "", questionsFound: 0 };
      }

      const { cleaned, count } = cleanOutput(raw);
      if (count > 0) {
        logger.info({ model, questionsFound: count, startQNum }, "Extraction successful");
        return { text: cleaned, questionsFound: count };
      } else {
        // Zero valid MCQs – try next model
        logger.warn({ model }, "No valid questions found, trying next model");
        continue;
      }
    } catch (err) {
      logger.error({ model, error: err }, "Model failed, trying next");
      lastError = err;
      continue;
    }
  }

  // All models failed
  const msg = lastError ? `All models failed. Last error: ${lastError.message}` : "No model could extract questions.";
  throw new Error(msg);
}