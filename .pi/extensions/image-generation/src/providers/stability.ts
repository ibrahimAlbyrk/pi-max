import type { EditParams, GenerateParams, GeneratedImage, ImageProvider } from "../types.js";

const BASE_URL = "https://api.stability.ai";

export class StabilityProvider implements ImageProvider {
	name = "stability";

	isAvailable(): boolean {
		return !!process.env.STABILITY_API_KEY;
	}

	async generate(params: GenerateParams): Promise<GeneratedImage> {
		const formData = new FormData();
		formData.append("prompt", params.prompt);
		formData.append("output_format", "png");

		if (params.aspectRatio) {
			formData.append("aspect_ratio", params.aspectRatio);
		}

		const response = await fetch(`${BASE_URL}/v2beta/stable-image/generate/sd3`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${process.env.STABILITY_API_KEY}`,
				Accept: "image/*",
			},
			body: formData,
			signal: params.signal,
		});

		if (!response.ok) {
			const err = await response.text();
			throw new Error(`Stability generation failed (${response.status}): ${err}`);
		}

		const buffer = Buffer.from(await response.arrayBuffer());
		return { data: buffer.toString("base64"), mimeType: "image/png" };
	}

	async edit(params: EditParams): Promise<GeneratedImage> {
		const formData = new FormData();
		formData.append("prompt", params.prompt);
		formData.append("output_format", "png");
		formData.append("mode", "search-and-replace");
		formData.append("search_prompt", "original");

		// Source image as Blob
		const srcBuffer = Buffer.from(params.sourceImage.data, "base64");
		const srcBlob = new Blob([srcBuffer], { type: params.sourceImage.mimeType });
		formData.append("image", srcBlob, "source.png");

		const response = await fetch(`${BASE_URL}/v2beta/stable-image/edit/search-and-replace`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${process.env.STABILITY_API_KEY}`,
				Accept: "image/*",
			},
			body: formData,
			signal: params.signal,
		});

		if (!response.ok) {
			const err = await response.text();
			throw new Error(`Stability edit failed (${response.status}): ${err}`);
		}

		const buffer = Buffer.from(await response.arrayBuffer());
		return { data: buffer.toString("base64"), mimeType: "image/png" };
	}
}
