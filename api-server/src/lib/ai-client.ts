import { logger } from "./logger.js";

const AI_BASE_URL = "https://router.bynara.id/v1";
const VISION_MODEL = "claude-sonnet-4.6";
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

function buildPrompt(startQNum: number): string {
  return `You are an expert OCR assistant for Gujarati-medium science exam papers (chemistry, biology, physics).

Extract ONLY standard MCQs — questions that have readable text and exactly 4 options (1)(2)(3)(4).

━━━ OUTPUT FORMAT (follow exactly) ━━━
Q${startQNum}. [question text in Gujarati/English]
(1) [option text]
(2) [option text]
(3) [option text]
(4) [option text]
ANS: [1 or 2 or 3 or 4]

━━━ NUMBERING ━━━
- IGNORE printed question numbers in the image.
- Start from Q${startQNum}. and count up sequentially.

━━━ OPTION FORMAT — CRITICAL ━━━
- ALWAYS use (1)(2)(3)(4) for options — even if the image shows (A)(B)(C)(D).
  Convert: A→(1), B→(2), C→(3), D→(4)
- ANS must ALWAYS be a single digit: 1, 2, 3, or 4.
  Convert: A→1, B→2, C→3, D→4
- Never use letters (A/B/C/D) in options or ANS.

━━━ WHAT TO SKIP — DO NOT OUTPUT THESE ━━━
Skip a question entirely (do not output it at all) if ANY of these apply:
  • The question text is only a diagram/image with no readable Gujarati/English text
  • ALL 4 options are diagrams/images (chemical structures, graphs, unlabelled figures) with no readable text
  • It is a matching/matrix question (two columns to match)
  • It is a fill-in-table question
  • It has fewer than 4 options visible
  NOTE: If the question TEXT references a figure ("આકૃતિ જુઓ") but options have readable text → INCLUDE it.

━━━ OPTION RULES ━━━
- Never leave an option blank.
- Chemical structure image → condensed formula: CH₃OH, C₂H₅OH, CH₂=CH₂, C₆H₅OH, C₆H₅NH₂
- Graph or fully unreadable image option → SKIP the whole question.

━━━ ANS RULES ━━━
- ANS must be exactly 1, 2, 3, or 4.
- If answer is marked/circled in image → use that (convert A→1 etc.).
- If not marked → use your subject knowledge.

━━━ FORMATTING ━━━
- Keep Gujarati text exactly as written. Do not translate.
- No markdown (**, *, #, _). No PA codes. No headings. No separator lines.
- Nothing outside Q blocks.
- If page has zero valid MCQs → output exactly: NO_QUESTIONS`;
}

const DIAGRAM_TOKENS = new Set(["[structure]", "[diagram]", "[image]", "[figure]", "[graph]", ""]);

function isDiagramOption(text: string): boolean {
  return DIAGRAM_TOKENS.has(text.toLowerCase().trim());
}

const LETTER_TO_NUM: Record<string, string> = { A: "1", B: "2", C: "3", D: "4" };

function normaliseBlock(b: string): string {
  let out = b
    .replace(/^\(A\)/gm, "(1)")
    .replace(/^\(B\)/gm, "(2)")
    .replace(/^\(C\)/gm, "(3)")
    .replace(/^\(D\)/gm, "(4)");
  out = out.replace(/^(ANS:\s*)([ABCD])$/m, (_, prefix, letter) => prefix + LETTER_TO_NUM[letter]);
  return out;
}

function cleanOutput(raw: string): { cleaned: string; count: number } {
  const lines = raw
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      if (!t) return true;
      if (/^PA\d+\b/.test(t)) return false;
      if (/^#{1,6}\s/.test(t)) return false;
      if (/^[─═\-=*]{4,}$/.test(t)) return false;
      if (/^©/.test(t)) return false;
      if (/^\*\*.*\*\*$/.test(t)) return false;
      return true;
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  const blocks = lines.split(/(?=^Q\d+\.)/m);
  const validBlocks: string[] = [];

  for (const block of blocks) {
    let b = block.trim();
    if (!b) continue;
    if (!/^Q\d+\./.test(b)) continue;

    b = normaliseBlock(b);

    const qMatch = b.match(/^Q\d+\.\s*([\s\S]*?)(?=^\s*\([1-4]\)|\s*ANS:)/m);
    const qText = qMatch?.[1]?.trim() ?? b.split("\n")[0].replace(/^Q\d+\.\s*/, "").trim();

    const opts = [1, 2, 3, 4].map(
      (n) => b.match(new RegExp(`^\\s*\\(${n}\\)\\s*(.+)`, "m"))?.[1]?.trim() ?? ""
    );

    const ansLine = b.match(/^ANS:\s*(.*)$/m)?.[1]?.trim() ?? "";

    if (!qText || isDiagramOption(qText)) continue;
    const filledOpts = opts.filter((o) => o !== "");
    if (filledOpts.length < 4) continue;
    if (opts.every((o) => isDiagramOption(o))) continue;
    if (!/^[1-4]$/.test(ansLine)) continue;

    validBlocks.push(b);
  }

  const cleaned = validBlocks.join("\n\n").trim();
  return { cleaned, count: validBlocks.length };
}

export async function extractTextFromBase64Image(
  base64Image: string,
  startQNum: number = 1,
  mimeType: string = "image/png"
): Promise<{ text: string; questionsFound: number }> {
  const body = {
    model: VISION_MODEL,
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
    logger.error({ status: res.status, body: errText }, "Bynara API error");
    throw new APIError(`Bynara API error: ${res.status} — ${errText}`, res.status);
  }

  const data = (await res.json()) as {
    choices: Array<{ message: { content: string } }>;
  };

  const raw = data.choices[0]?.message?.content?.trim() ?? "";

  if (raw === "NO_QUESTIONS" || raw.includes("NO_QUESTIONS")) {
    return { text: "", questionsFound: 0 };
  }

  const { cleaned, count } = cleanOutput(raw);
  logger.info({ questionsFound: count, startQNum }, "Page extracted");
  return { text: cleaned, questionsFound: count };
}