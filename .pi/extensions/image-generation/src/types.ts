export interface GeneratedImage {
	data: string; // base64
	mimeType: string; // image/png, image/jpeg, image/webp
}

export interface GenerateParams {
	prompt: string;
	aspectRatio?: string;
	size?: string;
	signal?: AbortSignal;
}

export interface EditParams {
	prompt: string;
	sourceImage: { data: string; mimeType: string };
	referenceImages?: Array<{ data: string; mimeType: string }>;
	aspectRatio?: string;
	size?: string;
	signal?: AbortSignal;
}

export interface ImageProvider {
	name: string;
	isAvailable(): boolean;
	estimateCost(params: { size?: string }): number;
	generate(params: GenerateParams): Promise<GeneratedImage>;
	edit?(params: EditParams): Promise<GeneratedImage>;
}
