import type {
	ContextUsage,
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

/**
 * Models advertised with context windows above this (e.g. 1M-class) tend to
 * degrade well before filling the window. Treat it as their effective ceiling.
 */
const EFFECTIVE_LIMIT_TOKENS = 400_000;

/**
 * Reserved for the next run's growth (prompt + response + tool results), so
 * compaction fires before the context can cross the effective limit mid-run.
 */
const HEADROOM_TOKENS = 50_000;

const STATUS_KEY = "pi-early-compact";

/**
 * Decide whether the session should be compacted early. Models whose window
 * fits within the effective limit are left to pi's built-in threshold
 * compaction (contextWindow - 16k reserve).
 */
export function shouldCompactEarly(usage: ContextUsage): boolean {
	const { tokens, contextWindow } = usage;
	if (tokens === null) {
		return false;
	}
	if (contextWindow <= EFFECTIVE_LIMIT_TOKENS) {
		return false;
	}
	return tokens >= EFFECTIVE_LIMIT_TOKENS - HEADROOM_TOKENS;
}

function formatTokens(tokens: number): string {
	if (tokens >= 1_000_000) {
		return `${(tokens / 1_000_000).toFixed(1)}M`;
	}
	return `${Math.round(tokens / 1000)}k`;
}

/**
 * Footer text showing context against the effective limit instead of the
 * advertised window, or undefined for models this extension does not manage.
 */
export function statusText(usage: ContextUsage): string | undefined {
	const { tokens, contextWindow } = usage;
	if (contextWindow <= EFFECTIVE_LIMIT_TOKENS) {
		return undefined;
	}
	if (tokens === null) {
		return `early -/${formatTokens(EFFECTIVE_LIMIT_TOKENS)}`;
	}
	const percent = Math.round((tokens / EFFECTIVE_LIMIT_TOKENS) * 100);
	return `early ${formatTokens(tokens)}/${formatTokens(EFFECTIVE_LIMIT_TOKENS)} (${percent}%)`;
}

export default function (pi: ExtensionAPI): void {
	let compacting = false;

	const updateStatus = (ctx: ExtensionContext): void => {
		const usage = ctx.getContextUsage();
		ctx.ui.setStatus(STATUS_KEY, usage ? statusText(usage) : undefined);
	};

	// Covers compaction ends that bypass the compact callbacks (e.g. cancelled
	// by another extension's session_before_compact hook).
	const onCompactionEnd = (_event: unknown, ctx: ExtensionContext): void => {
		compacting = false;
		updateStatus(ctx);
	};

	pi.on("session_start", (_event, ctx) => updateStatus(ctx));
	pi.on("model_select", (_event, ctx) => updateStatus(ctx));
	pi.on("turn_end", (_event, ctx) => updateStatus(ctx));

	pi.on("session_compact", onCompactionEnd);
	pi.on("session_compact_failed", onCompactionEnd);

	pi.on("agent_settled", (_event, ctx) => {
		if (compacting) {
			return;
		}
		const usage = ctx.getContextUsage();
		const tokens = usage?.tokens ?? null;
		if (!usage || tokens === null || !shouldCompactEarly(usage)) {
			return;
		}

		compacting = true;
		ctx.ui.notify(
			`pi-early-compact: context at ${formatTokens(tokens)} of ${formatTokens(usage.contextWindow)} window, compacting early (effective limit ${formatTokens(EFFECTIVE_LIMIT_TOKENS)})`,
			"info",
		);
		ctx.compact({
			onComplete: () => {
				compacting = false;
			},
			onError: () => {
				compacting = false;
			},
		});
	});
}
