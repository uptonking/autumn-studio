import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import type {
  ProviderConfigChanges,
  ProviderConfigState,
  ProviderEvent,
  ProviderPersistence,
  ProviderSessionConfig,
} from "@getpaseo/plugin/server/provider";
import type { PluginSettings } from "@getpaseo/plugin/server";
import type { settings, ProviderEntry } from "../shared/settings.js";
import { mapPiEvents } from "./event-mapper.js";

type SettingsHandle = PluginSettings<typeof settings.schema>;

const KNOWN_TYPES = new Set([
  "amazon-bedrock",
  "anthropic",
  "azure-openai-responses",
  "cerebras",
  "cloudflare-ai-gateway",
  "deepseek",
  "fireworks",
  "google",
  "groq",
  "mistral",
  "moonshotai",
  "openai",
  "openrouter",
  "together",
  "xai",
  "zai",
]);

export class EmbeddedSession {
  private sessionId: string;
  private piSession: AgentSession;
  private unsubscribe: () => void;
  private modelRuntime: ModelRuntime;
  private currentModel: string | undefined;
  private currentThinking: string;
  private activeTurnId: string | null = null;
  private env: Record<string, string>;
  private turns = 0;

  private constructor(
    sessionId: string,
    piSession: AgentSession,
    unsubscribe: () => void,
    modelRuntime: ModelRuntime,
    currentModel: string | undefined,
    currentThinking: string,
    env: Record<string, string>,
    initialTurns: number = 0,
  ) {
    this.sessionId = sessionId;
    this.piSession = piSession;
    this.unsubscribe = unsubscribe;
    this.modelRuntime = modelRuntime;
    this.currentModel = currentModel;
    this.currentThinking = currentThinking;
    this.env = env;
    this.turns = initialTurns;
  }

  static async create(
    sessionId: string,
    config: ProviderSessionConfig,
    settingsHandle: SettingsHandle,
    emit: (event: ProviderEvent) => void,
    persistence?: ProviderPersistence,
  ): Promise<EmbeddedSession> {
    const state = await settingsHandle.read();
    const providers =
      state.status === "ready"
        ? state.values.providers.filter(
            (p: ProviderEntry) => p.enabled && p.apiKey.trim().length > 0,
          )
        : [];

    const modelRuntime = await ModelRuntime.create({
      modelsPath: null,
      allowModelNetwork: false,
      refreshOnCreate: false,
    });

    for (const entry of providers) {
      const isCustom = entry.type === "custom" || !KNOWN_TYPES.has(entry.type);

      if (isCustom && entry.baseUrl) {
        const [targetProvider, targetModelId] = config.model ? config.model.split("/", 2) : [];
        const modelDefinitions =
          targetProvider === entry.id && targetModelId
            ? [
                {
                  id: targetModelId,
                  name: targetModelId,
                  contextWindow: 65536,
                  maxTokens: 8192,
                  reasoning: false,
                  input: ["text" as const],
                },
              ]
            : [
                {
                  id: "default",
                  name: `${entry.name || "Custom"} Default Model`,
                  contextWindow: 65536,
                  maxTokens: 8192,
                  reasoning: false,
                  input: ["text" as const],
                },
              ];

        modelRuntime.registerProvider(entry.id, {
          name: entry.name || entry.id,
          baseUrl: entry.baseUrl,
          api: "openai-completions",
          models: modelDefinitions,
        });
        await modelRuntime.setRuntimeApiKey(entry.id, entry.apiKey || "dummy-key");
      } else if (KNOWN_TYPES.has(entry.type)) {
        if (entry.baseUrl) {
          modelRuntime.registerProvider(entry.type, {
            baseUrl: entry.baseUrl,
          });
        }
        await modelRuntime.setRuntimeApiKey(entry.type, entry.apiKey);
      }
    }

    // Resolve requested model
    let model = undefined;
    if (config.model) {
      const [provider, modelId] = config.model.split("/", 2);
      if (provider && modelId) {
        model = modelRuntime.getModel(provider as any, modelId);
      }
    }

    const thinkingLevel =
      (config.thinkingOption as any) ||
      (state.status === "ready" ? state.values.defaultThinkingLevel : "medium");

    // Set up resource loader to inject Paseo system prompt and custom instructions
    const systemPrompts: string[] = [];
    if (config.systemPrompt) systemPrompts.push(config.systemPrompt);
    if (state.status === "ready" && state.values.customInstructions?.trim()) {
      systemPrompts.push(state.values.customInstructions.trim());
    }

    let resourceLoader: DefaultResourceLoader | undefined = undefined;
    if (systemPrompts.length > 0) {
      resourceLoader = new DefaultResourceLoader({
        cwd: config.cwd,
        appendSystemPromptOverride: systemPrompts,
      });
      await resourceLoader.reload();
    }

    const { session: piSession } = await createAgentSession({
      cwd: config.cwd,
      model,
      thinkingLevel,
      modelRuntime,
      resourceLoader,
      sessionManager: SessionManager.inMemory(config.cwd),
    });

    let activeTurnIdRef: { current: string | null } = { current: null };

    const unsubscribe = mapPiEvents(
      sessionId,
      piSession,
      emit,
      () => activeTurnIdRef.current,
    );

    const initialTurns =
      typeof (persistence?.data as any)?.turns === "number"
        ? (persistence?.data as any).turns
        : 0;

    const sessionInstance = new EmbeddedSession(
      sessionId,
      piSession,
      unsubscribe,
      modelRuntime,
      config.model,
      thinkingLevel,
      { ...config.env },
      initialTurns,
    );

    Object.defineProperty(activeTurnIdRef, "current", {
      get: () => sessionInstance.activeTurnId,
      set: (val) => {
        sessionInstance.activeTurnId = val;
      },
    });

    return sessionInstance;
  }

