import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { logger } from "./logger.js";

const execFileAsync = promisify(execFile);

/**
 * Convert a PDF buffer to an array of base64-encoded PNG images (one per page).
 * Uses pdftoppm from poppler-utils — no native Node canvas required.
 */
export async function pdfBufferToBase64Images(pdfBuffer: Buffer): Promise<string[]> {
  // Create a temp directory for this job
  const dir = await mkdtemp(join(tmpdir(), "pdf-ocr-"));

  try {
    const pdfPath = join(dir, "input.pdf");
    const outputPrefix = join(dir, "page");

    // Write PDF to temp file
    await writeFile(pdfPath, pdfBuffer);

    // Convert all pages to PNG using pdftoppm
    // -r 150: 150 DPI — ~40% fewer tokens than 200 DPI, still good OCR quality
    // -png: output format
    await execFileAsync("pdftoppm", ["-r", "150", "-png", pdfPath, outputPrefix]);

    // Read all generated PNG files sorted by name
    const allFiles = await readdir(dir);
    const pngFiles = allFiles
      .filter((f) => f.startsWith("page") && f.endsWith(".png"))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

    if (pngFiles.length === 0) {
      throw new Error("pdftoppm produced no output images");
    }

    logger.info({ numPages: pngFiles.length }, "PDF converted to images");

    // Read each PNG and encode as base64
    const images: string[] = [];
    for (const file of pngFiles) {
      const buf = await readFile(join(dir, file));
      images.push(buf.toString("base64"));
    }

    return images;
  } finally {
    // Clean up temp directory
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
