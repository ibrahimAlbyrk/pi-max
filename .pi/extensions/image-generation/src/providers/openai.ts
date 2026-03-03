import type { EditParams, GenerateParams, GeneratedImage, ImageProvider } from "../types.js";

const BASE_URL = "https://api.openai.com/v1";

export class OpenAIProvider implements ImageProvider {
	name = "openai";

	isAvailable(): boolean {
		return !!process.env.OPENAI_API_KEY;
	}

	async generate(params: GenerateParams): Promise<GeneratedImage> {
		const size = this.mapSize(params.size, params.aspectRatio);

		const body: Record<string, unknown> = {
			model: "gpt-image-1",
			prompt: params.prompt,
			n: 1,
			size,
			response_format: "b64_json",
		};

		const response = await fetch(`${BASE_URL}/images/generations`, {
			method: "POST",
			headers: this.headers(),
			body: JSON.stringify(body),
			signal: params.signal,
		});

		if (!response.ok) {
			const err = await response.text();
			throw new Error(`OpenAI image generation failed (${response.status}): ${err}`);
		}

		const json = (await response.json()) as {
			data?: Array<{ b64_json?: string }>;
		};

		const b64 = json.data?.[0]?.b64_json;
		if (!b64) {
			throw new Error("OpenAI returned no image data.");
		}

		return { data: b64, mimeType: "image/png" };
	}

	async edit(params: EditParams): Promise<GeneratedImage> {
		const formData = new FormData();
		formData.append("model", "gpt-image-1");
		formData.append("prompt", params.prompt);
		formData.append("response_format", "b64_json");

		// Convert base64 source image to Blob
		const srcBuffer = Buffer.from(params.sourceImage.data, "base64");
		const srcBlob = new Blob([srcBuffer], { type: params.sourceImage.mimeType });
		formData.append("image", srcBlob, "source.png");

		const response = await fetch(`${BASE_URL}/images/edits`, {
			method: "POST",
			headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
			body: formData,
			signal: params.signal,
		});

		if (!response.ok) {
			const err = await response.text();
			throw new Error(`OpenAI image edit failed (${response.status}): ${err}`);
		}

		const json = (await response.json()) as {
			data?: Array<{ b64_json?: string }>;
		};

		const b64 = json.data?.[0]?.b64_json;
		if (!b64) {
			throw new Error("OpenAI returned no image data.");
		}

		return { data: b64, mimeType: "image/png" };
	}

	private headers(): Record<string, string> {
		return {
			Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
			"Content-Type": "application/json",
		};
	}

	private mapSize(size?: string, aspectRatio?: string): string {
		// gpt-image-1 supports: 1024x1024, 1536x1024, 1024x1536, auto
		if (aspectRatio === "16:9" || aspectRatio === "3:2") return "1536x1024";
		if (aspectRatio === "9:16" || aspectRatio === "2:3") return "1024x1536";
		return "1024x1024";
	}
}
