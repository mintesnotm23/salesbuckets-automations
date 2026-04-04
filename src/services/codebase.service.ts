import { exec } from "child_process";
import { promisify } from "util";
import path from "path";
import fs from "fs/promises";
import { escapeShellArg } from "../utils/helpers";

const execAsync = promisify(exec);

// Path to the SalesBuckets backend repo — adjust if deployed elsewhere
const REPO_PATH = path.resolve(__dirname, "../../../salesbuckets_backend");

/**
 * Searches the codebase for relevant files/content based on a question.
 * Uses grep-based search with proper input sanitization.
 */
export async function searchCodebase(question: string): Promise<string> {
  const keywords = extractKeywords(question);
  const results: string[] = [];

  for (const keyword of keywords.slice(0, 5)) {
    const sanitized = escapeShellArg(keyword);
    if (!sanitized) continue;

    try {
      const { stdout } = await execAsync(
        `grep -rn --include='*.ts' -l '${sanitized}' '${REPO_PATH}/src' 2>/dev/null | head -5`,
        { timeout: 5000 }
      );

      const grepResult = stdout.trim();
      if (!grepResult) continue;

      const files = grepResult.split("\n");
      for (const file of files.slice(0, 3)) {
        try {
          const content = await fs.readFile(file, "utf-8");
          const lines = content.split("\n");
          const matchingLines: string[] = [];

          lines.forEach((line, idx) => {
            if (line.toLowerCase().includes(keyword.toLowerCase())) {
              const start = Math.max(0, idx - 3);
              const end = Math.min(lines.length, idx + 4);
              const snippet = lines.slice(start, end).join("\n");
              matchingLines.push(`// ${path.relative(REPO_PATH, file)}:${idx + 1}\n${snippet}`);
            }
          });

          if (matchingLines.length > 0) {
            results.push(matchingLines.slice(0, 2).join("\n\n"));
          }
        } catch {
          // skip unreadable files
        }
      }
    } catch {
      // grep found nothing or timed out
    }
  }

  if (results.length === 0) {
    return "No relevant code found for this question.";
  }

  return results.slice(0, 5).join("\n\n---\n\n");
}

function extractKeywords(question: string): string[] {
  const stopWords = new Set([
    "what", "where", "how", "why", "when", "does", "is", "the", "a", "an",
    "in", "on", "at", "to", "for", "of", "with", "and", "or", "but", "not",
    "this", "that", "it", "do", "can", "we", "our", "are", "from", "about",
  ]);

  return question
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .split(/\s+/)
    .filter((word) => word.length > 2 && !stopWords.has(word));
}
