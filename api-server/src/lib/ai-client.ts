import { logger } from "./logger.js";

const AI_BASE_URL = "https://router.bynara.id/v1";

// ⚠️ Confirm this is a valid free model on your router — I picked a common
// free vision-capable model as a placeholder. Tell me the exact name if different.
const VISION_MODEL = "agnes-2.5-flash";

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
  return `You are a careful OCR and MCQ extraction assistant for Gujarati-medium science exam papers (Physics, Chemistry, Botany, and Zoology).

TASK
Read the supplied PDF page image and extract only complete, standard single-correct-answer MCQs. Accuracy is more important than quantity. Never invent text, options, diagrams, or answers.

REQUIRED OUTPUT FORMAT
Use this exact format for every accepted question:
Q${startQNum}. [question text exactly as printed, Gujarati/English]
(1) [option 1]
(2) [option 2]
(3) [option 3]
(4) [option 4]
ANS: [1, 2, 3, or 4]

QUESTION NUMBERING
- Ignore printed question numbers.
- Start at Q${startQNum} and number accepted questions sequentially.
- Do not leave gaps because a question was skipped.

OPTION LABEL CONVERSION
The source paper may label options in any of these accepted ways:
- (1), (2), (3), (4)
- 1), 2), 3), 4)
- 1., 2., 3., 4.
- (A), (B), (C), (D)
- A), B), C), D)
- A., B., C., D.

Always convert them to (1), (2), (3), (4), in the same order.
Convert answer labels A/B/C/D to 1/2/3/4.
The final output must use only numeric option labels and a numeric ANS line.

STRICT SKIP RULES — DO NOT OUTPUT THE QUESTION AT ALL
Skip a question if:
- Its question text is missing, too blurred, or cannot be read reliably.
- The question depends on a diagram, image, graph, chart, photograph, or visual structure to understand or answer it. Do not guess what the visual contains.
- Any one or more of its four options is an image/diagram/graph/chemical structure that cannot be read as ordinary text.
- It is a matching-column, matrix, assertion-reason with non-standard choices, fill-in-table, or multi-select question.
- It does not have exactly four clearly readable options.
- The correct answer cannot be determined confidently from a printed answer mark/key or reliable subject knowledge.

A question may be included when it merely mentions a figure, but the actual question and all four options are fully understandable without seeing that figure. If the figure is necessary to solve it, SKIP it.

NO GUESSING / NO PLACEHOLDERS
- Never write [diagram], [image], [figure], [graph], "not visible", or guessed replacement text as an option.
- Never convert an unreadable visual option into a guessed chemical formula or description.
- Never create missing options or infer text hidden by a diagram.
- If an answer is circled/marked or an answer key is visible, use it. Otherwise solve only when confident; if uncertain, skip the question.
- Never output an answer without its corresponding complete question and four options.

TEXT PRESERVATION
- Preserve Gujarati exactly as printed; do not translate or paraphrase.
- Preserve scientific terms, symbols, units, subscripts, superscripts, and chemical notation as accurately as possible.
- Keep each option on its own line.
- Do not add explanations or solutions.

OUTPUT CLEANLINESS
- No Markdown, headings, page labels, comments, or separator lines.
- Output only consecutive Q blocks in the required format.
- If the page contains no eligible MCQs, output exactly: NO_QUESTIONS`;
}

const DIAGRAM_TOKENS = new Set(["[structure]", "[diagram]", "[image]", "[figure]", "[graph]", ""]);

function isDiagramOption(text: string): boolean {
  const value = text.toLowerCase().trim();
  return (
    DIAGRAM_TOKENS.has(value) ||
    /^\[?(?:diagram|image|figure|graph|structure)(?:\s+(?:not visible|unreadable|omitted|option))?\]?$/i.test(value)
  );
}

const LETTER_TO_NUM: Record<string, string> = { A: "1", B: "2", C: "3", D: "4" };

// FIX: previously used `/^/gm` which matches an empty string at the start of
// EVERY line and prepended "(1)(2)(3)(4)" to each line. Now it correctly
// converts lines starting with (A)/(B)/(C)/(D) into (1)/(2)/(3)/(4).
function normaliseBlock(b: string): string {
  return b
    .split("\n")
    .map((line) => {
      // Accept the same option labels as the reference bot:
      // (1), 1), 1., (A), A), and A.
      const option = line.match(/^\s*(?:\(([A-D1-4])\)|([A-D1-4])[.)])\s*(.*)$/i);
      if (option) {
        const rawLabel = (option[1] ?? option[2]).toUpperCase();
        const number = LETTER_TO_NUM[rawLabel] ?? rawLabel;
        return `(${number}) ${option[3].trim()}`;
      }

      // Accept ANS: 2 / ANS: B / Answer: (C) / Correct Answer: D.
      const answer = line.match(
        /^\s*(?:ANS(?:WER)?|CORRECT\s+ANSWER)\s*[:=\-]\s*\(?([A-D1-4])\)?\s*$/i
      );
      if (answer) {
        const rawLabel = answer[1].toUpperCase();
        return `ANS: ${LETTER_TO_NUM[rawLabel] ?? rawLabel}`;
      }

      return line;
    })
    .join("\n");
}

function cleanOutput(raw: string): { cleaned: string; count: number } {
  const lines = raw
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      if (!t) return true;
      if (/^PA\d+\b/.test(t)) return false;
      if (/^#{1,6}\s/.test(t)) return false;
      if (/^[─═\-=]{4,}$/.test(t)) return false;
      if (/^©/.test(t)) return false;
      // FIX: previous regex `/^**.**$/` is invalid (nothing to repeat before
      // `*`) and throws a SyntaxError at load time. This matches lines that
      // are entirely wrapped in markdown bold, e.g. **like this**.
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

    const qMatch = b.match(/^Q\d+\.\s*([\s\S]*?)(?=^\s*\(?[1-4]\)?|\s*ANS:)/m);
    const qText = qMatch?.[1]?.trim() ?? b.split("\n")[0].replace(/^Q\d+\.\s*/, "").trim();

    const opts = [1, 2, 3, 4].map(
      (n) => b.match(new RegExp(`^\\s*\\(${n}\\)\\s*(.+)`, "m"))?.[1]?.trim() ?? ""
    );

    const ansLine = b.match(/^ANS:\s*(.*)$/m)?.[1]?.trim() ?? "";

    if (!qText || isDiagramOption(qText)) continue;
    const filledOpts = opts.filter((o) => o !== "");
    if (filledOpts.length < 4) continue;
    if (opts.some((o) => isDiagramOption(o))) continue;
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
