# cmd-auto-compact

Usage-first precision compaction for Command Code.

Most auto-compact tools call the host summarizer as soon as a token threshold is crossed. That summary is a large, uncached model request, and the next turn rebuilds the prompt cache. On a plan metered in credits, that can cost more than it saves.

This mod flips the default:

- **Free precision mode (default):** no `cmd.sessions.compact()` call. The mod keeps a deterministic index of exact facts, injects a small precision pack into the system prompt, and exposes a `precision_recall` tool. The host's built-in 90% compaction remains the safety net.
- **Paid handoff mode (opt-in):** call the host summarizer deliberately, at 800k by default or with `/auto-compact now`, with the uncached cost shown first.

The full session transcript is never rewritten. The mod only changes what the model sees and what it can recall.

## Install

From the folder that contains all your mods (`E:\Projects\mods` on this machine):

```bash
cmdc mods add -g ./auto-compact       # every project, your user scope
cmdc mods add ./auto-compact          # this project only
cmdc --mod ./auto-compact/index.ts    # try it without installing
```

After installing, `/reload` or start a new session.

## Usage

Default is free mode: no paid summary is added.

```text
/auto-compact                   show mode, context, facts, pack and last paid saving
/auto-compact mode free         free mode: no paid compaction (default)
/auto-compact mode handoff      opt in to paid semantic summaries
/auto-compact on                enable the handoff auto-trigger
/auto-compact off               disable the handoff auto-trigger
/auto-compact now               paid handoff now, with a cost confirmation
/auto-compact 800k              set the handoff threshold
/auto-compact 80%               threshold as a share of the context window
/auto-compact pack              preview the exact system-prompt pack
/auto-compact pack refresh      rebuild the pack
/auto-compact index             fact counts by kind
/auto-compact recall <query>    search exact facts
/auto-compact forget            clear the index and pack for this session
```

Shorthand is accepted everywhere: `800k`, `1m`, `800,000`, `80%`. The older `/auto-compact threshold 800k` form still works.

Startup options:

```bash
cmdc --mod-option auto-compact-threshold=800k
cmdc --mod-option auto-compact-off=true
cmdc --mod-option auto-compact-debug=true
```

A handoff below 700k is allowed but warned about: the summary call is large and uncached, so it is a quality/headroom choice, not a usage saver. In headless runs the `now` confirmation resolves to "no", so automation never pays for a summary by accident.

## What the precision layer does

On every turn the mod extracts exact facts from the conversation:

- user constraints and preferences, verbatim
- files read, written and edited
- commands, exit codes and failing lines
- test results
- commits and hashes
- URLs, PRs/issues, versions and branches
- decisions and status lines (DONE/TODO/BLOCKED)

It stores them in a bounded index (500 facts) and snapshots the index with `cmd.session.appendCustomEntry`. That entry is mod-private: it is never sent to the model and it survives resume. It is not written to `cmd.store`, so status checks do not trigger the mod hot-reloader.

At 50% of the context window (or the handoff threshold, whichever is lower) the mod builds a 2-4k-token **precision pack** and injects it through `appendSystemPrompt`. Because the pack lives in the system prompt, the host's compaction cannot summarize it away. The pack is rebuilt only at a handoff or on `/auto-compact pack refresh`, so it stays byte-stable between rebuilds and does not churn the prompt cache.

The `precision_recall` tool is read-only and searches the exact index. It has no filesystem, process or network access. The agent is told to use it, or re-read files and tests, whenever exact paths, hashes, numbers or error strings matter.

## What this does not do

- It does not rewrite the saved transcript. The session log stays append-only.
- It does not by itself shrink the context. For free tool-call trimming, use the host's `/compact-mode fast` (old tool results are trimmed at 50%/80% with no model call). The mod's free mode is exact memory, not a context-size shrinker.
- It does not prevent the host's built-in 90% compaction. That safety net still runs if a session reaches it. This mod only avoids adding **earlier** paid summaries.
- It does not guarantee a fixed 30% usage increase. The saving depends on how often the paid summary would have fired. The mod is designed so that the free path adds no summary cost; measure your own `/usage` before and after.

## Security

The pack is data, never instructions. User constraints are quoted; tool output is shortened to whitelisted snippets; instructions embedded in tool output are not to be followed.

Secrets are redacted before the index snapshot, the pack or recall output: `sk-`, `AKIA`, `ghp_`, `Bearer`, `api_key=`, `token=`, `password=`, private-key blocks and similar patterns. If the agent needs a secret, it should read the environment or file, not the index.

The pack is capped at ~4k tokens. Preview exactly what will be sent with `/auto-compact pack`; clear it with `/auto-compact forget`. The mod runs no processes and opens no network connections.

## Guarantees

- The saved transcript is never rewritten.
- No paid compaction is added unless you enable handoff mode or run `/auto-compact now`.
- Exact facts are retrievable through `precision_recall` and the full transcript.
- The pack is bounded, redacted and labelled as data.
- The **not** guaranteed part: a fixed usage increase. The host's built-in 90% compaction still applies, and the pack adds a small cached overhead.

## License

Apache 2.0
