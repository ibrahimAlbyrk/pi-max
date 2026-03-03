import { GoogleGenAI } from "@google/genai";
import type { EditParams, GenerateParams, GeneratedImage, ImageProvider } from "../types.js";

const DEFAULT_MODEL = "gemini-3.1-flash-image-preview";

export class GeminiProvider implements ImageProvider {
	name = "gemini";

	isAvailable(): boolean {
		return !!process.env.GEMINI_API_KEY;
	}

	async generate(params: GenerateParams): Promise<GeneratedImage> {
		const ai = this.getClient();
		const response = await ai.models.generateContent({
			model: DEFAULT_MODEL,
			contents: params.prompt,
			config: {
				responseModalities: ["TEXT", "IMAGE"],
				imageConfig: {
					...(params.aspectRatio ? { aspectRatio: params.aspectRatio } : {}),
					...(params.size ? { imageSize: params.size } : {}),
				},
			},
		});

		return this.extractImage(response);
	}

	async edit(params: EditParams): Promise<GeneratedImage> {
		const ai = this.getClient();

		const contentParts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = [];
		contentParts.push({ text: params.prompt });
		contentParts.push({ inlineData: { mimeType: params.sourceImage.mimeType, data: params.sourceImage.data } });

		if (params.referenceImages) {
			for (const ref of params.referenceImages.slice(0, 13)) {
				contentParts.push({ inlineData: { mimeType: ref.mimeType, data: ref.data } });
			}
		}

		const response = await ai.models.generateContent({
			model: DEFAULT_MODEL,
			contents: contentParts,
			config: {
				responseModalities: ["TEXT", "IMAGE"],
				imageConfig: {
					...(params.aspectRatio ? { aspectRatio: params.aspectRatio } : {}),
					...(params.size ? { imageSize: params.size } : {}),
				},
			},
		});

		return this.extractImage(response);
	}

	private getClient(): GoogleGenAI {
		const apiKey = process.env.GEMINI_API_KEY;
		if (!apiKey) {
			throw new Error("GEMINI_API_KEY is not set.");
		}
		return new GoogleGenAI({ apiKey });
	}

	private extractImage(response: { candidates?: Array<{ content?: { parts?: Array<{ text?: string; inlineData?: { data?: string; mimeType?: string } }> } }> }): GeneratedImage {
		const parts = response.candidates?.[0]?.content?.parts;
		if (parts) {
			for (const part of parts) {
				if (part.inlineData?.data) {
					return {
						data: part.inlineData.data,
						mimeType: part.inlineData.mimeType || "image/png",
					};
				}
			}
		}
		throw new Error("Gemini returned no image data.");
	}
}
