# cmd-auto-compact

Threshold-based auto-compaction for Command Code, in the spirit of Claude Code's auto-compact. Command Code only compacts when the model's context window is nearly full, so a 1M-token model can run a session at 300k-900k per turn for days. This mod compacts as soon as a threshold you choose is reached.

## Install

From the folder that contains all your mods (`E:\Projects\mods` on this machine):

```bash
cmdc mods add -g ./auto-compact       # every project, your user scope
cmdc mods add ./auto-compact          # this project only
cmdc --mod ./auto-compact/index.ts    # try it without installing
```

After installing, `/reload` or start a new session.

## Usage

Default threshold: 200k tokens (20% of a 1M window). Shorthand is accepted everywhere: 150k, 200k, 150,000 or 250000.

```text
/auto-compact           show status, threshold and current context
/auto-compact 200k      set the threshold
/auto-compact 20%       set a percentage of the context window
/auto-compact on        enable
/auto-compact off       disable
/auto-compact now       compact immediately
```

The older `/auto-compact threshold 200k` form still works. Startup options through mod flags:

```bash
cmdc --mod-option auto-compact-threshold=150k
cmdc --mod-option auto-compact-threshold=20%
cmdc --mod-option auto-compact-off=true
```

Settings changed with `/auto-compact` persist across sessions in the mod store and take precedence over the startup flag.

## How it works

- Reads `cmd.getContextUsage()` after every user turn (`onRunEnd`) and compacts through `cmd.sessions.compact()` when `tokens >= threshold`.
- While it runs, the status row under the input shows live elapsed seconds (`auto-compact: compacting… 12s`). On completion you get a notice with the elapsed time, the tokens saved and the new context size; `/auto-compact` also shows the last saving.
- `/auto-compact now` compacts immediately and ignores the threshold.
- Compaction is not instant: a 200k+ session typically takes 10-30 seconds. It is not stuck.
- The first request after compaction is billed as fresh input (the prompt cache is rebuilt), so that one turn costs more than a normal cached turn. Later turns return to cached pricing.
- After a compaction the host may leave a large recent context. The mod requires at least 15k tokens of new growth (or 5% of the threshold, whichever is larger) before auto-compacting again, so it cannot loop when the post-compaction floor is above your threshold. Keep the threshold comfortably above that floor.
- Falls back to a message-size estimate when the host has not measured the window yet, so it still works in headless and early-turn cases.
- Never compacts mid-run: a long turn may still grow, but the next turn starts under the threshold.
- A 15-second cooldown prevents repeated compaction in quick succession.
- Safe no-op when no session is bound or session controls are unavailable.
- `--mod-option auto-compact-debug=true` records every measurement and attempt in the session log (custom entry `auto-compact/event`) and in the mod store.

## Share it with the community

The package already carries the `cmd-mod` keyword and the `commandcode.mods` entry point.

1. Publish it: `npm publish` (rename to an available npm name first, for example a scoped `@yourname/cmd-auto-compact`).
2. Open a PR against `mods/registry.json` in `CommandCodeAI/command-code`:

```json
{
	"name": "auto-compact",
	"source": "cmd-auto-compact",
	"npm": "cmd-auto-compact",
	"description": "Compacts a Command Code session when it reaches a token threshold you choose.",
	"author": {"name": "Your Name", "github": "your-handle"},
	"kinds": ["hook", "command", "flag"],
	"tags": ["context", "tokens", "compaction", "cost"]
}
```

Once merged, it appears on https://commandcode.ai/mods within about 15 minutes.

## License

MIT
