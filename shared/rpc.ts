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
