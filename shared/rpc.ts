import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const testProviderRpc = defineRpc({
  name: "autumnStudio.testProvider",
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
