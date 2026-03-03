import type { EditParams, GenerateParams, GeneratedImage, ImageProvider } from "../types.js";

const BASE_URL = "https://queue.fal.run";
const GENERATE_ENDPOINT = "fal-ai/flux-pro/v1.1";
const IMG2IMG_ENDPOINT = "fal-ai/flux-general/image-to-image";
const POLL_INTERVAL_MS = 2000;
const MAX_POLL_ATTEMPTS = 60; // 2 minutes max

export class FluxProvider implements ImageProvider {
	name = "flux";

	isAvailable(): boolean {
		return !!process.env.FAL_KEY;
	}

	async generate(params: GenerateParams): Promise<GeneratedImage> {
		const body: Record<string, unknown> = {
			prompt: params.prompt,
			num_images: 1,
			enable_safety_checker: false,
		};

		if (params.aspectRatio) {
			const dims = this.aspectRatioToDimensions(params.aspectRatio);
			body.image_size = { width: dims.width, height: dims.height };
		}

		const result = await this.submitAndPoll(GENERATE_ENDPOINT, body, params.signal);
		return this.extractImage(result);
	}

	async edit(params: EditParams): Promise<GeneratedImage> {
		// Upload source image as data URI for fal.ai
		const dataUri = `data:${params.sourceImage.mimeType};base64,${params.sourceImage.data}`;

		const body: Record<string, unknown> = {
			prompt: params.prompt,
			image_url: dataUri,
			num_images: 1,
			strength: 0.75,
			enable_safety_checker: false,
		};

		const result = await this.submitAndPoll(IMG2IMG_ENDPOINT, body, params.signal);
		return this.extractImage(result);
	}

	private async submitAndPoll(
		endpoint: string,
		body: Record<string, unknown>,
		signal?: AbortSignal,
	): Promise<Record<string, unknown>> {
		// Submit to queue
		const submitResponse = await fetch(`${BASE_URL}/${endpoint}`, {
			method: "POST",
			headers: this.headers(),
			body: JSON.stringify(body),
			signal,
		});

		if (!submitResponse.ok) {
			const err = await submitResponse.text();
			throw new Error(`FLUX submit failed (${submitResponse.status}): ${err}`);
		}

		const submitResult = (await submitResponse.json()) as {
			request_id?: string;
			status?: string;
			images?: unknown[];
		};

		// If result is immediate (no queue)
		if (submitResult.images) {
			return submitResult;
		}

		const requestId = submitResult.request_id;
		if (!requestId) {
			throw new Error("FLUX returned no request_id.");
		}

		// Poll for completion
		for (let i = 0; i < MAX_POLL_ATTEMPTS; i++) {
			if (signal?.aborted) throw new Error("Aborted");

			await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));

			const statusResponse = await fetch(
				`https://queue.fal.run/${endpoint}/requests/${requestId}/status`,
				{ headers: this.headers(), signal },
			);

			if (!statusResponse.ok) continue;

			const status = (await statusResponse.json()) as { status?: string };
			if (status.status === "COMPLETED") {
				const resultResponse = await fetch(
					`https://queue.fal.run/${endpoint}/requests/${requestId}`,
					{ headers: this.headers(), signal },
				);
				if (!resultResponse.ok) {
					throw new Error(`FLUX result fetch failed (${resultResponse.status})`);
				}
				return (await resultResponse.json()) as Record<string, unknown>;
			}

			if (status.status === "FAILED") {
				throw new Error("FLUX generation failed.");
			}
		}

		throw new Error("FLUX generation timed out.");
	}

	private async extractImage(result: Record<string, unknown>): Promise<GeneratedImage> {
		const images = result.images as Array<{ url?: string; content_type?: string }> | undefined;
		const imageUrl = images?.[0]?.url;
		if (!imageUrl) {
			throw new Error("FLUX returned no image.");
		}

		// Fetch image from URL and convert to base64
		const imageResponse = await fetch(imageUrl);
		if (!imageResponse.ok) {
			throw new Error(`Failed to fetch FLUX image (${imageResponse.status})`);
		}

		const buffer = Buffer.from(await imageResponse.arrayBuffer());
		const mimeType = images?.[0]?.content_type || imageResponse.headers.get("content-type") || "image/jpeg";

		return { data: buffer.toString("base64"), mimeType };
	}

	private headers(): Record<string, string> {
		return {
			Authorization: `Key ${process.env.FAL_KEY}`,
			"Content-Type": "application/json",
		};
	}

	private aspectRatioToDimensions(ratio: string): { width: number; height: number } {
		const map: Record<string, { width: number; height: number }> = {
			"1:1": { width: 1024, height: 1024 },
			"16:9": { width: 1344, height: 768 },
			"9:16": { width: 768, height: 1344 },
			"3:2": { width: 1216, height: 832 },
			"2:3": { width: 832, height: 1216 },
			"4:3": { width: 1152, height: 896 },
			"3:4": { width: 896, height: 1152 },
			"4:5": { width: 896, height: 1088 },
			"5:4": { width: 1088, height: 896 },
			"21:9": { width: 1536, height: 640 },
		};
		return map[ratio] || { width: 1024, height: 1024 };
	}
}
