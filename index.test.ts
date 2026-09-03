import assert from "node:assert/strict";
import { describe, it } from "node:test";

import extension, { shouldCompactEarly, statusText } from "./index.ts";

import type {
	ContextUsage,
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

function usage(tokens: number | null, contextWindow: number): ContextUsage {
	return {
		tokens,
		contextWindow,
		percent: tokens === null ? null : (tokens / contextWindow) * 100,
	};
}

describe("shouldCompactEarly", () => {
	it("does not compact when token count is unknown", () => {
		assert.equal(shouldCompactEarly(usage(null, 1_000_000)), false);
	});

	it("leaves models within the effective limit to pi's built-in compaction", () => {
		assert.equal(shouldCompactEarly(usage(199_000, 200_000)), false);
		assert.equal(shouldCompactEarly(usage(399_000, 400_000)), false);
	});

	it("compacts large-window models at the headroom-adjusted threshold", () => {
		assert.equal(shouldCompactEarly(usage(349_999, 1_000_000)), false);
		assert.equal(shouldCompactEarly(usage(350_000, 1_000_000)), true);
		assert.equal(shouldCompactEarly(usage(500_000, 1_000_000)), true);
	});

	it("applies the same absolute threshold regardless of window size", () => {
		assert.equal(shouldCompactEarly(usage(350_000, 500_000)), true);
		assert.equal(shouldCompactEarly(usage(350_000, 2_000_000)), true);
	});
});

describe("statusText", () => {
	it("shows context against the effective limit for large-window models", () => {
		assert.equal(statusText(usage(200_000, 1_000_000)), "early 200k/400k (50%)");
		assert.equal(statusText(usage(352_000, 1_047_576)), "early 352k/400k (88%)");
	});

	it("shows a placeholder while token count is unknown", () => {
		assert.equal(statusText(usage(null, 1_000_000)), "early -/400k");
	});

	it("shows nothing for models within the effective limit", () => {
		assert.equal(statusText(usage(100_000, 200_000)), undefined);
	});
});

describe("extension wiring", () => {
	type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

	function loadExtension() {
		const handlers = new Map<string, Handler>();
		const pi = {
			on: (event: string, handler: Handler) => {
				handlers.set(event, handler);
			},
		} as unknown as ExtensionAPI;
		extension(pi);
		return handlers;
	}

	function makeCtx(usage: ContextUsage | undefined) {
		const calls = {
			notify: [] as Array<{ message: string; type?: string }>,
			compact: 0,
			status: [] as Array<string | undefined>,
		};
		const ctx = {
			ui: {
				notify: (message: string, type?: string) => {
					calls.notify.push({ message, type });
				},
				setStatus: (_key: string, text: string | undefined) => {
					calls.status.push(text);
				},
			},
			getContextUsage: () => usage,
			compact: (options?: { onComplete?: () => void; onError?: (error: Error) => void }) => {
				calls.compact += 1;
				options?.onComplete?.();
			},
		} as unknown as ExtensionContext;
		return { ctx, calls };
	}

	it("updates the footer status on session_start, model_select and turn_end", () => {
		const handlers = loadExtension();
		for (const event of ["session_start", "model_select", "turn_end"]) {
			assert.ok(handlers.has(event), `${event} handler registered`);
		}

		const { ctx, calls } = makeCtx(usage(200_000, 1_000_000));
		handlers.get("session_start")!({ type: "session_start" }, ctx);
		handlers.get("model_select")!({ type: "model_select" }, ctx);
		handlers.get("turn_end")!({ type: "turn_end" }, ctx);
		assert.deepEqual(calls.status, [
			"early 200k/400k (50%)",
			"early 200k/400k (50%)",
			"early 200k/400k (50%)",
		]);
	});

	it("clears the footer status for small-window models", () => {
		const handlers = loadExtension();
		const { ctx, calls } = makeCtx(usage(100_000, 200_000));
		handlers.get("turn_end")!({ type: "turn_end" }, ctx);
		assert.deepEqual(calls.status, [undefined]);
	});

	it("compacts on agent_settled once the threshold is reached", () => {
		const handlers = loadExtension();
		const { ctx, calls } = makeCtx(usage(360_000, 1_000_000));
		handlers.get("agent_settled")!({ type: "agent_settled" }, ctx);

		assert.equal(calls.compact, 1);
		assert.equal(calls.notify.length, 1);
		assert.equal(calls.notify[0].type, "info");
	});

	it("stays silent below the threshold or on small-window models", () => {
		const handlers = loadExtension();

		const small = makeCtx(usage(199_000, 200_000));
		handlers.get("agent_settled")!({ type: "agent_settled" }, small.ctx);
		assert.equal(small.calls.compact, 0);

		const below = makeCtx(usage(340_000, 1_000_000));
		handlers.get("agent_settled")!({ type: "agent_settled" }, below.ctx);
		assert.equal(below.calls.compact, 0);
	});

	it("does not re-trigger while a compaction is in flight, then re-arms", () => {
		const handlers = loadExtension();
		const calls = { compact: 0 };
		let pending: (() => void) | undefined;
		const ctx = {
			ui: { notify: () => {}, setStatus: () => {} },
			getContextUsage: () => usage(360_000, 1_000_000),
			compact: (options?: { onComplete?: () => void }) => {
				calls.compact += 1;
				pending = options?.onComplete;
			},
		} as unknown as ExtensionContext;

		handlers.get("agent_settled")!({ type: "agent_settled" }, ctx);
		handlers.get("agent_settled")!({ type: "agent_settled" }, ctx);
		assert.equal(calls.compact, 1, "in-flight compaction must not trigger a second one");

		pending!();
		handlers.get("agent_settled")!({ type: "agent_settled" }, ctx);
		assert.equal(calls.compact, 2, "re-arms after the compaction completes");
	});
});
