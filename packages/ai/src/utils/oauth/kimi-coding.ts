/**
 * Kimi Code OAuth flow (device code)
 *
 * Uses OAuth device code flow, same as Kimi CLI:
 * https://github.com/MoonshotAI/kimi-cli
 */

import type { OAuthCredentials, OAuthLoginCallbacks, OAuthProviderInterface } from "./types.js";

const CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098";
const OAUTH_HOST = "https://auth.kimi.com";
const DEVICE_AUTH_URL = `${OAUTH_HOST}/api/oauth/device_authorization`;
const TOKEN_URL = `${OAUTH_HOST}/api/oauth/token`;

type DeviceAuthResponse = {
	device_code: string;
	user_code: string;
	verification_uri: string;
	verification_uri_complete: string;
	expires_in: number;
	interval: number;
};

type TokenSuccessResponse = {
	access_token: string;
	refresh_token: string;
	expires_in: number;
	scope: string;
	token_type: string;
};

type TokenErrorResponse = {
	error: string;
	error_description?: string;
};

async function requestDeviceAuthorization(): Promise<DeviceAuthResponse> {
	const response = await fetch(DEVICE_AUTH_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({ client_id: CLIENT_ID }),
	});

	if (!response.ok) {
		const text = await response.text();
		throw new Error(`Device authorization failed: ${response.status} ${text}`);
	}

	const data = (await response.json()) as DeviceAuthResponse;
	if (!data.device_code || !data.verification_uri_complete) {
		throw new Error("Invalid device authorization response");
	}

	return data;
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error("Login cancelled"));
			return;
		}
		const timeout = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timeout);
				reject(new Error("Login cancelled"));
			},
			{ once: true },
		);
	});
}

async function pollForToken(
	deviceCode: string,
	intervalSeconds: number,
	expiresIn: number,
	signal?: AbortSignal,
): Promise<TokenSuccessResponse> {
	const deadline = Date.now() + expiresIn * 1000;
	let intervalMs = Math.max(1000, intervalSeconds * 1000);

	while (Date.now() < deadline) {
		if (signal?.aborted) {
			throw new Error("Login cancelled");
		}

		const response = await fetch(TOKEN_URL, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				client_id: CLIENT_ID,
				device_code: deviceCode,
				grant_type: "urn:ietf:params:oauth:grant-type:device_code",
			}),
		});

		const data = (await response.json()) as TokenSuccessResponse | TokenErrorResponse;

		if (response.ok && "access_token" in data) {
			return data;
		}

		if ("error" in data) {
			const error = data.error;

			if (error === "authorization_pending") {
				await abortableSleep(intervalMs, signal);
				continue;
			}

			if (error === "slow_down") {
				intervalMs += 5000;
				await abortableSleep(intervalMs, signal);
				continue;
			}

			if (error === "expired_token") {
				throw new Error("Device code expired. Please try again.");
			}

			throw new Error(`Device flow failed: ${error} ${data.error_description ?? ""}`);
		}

		await abortableSleep(intervalMs, signal);
	}

	throw new Error("Device flow timed out");
}

export async function refreshKimiToken(refreshTokenValue: string): Promise<OAuthCredentials> {
	const response = await fetch(TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			client_id: CLIENT_ID,
			grant_type: "refresh_token",
			refresh_token: refreshTokenValue,
		}),
	});

	if (!response.ok) {
		const text = await response.text();
		throw new Error(`Token refresh failed: ${response.status} ${text}`);
	}

	const data = (await response.json()) as TokenSuccessResponse;
	return {
		access: data.access_token,
		refresh: data.refresh_token,
		expires: Date.now() + data.expires_in * 1000 - 5 * 60 * 1000,
	};
}

export async function loginKimiCoding(options: {
	onAuth: (url: string, instructions?: string) => void;
	onProgress?: (message: string) => void;
	signal?: AbortSignal;
}): Promise<OAuthCredentials> {
	const device = await requestDeviceAuthorization();

	options.onAuth(device.verification_uri_complete, `Enter code: ${device.user_code}`);

	options.onProgress?.("Waiting for browser authorization...");

	const tokenData = await pollForToken(device.device_code, device.interval, device.expires_in ?? 600, options.signal);

	return {
		access: tokenData.access_token,
		refresh: tokenData.refresh_token,
		expires: Date.now() + tokenData.expires_in * 1000 - 5 * 60 * 1000,
	};
}

export const kimiCodingOAuthProvider: OAuthProviderInterface = {
	id: "kimi-coding",
	name: "Kimi Code",

	async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
		return loginKimiCoding({
			onAuth: (url, instructions) => callbacks.onAuth({ url, instructions }),
			onProgress: callbacks.onProgress,
			signal: callbacks.signal,
		});
	},

	async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
		return refreshKimiToken(credentials.refresh);
	},

	getApiKey(credentials: OAuthCredentials): string {
		return credentials.access;
	},
};
