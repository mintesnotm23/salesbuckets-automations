import OpenAI from "openai";
import { config } from "../config";

const openai = new OpenAI({ apiKey: config.openai.apiKey });

export interface StructuredIssue {
  title: string;
  description: string;
  acceptanceCriteria: string[];
  priority: "Highest" | "High" | "Medium" | "Low" | "Lowest";
  labels: string[];
}

export interface ExtractedIssue {
  title: string;
  description: string;
  priority: string;
}

export async function structureIssue(rawText: string): Promise<StructuredIssue> {
  const response = await openai.chat.completions.create({
    model: config.openai.model,
    messages: [
      {
        role: "system",
        content: `You are a project manager assistant. Given a rough issue description from a developer, structure it into a well-formatted Jira ticket.

Return a JSON object with:
- title: concise issue title (imperative form, e.g. "Add pagination to user list")
- description: detailed description in markdown format
- acceptanceCriteria: array of acceptance criteria strings
- priority: one of "Highest", "High", "Medium", "Low", "Lowest"
- labels: array of relevant labels (e.g. "bug", "feature", "enhancement", "refactor", "documentation")

Return ONLY valid JSON, no markdown fences.`,
      },
      { role: "user", content: rawText },
    ],
    temperature: 0.3,
  });

  const content = response.choices[0].message.content;
  if (!content) throw new Error("Empty response from OpenAI");

  try {
    return JSON.parse(content) as StructuredIssue;
  } catch {
    throw new Error(`Failed to parse AI response as JSON: ${content.slice(0, 200)}`);
  }
}

export async function answerCodebaseQuestion(
  question: string,
  context: string
): Promise<string> {
  const response = await openai.chat.completions.create({
    model: config.openai.model,
    messages: [
      {
        role: "system",
        content: `You are a helpful assistant that answers questions about a codebase. You are given relevant code context and a question. Answer concisely and accurately. If you're not sure, say so. Format your answer for Slack (use *bold*, \`code\`, and bullet points).`,
      },
      {
        role: "user",
        content: `Context:\n${context}\n\nQuestion: ${question}`,
      },
    ],
    temperature: 0.2,
    max_tokens: 1000,
  });

  return response.choices[0].message.content || "Sorry, I couldn't generate an answer.";
}

export async function extractIssuesFromMeetingNotes(notes: string): Promise<ExtractedIssue[]> {
  const response = await openai.chat.completions.create({
    model: config.openai.model,
    messages: [
      {
        role: "system",
        content: `You extract actionable issues (bugs, tasks, feature requests) from meeting notes. Return a JSON array of objects with: title, description, priority ("High", "Medium", "Low"). Only include items that are clearly actionable. Return ONLY valid JSON, no markdown fences. If no issues found, return an empty array.`,
      },
      { role: "user", content: notes },
    ],
    temperature: 0.2,
  });

  const content = response.choices[0].message.content;
  if (!content) return [];

  try {
    return JSON.parse(content) as ExtractedIssue[];
  } catch {
    console.error("Failed to parse extracted issues:", content.slice(0, 200));
    return [];
  }
}

export async function summarizeMeetingNotes(notes: string): Promise<string> {
  const response = await openai.chat.completions.create({
    model: config.openai.model,
    messages: [
      {
        role: "system",
        content: `Summarize these meeting notes concisely for a Slack post. Include:
- Key decisions made
- Action items (with owners if mentioned)
- Important discussion points

Format for Slack (use *bold*, bullet points). Keep it under 500 words.`,
      },
      { role: "user", content: notes },
    ],
    temperature: 0.3,
    max_tokens: 800,
  });

  return response.choices[0].message.content || "Could not summarize meeting notes.";
}
