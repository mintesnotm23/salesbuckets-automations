import type { StructuredIssue } from "../services/openai.service";

/**
 * Escape special characters for Slack mrkdwn format.
 */
export function escapeSlackMarkdown(text: string): string {
  return text.replace(/[&<>]/g, (ch) => {
    switch (ch) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      default: return ch;
    }
  });
}

/**
 * Escape shell special characters to prevent command injection.
 */
export function escapeShellArg(arg: string): string {
  return arg.replace(/[^a-zA-Z0-9_\-./]/g, "");
}

/**
 * Safely parse JSON with a fallback.
 */
export function safeJsonParse<T>(json: string, fallback: T): T {
  try {
    return JSON.parse(json);
  } catch {
    return fallback;
  }
}

/**
 * Race a promise against a timeout.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, message = "Operation timed out"): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(message)), ms)),
  ]);
}

const MAX_COMMAND_INPUT_LENGTH = 2000;

/**
 * Validate slash command input. Returns error message or null if valid.
 */
export function validateCommandInput(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return "Please provide a description.";
  if (trimmed.length > MAX_COMMAND_INPUT_LENGTH) return `Input too long (max ${MAX_COMMAND_INPUT_LENGTH} chars).`;
  return null;
}

const VALID_PRIORITIES = ["Highest", "High", "Medium", "Low", "Lowest"] as const;

/**
 * Validate and sanitize the AI-generated structured issue.
 */
export function validateStructuredIssue(data: unknown): StructuredIssue {
  if (typeof data !== "object" || !data) {
    throw new Error("AI response is not a valid object");
  }

  const obj = data as Record<string, unknown>;

  if (typeof obj.title !== "string" || !obj.title.trim()) {
    throw new Error("Missing or empty title in AI response");
  }
  if (typeof obj.description !== "string" || !obj.description.trim()) {
    throw new Error("Missing or empty description in AI response");
  }

  const priority = typeof obj.priority === "string" && VALID_PRIORITIES.includes(obj.priority as any)
    ? (obj.priority as StructuredIssue["priority"])
    : "Medium";

  const labels = Array.isArray(obj.labels)
    ? obj.labels.filter((l): l is string => typeof l === "string").map((l) => l.slice(0, 50))
    : [];

  const acceptanceCriteria = Array.isArray(obj.acceptanceCriteria)
    ? obj.acceptanceCriteria.filter((ac): ac is string => typeof ac === "string").map((ac) => ac.slice(0, 500))
    : [];

  return {
    title: obj.title.trim().slice(0, 500),
    description: (obj.description as string).trim().slice(0, 5000),
    priority,
    labels,
    acceptanceCriteria,
  };
}

/**
 * Truncate text to fit Slack's block text limits.
 */
export function truncateForSlack(text: string, max = 2900): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + "\n\n_(truncated)_";
}
