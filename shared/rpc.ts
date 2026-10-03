import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

// Names must match /^[a-z][a-z0-9._-]*$/ — defineRpc rejects uppercase.
export const testProviderRpc = defineRpc({
  name: "autumn-studio.test-provider",
  input: z.object({
    type: z.string(),
    apiKey: z.string(),
    baseUrl: z.string().optional(),
  }),
  output: z.object({
    success: z.boolean(),
    message: z.string(),
    modelsCount: z.number().optional(),
  }),
});

export const externalModelSchema = z.object({
  id: z.string(),
  name: z.string(),
  reasoning: z.boolean().optional(),
  contextWindow: z.number().optional(),
});

export const externalProviderSchema = z.object({
  id: z.string(),
  /** Which agent source this was detected from ("external-pi" today; more later). */
  source: z.string(),
  name: z.string(),
  /** Where the credential comes from: auth.json key/oauth, models.json key, or environment. */
  authSource: z.string(),
  baseUrl: z.string().optional(),
  models: z.array(externalModelSchema),
});

export const externalProvidersRpc = defineRpc({
  name: "autumn-studio.external-providers",
  input: z.object({}),
  output: z.object({
    /** External pi agent dir that was inspected. */
    agentDir: z.string(),
    /** Empty when reuse is disabled or no usable external providers were found. */
    providers: z.array(externalProviderSchema),
  }),
});

export type ExternalModelInfo = z.infer<typeof externalModelSchema>;
export type ExternalProviderInfo = z.infer<typeof externalProviderSchema>;
