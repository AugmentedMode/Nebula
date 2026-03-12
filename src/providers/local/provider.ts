import {
  CHECKPOINT_ACK,
  type AgentEvent,
  type Attachment,
  type ModelInfo,
  type ModelProvider,
  type ReasoningEffort,
  type Session,
  type SessionConfig,
  type ToolDefinition,
} from "../types.js";
import { SessionStore } from "../../store/session-store.js";

const DEFAULT_BASE_URL = defaultBaseUrl();
const DEFAULT_MODEL = "local-model";

type ChatRole = "system" | "user" | "assistant" | "tool";

interface ChatMessage {
  role: ChatRole;
  content: string;
  tool_call_id?: string;
  name?: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: {
      name: string;
      arguments: string;
    };
  }>;
}

interface LocalProviderOptions {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  sessionStore?: SessionStore;
}

export class LocalOpenAIProvider implements ModelProvider {
  readonly name = "local" as const;
  readonly displayName = "Local";
  currentModel: string;
  reasoningEffort: ReasoningEffort = "medium";

  private baseUrl: string;
  private apiKey?: string;
  private sessionStore: SessionStore;
  private conversationHistory = new Map<string, ChatMessage[]>();
  private systemPrompts = new Map<string, string>();
  private abortController: AbortController | null = null;

