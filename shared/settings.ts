import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

/** Schema for a configured LLM provider entry. */
const providerEntrySchema = z.object({
  /** Unique ID for this entry. */
  id: z.string(),
  /** Display name (e.g. "My Anthropic", "Company LLM Proxy"). */
  name: z.string().default(""),
  /**
   * Provider type — maps to Pi's provider IDs.
   *
   * Use a well-known ID ("anthropic", "openai", "google", "deepseek",
   * "openrouter", "groq", "mistral", "xai", "together", "fireworks")
   * or "custom" for generic OpenAI-compatible endpoints.
   */
  type: z.string().default("anthropic"),
  /** API key or token. */
  apiKey: z.string().default(""),
  /** Custom base URL (required for "custom" type, optional override for others). */
  baseUrl: z.string().default(""),
  /**
   * Manually listed model ids for custom endpoints, comma-separated in the UI.
   * Registered in addition to whatever /v1/models discovery returns — so the
   * picker still works when an endpoint's discovery is broken or slow.
   */
  models: z.array(z.string()).default([]),
  /**
   * Whether this endpoint's models support reasoning. Custom OpenAI-compatible
   * endpoints only — known providers get reasoning from pi's built-in catalogs.
   * When on, models expose reasoning-effort options in the chatbox and pi sends
   * OpenAI-style reasoning_effort.
   */
  reasoning: z.boolean().default(false),
  /** Whether this provider entry is enabled. */
  enabled: z.boolean().default(true),
});

export type ProviderEntry = z.infer<typeof providerEntrySchema>;

export const settings = defineSettings({
  id: "config",
  scope: "host",
  version: 1,
  schema: z.object({
    /** Master toggle — when off, provider reports unavailable. */
    enabled: z.boolean().default(true),
    /** Default reasoning/thinking level for supported models. */
    defaultThinkingLevel: z.enum(["off", "low", "medium", "high"]).default("medium"),
    /** Global custom instructions appended to Pi's system prompt in all conversations. */
    customInstructions: z.string().default(""),
    /** Configured LLM provider entries. */
    providers: z.array(providerEntrySchema).default([]),
  }),
});

export type AutumnSettings = z.infer<typeof settings.schema>;
