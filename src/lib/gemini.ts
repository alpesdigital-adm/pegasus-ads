const GEMINI_API_URL = "https://generativelanguage.googleapis.com/v1beta/models";

export interface GeminiImageRequest {
  prompt: string;
  referenceImages?: { base64: string; mimeType: string }[];
  aspectRatio?: string;
  imageSize?: string;
  model?: string;
}

export interface GeminiImageResponse {
  text?: string;
  images: { base64: string; mimeType: string }[];
  model: string;
  error?: string;
}

export async function generateImage(
  request: GeminiImageRequest
): Promise<GeminiImageResponse> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY not configured");

  const model = request.model || "gemini-2.5-flash-image";
  const url = `${GEMINI_API_URL}/${model}:generateContent?key=${apiKey}`;

  // Build parts array: text prompt + reference images
  const parts: Record<string, unknown>[] = [{ text: request.prompt }];

  if (request.referenceImages) {
    for (const img of request.referenceImages) {
      parts.push({
        inline_data: {
          mime_type: img.mimeType,
          data: img.base64,
        },
      });
    }
  }

  const body = {
    contents: [{ parts }],
    generationConfig: {
      responseModalities: ["TEXT", "IMAGE"],
      ...(request.aspectRatio || request.imageSize
        ? {
            imageConfig: {
              ...(request.aspectRatio && { aspectRatio: request.aspectRatio }),
              ...(request.imageSize && { imageSize: request.imageSize }),
            },
          }
        : {}),
    },
  };

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const error = await response.text();
    return { images: [], model, error: `Gemini API error ${response.status}: ${error}` };
  }

  const data = await response.json();
  const candidate = data.candidates?.[0];
  if (!candidate) {
    return { images: [], model, error: "No candidates returned" };
  }

  const resultParts = candidate.content?.parts || [];
  const images: { base64: string; mimeType: string }[] = [];
  let text = "";

  for (const part of resultParts) {
    if (part.text) {
      text += part.text;
    }
    if (part.inline_data) {
      images.push({
        base64: part.inline_data.data,
        mimeType: part.inline_data.mime_type,
      });
    }
  }

  return { text, images, model };
}