  getPersistence(): ProviderPersistence {
    return {
      version: 1,
      data: {
        nativeSessionId: this.sessionId,
        turns: this.turns,
      },
    };
  }

  async prompt(
    sessionId: string,
    text: string,
    clientMessageId: string,
    delivery: "auto" | "steer",
    emit: (event: ProviderEvent) => void,
  ): Promise<void> {
    this.turns++;
    const turnId = `turn-${Date.now()}`;
    this.activeTurnId = turnId;

    emit({
      type: "session.prompt_result",
      sessionId,
      clientMessageId,
      result: { type: "turn", turnId },
    });
    emit({ type: "session.turn", sessionId, turnId, state: "started" });

    // Overlay session env vars during turn execution
    const prevEnv: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(this.env)) {
      prevEnv[key] = process.env[key];
      process.env[key] = value;
    }

    try {
      if (delivery === "steer") {
        await this.piSession.steer(text);
      } else {
        await this.piSession.prompt(text);
      }
      emit({ type: "session.turn", sessionId, turnId, state: "completed" });
    } catch (error: any) {
      emit({
        type: "session.turn",
        sessionId,
        turnId,
        state: "failed",
        error: { message: error?.message || String(error) },
      });
    } finally {
      this.activeTurnId = null;
      for (const [key, val] of Object.entries(prevEnv)) {
        if (val === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = val;
        }
      }
    }
  }

  async configure(changes: ProviderConfigChanges): Promise<void> {
    if (changes.model !== undefined && changes.model !== null) {
      const [provider, modelId] = changes.model.split("/", 2);
      if (provider && modelId) {
        const newModel = this.modelRuntime.getModel(provider as any, modelId);
        if (newModel) {
          await this.piSession.setModel(newModel);
          this.currentModel = changes.model;
        }
      }
    }
    if (changes.thinkingOption !== undefined && changes.thinkingOption !== null) {
      this.piSession.setThinkingLevel(changes.thinkingOption as any);
      this.currentThinking = changes.thinkingOption;
    }
  }

  getConfigState(): ProviderConfigState {
    return {
      model: this.currentModel,
      mode: "default",
      thinkingOption: this.currentThinking,
      models: [],
      modes: [{ id: "default", label: "Default" }],
      thinkingOptions: [],
      settings: [],
    };
  }

  async abort(): Promise<void> {
    await this.piSession.abort();
  }

  dispose(): void {
    this.unsubscribe();
    this.piSession.dispose();
  }
}
