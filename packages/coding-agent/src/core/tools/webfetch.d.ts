import type { AgentTool } from "@mariozechner/pi-agent-core";
import { type Static } from "@sinclair/typebox";
import { type TruncationResult } from "./truncate.js";
declare const webfetchSchema: import("@sinclair/typebox").TObject<{
	url: import("@sinclair/typebox").TString;
	selector: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
	raw: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
	limit: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TNumber>;
}>;
export type WebfetchToolInput = Static<typeof webfetchSchema>;
export interface WebfetchToolDetails {
	url: string;
	statusCode: number;
	contentType?: string;
	title?: string;
	truncation?: TruncationResult;
}
export declare function createWebfetchTool(): AgentTool<typeof webfetchSchema>;
/** Default webfetch tool */
export declare const webfetchTool: AgentTool<
	import("@sinclair/typebox").TObject<{
		url: import("@sinclair/typebox").TString;
		selector: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
		raw: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
		limit: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TNumber>;
	}>,
	any
>;
//# sourceMappingURL=webfetch.d.ts.map
