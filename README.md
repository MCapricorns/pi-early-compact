# pi-early-compact

A [Pi](https://pi.dev) extension that compacts large-context models before they get dumb.

Many models advertise 1M-token context windows, but output quality often degrades
well before that — in practice around **400k tokens**. Pi's built-in auto-compaction
only kicks in when the context nearly fills the window (`contextWindow - 16k`), so a
1M-window model keeps running past the point where it stops being useful.

This extension watches context usage after every agent run and triggers compaction
early:

- **Large-window models** (`contextWindow > 400k`, e.g. 1M-class): compact at
  **350k tokens** — the 400k effective limit minus a 50k headroom, so the next run
  cannot push the context past the limit where quality drops.
- **Small-window models** (`contextWindow ≤ 400k`, e.g. 200k-class): left untouched;
  Pi's built-in threshold compaction already handles them closer to the window.

Compaction fires on `agent_settled` — only when the agent has fully finished and no
retry, queued continuation, or built-in compaction is pending — so it never
interrupts work in progress. It shows a single info notification when it triggers,
and Pi's built-in overflow recovery remains as a safety net.

While a large-window model is active, the extension also adds a footer status slot
like `early 352k/400k (88%)` — context usage measured against the effective limit
instead of the advertised window, so you can see how close an early compaction is.
Small-window models get no slot; Pi's own footer percentage already covers them.

## Install

```sh
pi install npm:pi-early-compact
```

Then restart Pi (or run `/reload`). No configuration needed.

## How it works

| Setting | Value |
| --- | --- |
| Effective context limit | 400,000 tokens |
| Headroom for the next run | 50,000 tokens |
| Compaction trigger | ≥ 350,000 tokens, window > 400k |
| Trigger point | after each settled agent run |

1. After every settled run, the extension reads `ctx.getContextUsage()`.
2. If the estimated context is at or above 350k on a model whose window exceeds
   400k, it calls `ctx.compact()` — Pi's own native compaction pipeline and
   summary prompt, identical to a manual `/compact` — and notifies the user.
3. Small-window models and fresh post-compaction contexts (unknown token count)
   are ignored.

## Development

```sh
npm install
npm run check   # tsc --noEmit
npm test        # node --test
```

Requires Node.js ≥ 22.18 (Pi runs extensions with TypeScript support built in —
there is no build step).

## License

[MIT](LICENSE)
