import axios, { AxiosInstance } from "axios";
import FormData from "form-data";
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

    const { key, id } = response.data;
    if (!key || !id) {
      throw new Error(`Invalid Jira response: missing key or id`);
    }

    return {
      key,
      id,
      url: `${config.jira.baseUrl}/browse/${key}`,
    };
  }

  async addAttachment(issueKey: string, fileBuffer: Buffer, filename: string): Promise<void> {
    const form = new FormData();
    form.append("file", fileBuffer, { filename });

    await this.client.post(`/issue/${issueKey}/attachments`, form, {
      headers: {
        ...form.getHeaders(),
        "X-Atlassian-Token": "no-check",
      },
      maxContentLength: 20 * 1024 * 1024, // 20MB
    });
  }
}

export const jiraService = new JiraService();
