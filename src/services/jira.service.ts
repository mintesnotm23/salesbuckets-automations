import axios, { AxiosInstance } from "axios";
import { config } from "../config";

export interface JiraIssueResult {
  key: string;
  id: string;
  url: string;
}

export interface CreateIssueParams {
  title: string;
  description: string;
  priority: string;
  labels: string[];
  issueType?: string;
}

class JiraService {
  private client: AxiosInstance;

  constructor() {
    this.client = axios.create({
      baseURL: `${config.jira.baseUrl}/rest/api/3`,
      auth: {
        username: config.jira.email,
        password: config.jira.apiToken,
      },
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      timeout: 10000,
    });
  }

  async validateConnection(): Promise<void> {
    try {
      await this.client.get("/myself");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Jira authentication failed: ${message}`);
    }
  }

  async createIssue(params: CreateIssueParams): Promise<JiraIssueResult> {
    const { title, description, priority, labels, issueType = "Task" } = params;

    if (!title.trim()) throw new Error("Issue title cannot be empty");

    const response = await this.client.post("/issue", {
      fields: {
        project: { key: config.jira.projectKey },
        summary: title,
        description: {
          type: "doc",
          version: 1,
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: description }],
            },
          ],
        },
        issuetype: { name: issueType },
        priority: { name: priority },
        labels,
      },
    });

    return {
      key: response.data.key,
      id: response.data.id,
      url: `${config.jira.baseUrl}/browse/${response.data.key}`,
    };
  }
}

export const jiraService = new JiraService();
