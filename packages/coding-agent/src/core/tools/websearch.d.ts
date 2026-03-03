import type { AgentTool } from "@mariozechner/pi-agent-core";
import { type Static } from "@sinclair/typebox";
declare const websearchSchema: import("@sinclair/typebox").TObject<{
	query: import("@sinclair/typebox").TString;
	count: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TNumber>;
	site: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
}>;
export type WebsearchToolInput = Static<typeof websearchSchema>;
export interface WebsearchToolDetails {
	query: string;
	provider: string;
	resultCount: number;
}
export declare function createWebsearchTool(): AgentTool<typeof websearchSchema>;
/** Default websearch tool */
export declare const websearchTool: AgentTool<
	import("@sinclair/typebox").TObject<{
		query: import("@sinclair/typebox").TString;
		count: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TNumber>;
		site: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
	}>,
	any
>;
//# sourceMappingURL=websearch.d.ts.map