  constructor(options: LocalProviderOptions = {}) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL);
    this.apiKey = options.apiKey;
    this.currentModel = options.model ?? DEFAULT_MODEL;
    this.sessionStore = options.sessionStore ?? new SessionStore();
  }

  configure(options: { baseUrl?: string; apiKey?: string; model?: string }): void {
    if (options.baseUrl) this.baseUrl = normalizeBaseUrl(options.baseUrl);
    if (options.apiKey !== undefined) this.apiKey = options.apiKey || undefined;
    if (options.model) this.currentModel = options.model;
  }

  get config(): { baseUrl: string; apiKey?: string; model: string } {
    return {
      baseUrl: this.baseUrl,
      apiKey: this.apiKey,
      model: this.currentModel,
    };
  }

  async isAuthenticated(): Promise<boolean> {
    try {
      await this.healthcheck();
      return true;
    } catch {
      return false;
    }
  }

  async authenticate(): Promise<void> {
    await this.healthcheck();
  }

  async createSession(config: SessionConfig): Promise<Session> {
    const session = this.sessionStore.createSession(
      "local",
      config.model ?? this.currentModel,
    );
    this.conversationHistory.set(session.id, []);
    if (config.systemPrompt) {
      this.systemPrompts.set(session.id, config.systemPrompt);
    }
    return session;
  }

  async resumeSession(id: string): Promise<Session> {
    const session = this.sessionStore.getSession(id);
    if (!session) throw new Error(`Session ${id} not found`);
    if (!this.conversationHistory.has(id)) {
      this.conversationHistory.set(id, []);
    }
    return session;
  }

  async *send(
    session: Session,
    message: string,
    tools: ToolDefinition[],
    _attachments?: Attachment[],
  ): AsyncGenerator<AgentEvent> {
    const history = this.conversationHistory.get(session.id) ?? [];
    history.push({ role: "user", content: message });

    while (true) {
      const response = await this.createChatCompletion(session, history, tools);
      const choice = response.choices?.[0];
      const msg = choice?.message;
      if (!msg) {
        throw new Error("Local provider returned no message");
      }

      const assistantText = typeof msg.content === "string" ? msg.content : "";
      if (assistantText) {
        yield { type: "text", text: assistantText, delta: assistantText };
      }

      history.push({
        role: "assistant",
        content: assistantText,
        tool_calls: msg.tool_calls,
      });

      const toolCalls = msg.tool_calls ?? [];
      if (toolCalls.length === 0) {
        yield {
          type: "done",
          usage: {
            inputTokens: response.usage?.prompt_tokens ?? 0,
            outputTokens: response.usage?.completion_tokens ?? 0,
            costUsd: 0,
          },
        };
        return;
      }

      for (const tc of toolCalls) {
        let args: Record<string, unknown> = {};
        try {
          args = tc.function.arguments
            ? JSON.parse(tc.function.arguments)
            : {};
        } catch {
          args = {};
        }

        yield { type: "tool_call", id: tc.id, name: tc.function.name, args };

        const tool = tools.find((t) => t.name === tc.function.name);
        let result: string;
        let isError = false;
        if (!tool) {
          result = `Unknown tool: ${tc.function.name}`;
          isError = true;
        } else {
          try {
            result = await tool.execute(args);
          } catch (err) {
            result = err instanceof Error ? err.message : String(err);
            isError = true;
          }
        }

        yield { type: "tool_result", callId: tc.id, result, isError };
        history.push({
          role: "tool",
          content: result,
          tool_call_id: tc.id,
          name: tc.function.name,
        });
      }
    }
  }

  interrupt(_session: Session): void {
    this.abortController?.abort();
    this.abortController = null;
  }

  resetHistory(session: Session, briefingMessage: string): void {
    this.conversationHistory.set(session.id, [
      { role: "user", content: briefingMessage },
      { role: "assistant", content: CHECKPOINT_ACK },
    ]);
  }

  async closeSession(session: Session): Promise<void> {
    this.conversationHistory.delete(session.id);
    this.systemPrompts.delete(session.id);
  }

  async fetchModels(): Promise<ModelInfo[]> {
    try {
      const models = await this.fetchModelsCompat();
      if (models.length > 0) {
        return models.map((model: any) => ({
          id: model.id,
          name: model.id,
        }));
      }
    } catch {
      // Fall through to current model.
    }
    return [{ id: this.currentModel, name: this.currentModel, description: `OpenAI-compatible local model @ ${this.baseUrl}` }];
  }

  private async healthcheck(): Promise<void> {
    const models = await this.fetchModelsCompat();
    if (
      models.length > 0 &&
      (!this.currentModel || this.currentModel === DEFAULT_MODEL)
    ) {
      this.currentModel = models[0].id;
    }
  }

  private async createChatCompletion(
    session: Session,
    history: ChatMessage[],
    tools: ToolDefinition[],
  ): Promise<any> {
    this.abortController = new AbortController();
    const systemPrompt = this.systemPrompts.get(session.id);
    const messages: ChatMessage[] = [];
    if (systemPrompt) {
      messages.push({ role: "system", content: systemPrompt });
    }
    messages.push(...history);

    const payload = {
      model: this.currentModel,
      stream: false,
      temperature: 0,
      messages,
      tools: tools.map((tool) => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        },
      })),
      tool_choice: tools.length > 0 ? "auto" : undefined,
    };

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(payload),
      signal: this.abortController.signal,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Local provider error (${response.status}): ${text || response.statusText}`);
    }
    return response.json();
  }

  private async fetchJson(path: string): Promise<any> {
    return this.fetchJsonFromBase(this.baseUrl, path);
  }

  private async fetchJsonFromBase(baseUrl: string, path: string): Promise<any> {
    const response = await fetch(`${baseUrl}${path}`, {
      headers: this.headers(),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Local provider error (${response.status}): ${text || response.statusText}`);
    }
    return response.json();
  }

  private async fetchModelsCompat(): Promise<Array<{ id: string }>> {
    try {
      const resp = await this.fetchJson("/models");
      return Array.isArray(resp.data) ? resp.data : [];
    } catch (err) {
      if (!looksLikeNotFound(err)) throw err;
    }

    const tags = await this.fetchJsonFromBase(this.rootBaseUrl(), "/api/tags");
    const models = Array.isArray(tags.models) ? tags.models : [];
    return models
      .map((model: any) => ({
        id: model.model ?? model.name,
      }))
      .filter((model: { id?: string }) => Boolean(model.id)) as Array<{ id: string }>;
  }

  private rootBaseUrl(): string {
    return this.baseUrl.endsWith("/v1")
      ? this.baseUrl.slice(0, -3)
      : this.baseUrl;
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.apiKey) {
      headers.Authorization = `Bearer ${this.apiKey}`;
    }
    return headers;
  }
}

function normalizeBaseUrl(url: string): string {
  const trimmed = url.replace(/\/+$/, "");
  try {
    const parsed = new URL(trimmed);
    if (parsed.pathname === "" || parsed.pathname === "/") {
      parsed.pathname = "/v1";
      return parsed.toString().replace(/\/+$/, "");
    }
  } catch {
    // Fall through to raw string handling.
  }
  return trimmed;
}

function defaultBaseUrl(): string {
  const ollamaHost = process.env.OLLAMA_HOST?.trim();
  if (ollamaHost) {
    const base = ollamaHost.startsWith("http://") || ollamaHost.startsWith("https://")
      ? ollamaHost
      : `http://${ollamaHost}`;
    return normalizeBaseUrl(base);
  }
  return "http://127.0.0.1:11434/v1";
}

function looksLikeNotFound(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes("(404)") || message.includes("Not Found");
}
