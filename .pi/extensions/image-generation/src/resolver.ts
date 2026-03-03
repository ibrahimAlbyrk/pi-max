import { FluxProvider } from "./providers/flux.js";
import { GeminiProvider } from "./providers/gemini.js";
import { OpenAIProvider } from "./providers/openai.js";
import { StabilityProvider } from "./providers/stability.js";
import type { ImageProvider } from "./types.js";

const PROVIDERS: Record<string, () => ImageProvider> = {
	gemini: () => new GeminiProvider(),
	openai: () => new OpenAIProvider(),
	flux: () => new FluxProvider(),
	stability: () => new StabilityProvider(),
};

export const PROVIDER_NAMES = Object.keys(PROVIDERS);

export function resolveProvider(preferred?: string): ImageProvider {
	// Explicit provider selection
	if (preferred) {
		const factory = PROVIDERS[preferred];
		if (!factory) {
			throw new Error(`Unknown provider "${preferred}". Available: ${PROVIDER_NAMES.join(", ")}`);
		}
		const provider = factory();
		if (!provider.isAvailable()) {
			throw new Error(`Provider "${preferred}" is not available. Check API key.`);
		}
		return provider;
	}

	// Env var override
	const override = process.env.PI_IMAGE_PROVIDER;
	if (override) {
		return resolveProvider(override);
	}

	// Auto-detect: first available key wins
	for (const name of PROVIDER_NAMES) {
		const provider = PROVIDERS[name]!();
		if (provider.isAvailable()) {
			return provider;
		}
	}

	throw new Error(
		"No image generation API key found. Set one of: GEMINI_API_KEY, OPENAI_API_KEY, FAL_KEY, STABILITY_API_KEY",
	);
}
