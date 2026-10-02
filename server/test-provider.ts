interface TestProviderInput {
  type: string;
  apiKey: string;
  baseUrl?: string;
}

interface TestProviderResult {
  success: boolean;
  message: string;
  modelsCount?: number;
}

export async function testProviderConnection(
  input: TestProviderInput,
): Promise<TestProviderResult> {
  const { type, apiKey, baseUrl } = input;
  const cleanKey = apiKey.trim();
  const cleanUrl = baseUrl?.trim();

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6000);

  try {
    switch (type) {
      case "anthropic": {
        const url = (cleanUrl ? cleanUrl.replace(/\/+$/, "") : "https://api.anthropic.com/v1") + "/models";
        const res = await fetch(url, {
          headers: {
            "x-api-key": cleanKey,
            "anthropic-version": "2023-06-01",
          },
          signal: controller.signal,
        });
        clearTimeout(timeout);
        if (!res.ok) {
          const body = await res.text().catch(() => "");
          return {
            success: false,
            message: `Anthropic API returned ${res.status}: ${res.statusText} ${body ? `(${body.slice(0, 100)})` : ""}`,
          };
        }
        const data = (await res.json()) as any;
        const count = Array.isArray(data?.data) ? data.data.length : undefined;
        return {
          success: true,
          message: `Connected to Anthropic successfully!${count ? ` (${count} models found)` : ""}`,
          modelsCount: count,
        };
      }

      case "google": {
        const base = cleanUrl ? cleanUrl.replace(/\/+$/, "") : "https://generativelanguage.googleapis.com";
        const url = `${base}/v1beta/models?key=${encodeURIComponent(cleanKey)}`;
        const res = await fetch(url, { signal: controller.signal });
        clearTimeout(timeout);
        if (!res.ok) {
          return {
            success: false,
            message: `Google Gemini API returned ${res.status}: ${res.statusText}`,
          };
        }
        const data = (await res.json()) as any;
        const count = Array.isArray(data?.models) ? data.models.length : undefined;
        return {
          success: true,
          message: `Connected to Google Gemini successfully!${count ? ` (${count} models found)` : ""}`,
          modelsCount: count,
        };
      }

      case "openai":
      case "deepseek":
      case "openrouter":
      case "groq":
      case "mistral":
      case "together":
      case "fireworks":
      case "xai":
      default: {
        let defaultBase = "https://api.openai.com/v1";
        if (type === "deepseek") defaultBase = "https://api.deepseek.com/v1";
        else if (type === "openrouter") defaultBase = "https://openrouter.ai/api/v1";
        else if (type === "groq") defaultBase = "https://api.groq.com/openai/v1";
        else if (type === "mistral") defaultBase = "https://api.mistral.ai/v1";
        else if (type === "together") defaultBase = "https://api.together.xyz/v1";
        else if (type === "fireworks") defaultBase = "https://api.fireworks.ai/inference/v1";
        else if (type === "xai") defaultBase = "https://api.x.ai/v1";

        const base = (cleanUrl || defaultBase).replace(/\/+$/, "");
        const url = base.endsWith("/models") ? base : `${base}/models`;
        const headers: Record<string, string> = {};
        if (cleanKey) headers.Authorization = `Bearer ${cleanKey}`;

        const res = await fetch(url, { headers, signal: controller.signal });
        clearTimeout(timeout);
        if (!res.ok) {
          const body = await res.text().catch(() => "");
          return {
            success: false,
            message: `Endpoint returned ${res.status}: ${res.statusText} ${body ? `(${body.slice(0, 100)})` : ""}`,
          };
        }
        const data = (await res.json()) as any;
        const count = Array.isArray(data?.data) ? data.data.length : undefined;
        return {
          success: true,
          message: `Connected successfully!${count ? ` (${count} models found)` : ""}`,
          modelsCount: count,
        };
      }
    }
  } catch (err: any) {
    clearTimeout(timeout);
    return {
      success: false,
      message: `Connection failed: ${err?.message || String(err)}`,
    };
  }
}
