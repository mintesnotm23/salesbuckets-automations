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
  if (!text.trim()) return "Please provide a description.";
  if (text.length > MAX_COMMAND_INPUT_LENGTH) return `Input too long (max ${MAX_COMMAND_INPUT_LENGTH} chars).`;
  return null;
}
