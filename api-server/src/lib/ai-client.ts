import { logger } from "./logger.js";

const NVIDIA_URL = "https://ai.api.nvidia.com/v1/cv/nvidia/nemotron-ocr-v2";
const apiKey = process.env.NVIDIA_API_KEY;

if (!apiKey) {
  throw new Error("No API key found. Set NVIDIA_API_KEY in environment variables.");
}

export class APIError extends Error {
  public readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "APIError";
    this.status = status;
  }
}

export async function extractTextFromBase64Image(
  base64Image: string,
  startQNum: number = 1,
  mimeType: string = "image/png"
): Promise<{ text: string; questionsFound: number }> {

  // Step 1: NVIDIA OCR — image se raw text nikalo
  const res = await fetch(NVIDIA_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Accept": "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      input: [
        {
          type: "image_url",
          url: `data:${mimeType};base64,${base64Image}`,
        },
      ],
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    logger.error({ status: res.status, body: errText }, "NVIDIA OCR error");
    throw new APIError(`NVIDIA OCR error: ${res.status} — ${errText}`, res.status);
  }

  const data = (await res.json()) as {
    output?: Array<{ text?: string }>;
  };

  const rawText = data.output?.[0]?.text?.trim() ?? "";

  if (!rawText) {
    return { text: "", questionsFound: 0 };
  }

  // Step 2: AI se MCQ format + ANS lagao
  const aiRes = await fetch("https://router.bynara.id/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${process.env.BYNARA_API_KEY}`,
    },
    body: JSON.stringify({
      model: "mimo-v2.5-free",
      max_tokens: 4096,
      temperature: 0.1,
      messages: [
        {
          role: "user",
          content: `You are an expert for Gujarati science exam MCQs.

Below is raw OCR text from an exam page. Extract MCQs and format them like this:

Q${startQNum}. [question]
(1) option
(2) option
(3) option
(4) option
ANS: [1/2/3/4]

Rules:
- Start from Q${startQNum}. and number sequentially
- Use (1)(2)(3)(4) always, convert A/B/C/D → 1/2/3/4
- ANS must be 1, 2, 3, or 4 only
- Keep Gujarati text as-is
- Skip incomplete questions
- If no MCQs found → output: NO_QUESTIONS

RAW TEXT:
${rawText}`,
        },
      ],
    }),
  });

  if (!aiRes.ok) {
    const errText = await aiRes.text().catch(() => "");
    logger.error({ status: aiRes.status, body: errText }, "Bynara AI error");
    throw new APIError(`Bynara AI error: ${aiRes.status}`, aiRes.status);
  }

  const aiData = (await aiRes.json()) as {
    choices: Array<{ message: { content: string } }>;
  };

  const raw = aiData.choices[0]?.message?.content?.trim() ?? "";

  if (!raw || raw.includes("NO_QUESTIONS")) {
    return { text: "", questionsFound: 0 };
  }

  const blocks = raw.split(/(?=^Q\d+\.)/m).filter(b => b.trim());
  const count = blocks.length;

  logger.info({ questionsFound: count, startQNum }, "Page extracted");
  return { text: raw.trim(), questionsFound: count };
}