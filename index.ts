import type {ModApi} from '@commandcode/harness';

const DEFAULT_THRESHOLD = 200_000;
const MIN_THRESHOLD = 20_000;
const COOLDOWN_MS = 15_000;
const STORE_KEY = 'settings';

interface AutoCompactSettings {
	enabled: boolean;
	threshold: number;
}

interface AutoCompactEvent {
	at: string;
	action: 'requested' | 'done' | 'failed' | 'checked';
	tokens: number | null;
	threshold: number;
	after?: number | null;
	saved?: number;
	contextWindow?: number | null;
	enabled?: boolean;
	error?: string;
}

function parseThreshold(raw: string, contextWindow?: number): number | undefined {
	const value = raw.trim().toLowerCase().replace(/[,_\s]/g, '');
	if (!value) return undefined;
	if (value.endsWith('%')) {
		const percent = Number(value.slice(0, -1));
		if (!Number.isFinite(percent) || percent <= 0 || percent >= 100 || !contextWindow) return undefined;
		return Math.round((contextWindow * percent) / 100);
	}
	const match = value.match(/^(\d+(?:\.\d+)?)([km])?$/);
	if (!match) return undefined;
	const amount = Number(match[1]);
	const unit = match[2];
	const tokens = unit === 'k' ? amount * 1000 : unit === 'm' ? amount * 1_000_000 : amount;
	if (!Number.isFinite(tokens) || tokens <= 0) return undefined;
	return Math.round(tokens);
}

function formatTokens(tokens: number): string {
	if (tokens >= 1_000_000) {
		const value = tokens / 1_000_000;
		return `${Number.isInteger(value) ? value : value.toFixed(1)}M`;
	}
	if (tokens >= 1000) {
		const value = tokens / 1000;
		return `${Number.isInteger(value) ? value : value.toFixed(1)}k`;
	}
	return String(tokens);
}

function estimateTokens(messages: unknown): number {
	try {
		return Math.ceil(JSON.stringify(messages ?? []).length / 4);
	} catch {
		return 0;
	}
}

export default function (cmd: ModApi): void {
	cmd.addFlag('auto-compact-threshold', {
		type: 'string',
		default: String(DEFAULT_THRESHOLD),
		description: 'Context size (tokens, or a percent like 20%) that triggers auto-compaction.',
	});
	cmd.addFlag('auto-compact-off', {
		type: 'boolean',
		default: false,
		description: 'Disable threshold-based auto-compaction for this session.',
	});
	cmd.addFlag('auto-compact-debug', {
		type: 'boolean',
		default: false,
		description: 'Record every context measurement and compaction attempt in the session log.',
	});

	let compacting = false;
	let lastCompactAt = 0;
	let lastEventSaved: number | undefined;

	cmd.on('compaction_done', (event) => {
		if (event.type === 'compaction_done' && typeof event.tokensSaved === 'number') {
			lastEventSaved = event.tokensSaved;
		}
	});

	function stored(): Partial<AutoCompactSettings> | undefined {
		try {
			return cmd.store.get(STORE_KEY) as Partial<AutoCompactSettings> | undefined;
		} catch {
			return undefined;
		}
	}

	function resolve(contextWindowOverride?: number): AutoCompactSettings {
		const saved = stored() ?? {};
		const usage = cmd.getContextUsage();
		const contextWindow = contextWindowOverride ?? usage?.contextWindow ?? undefined;
		const flagThreshold = parseThreshold(
			String(cmd.getFlag('auto-compact-threshold') ?? DEFAULT_THRESHOLD),
			contextWindow,
		);
		const savedThreshold =
			typeof saved.threshold === 'number' && saved.threshold > 0 ? saved.threshold : undefined;
		const threshold = savedThreshold ?? flagThreshold ?? DEFAULT_THRESHOLD;
		const upper = contextWindow ? Math.max(MIN_THRESHOLD, contextWindow - 10_000) : threshold;
		return {
			enabled: saved.enabled ?? cmd.getFlag('auto-compact-off') !== true,
			threshold: Math.min(Math.max(threshold, MIN_THRESHOLD), upper),
		};
	}

	function record(event: AutoCompactEvent): void {
		void Promise.resolve(cmd.store.set('lastEvent', event)).catch(() => undefined);
		try {
			cmd.session?.appendCustomEntry({customType: 'auto-compact/event', data: event});
		} catch {
			return;
		}
	}

	function persist(settings: AutoCompactSettings): void {
		void Promise.resolve(cmd.store.set(STORE_KEY, settings)).catch(() => undefined);
	}

	function safeStatus(message: string | null): void {
		try {
			cmd.ui.setStatus(message);
		} catch {
			return;
		}
	}

	function safeNotify(message: string, level?: 'warning'): void {
		try {
			cmd.ui.notify(message, level);
		} catch {
			return;
		}
	}

	function lastEvent(): AutoCompactEvent | undefined {
		try {
			return cmd.store.get('lastEvent') as AutoCompactEvent | undefined;
		} catch {
			return undefined;
		}
	}

	async function compactNow(tokens: number | null, threshold: number): Promise<boolean> {
		if (compacting) return false;
		if (typeof cmd.sessions?.compact !== 'function') {
			record({
				at: new Date().toISOString(),
				action: 'failed',
				tokens,
				threshold,
				error: 'compaction is not available in this host',
			});
			return false;
		}
		compacting = true;
		lastCompactAt = Date.now();
		lastEventSaved = undefined;
		record({at: new Date().toISOString(), action: 'requested', tokens, threshold});
		const startedAt = Date.now();
		let ticker: {dispose: () => void} | undefined;
		try {
			safeStatus('auto-compact: compacting… 0s');
			ticker = cmd.clock.every(1000, () => {
				safeStatus(`auto-compact: compacting… ${Math.round((Date.now() - startedAt) / 1000)}s`);
			});
			await cmd.sessions.compact();
			let after = cmd.getContextUsage()?.tokens ?? null;
			let saved =
				tokens !== null && after !== null && tokens > after ? tokens - after : lastEventSaved;
			if (saved === undefined) {
				await new Promise<void>((resolve) => {
					let timer: {dispose: () => void} | undefined;
					const finish = (): void => {
						timer?.dispose();
						resolve();
					};
					timer = cmd.clock.after(600, finish);
				});
				after = cmd.getContextUsage()?.tokens ?? after;
				saved =
					tokens !== null && after !== null && tokens > after ? tokens - after : lastEventSaved;
			}
			const elapsed = Math.round((Date.now() - startedAt) / 1000);
			record({at: new Date().toISOString(), action: 'done', tokens, threshold, after, saved});
			const parts = [`auto-compact: done in ${elapsed}s`];
			if (saved !== undefined && saved > 0) parts.push(`saved ${formatTokens(saved)} tokens`);
			if (after !== null) parts.push(`context now ${formatTokens(after)}`);
			safeNotify(parts.join(' — '));
			return true;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			record({at: new Date().toISOString(), action: 'failed', tokens, threshold, error: message});
			safeNotify(`auto-compact: compaction failed (${message})`, 'warning');
			return false;
		} finally {
			ticker?.dispose();
			safeStatus(null);
			compacting = false;
		}
	}

	async function maybeCompact(tokens: number | null, contextWindow?: number): Promise<void> {
		if (tokens === null) return;
		const settings = resolve(contextWindow);
		if (!settings.enabled || compacting) return;
		if (tokens < settings.threshold) return;
		const last = lastEvent();
		const lastAfter =
			last?.action === 'done' && typeof last.after === 'number' ? last.after : null;
		const minGrowth = Math.max(15_000, Math.round(settings.threshold * 0.05));
		if (lastAfter !== null && tokens < lastAfter + minGrowth) return;
		if (Date.now() - lastCompactAt < COOLDOWN_MS) return;
		safeNotify(
			`auto-compact: ${formatTokens(tokens)} tokens reached the ${formatTokens(settings.threshold)} threshold - compacting`,
		);
		await compactNow(tokens, settings.threshold);
	}

	cmd.hooks({
		onRunEnd: async ({state}) => {
			const usage = cmd.getContextUsage();
			const estimated = estimateTokens(state.messages);
			const tokens = usage?.tokens ?? (estimated > 0 ? estimated : null);
			if (cmd.getFlag('auto-compact-debug') === true) {
				const settings = resolve(usage?.contextWindow ?? undefined);
				record({
					at: new Date().toISOString(),
					action: 'checked',
					tokens,
					threshold: settings.threshold,
					contextWindow: usage?.contextWindow ?? null,
					enabled: settings.enabled,
				});
			}
			await maybeCompact(tokens, usage?.contextWindow ?? undefined);
		},
	});

	cmd.addCommand({
		name: 'auto-compact',
		description: 'Show or change threshold-based auto-compaction.',
		argumentHint: '[on|off|now|150k|200k|20%]',
		handler: ({args}) => {
			const raw = String(args ?? '').trim();
			const action = raw.toLowerCase();
			const current = resolve();
			const usage = cmd.getContextUsage();

			if (!raw) {
				const measured =
					usage && usage.tokens !== null
						? `${formatTokens(usage.tokens)} of ${formatTokens(usage.contextWindow ?? 0)} tokens`
						: 'not measured yet';
				const last = lastEvent();
				const lastNote =
					last?.action === 'done' && typeof last.saved === 'number' && last.saved > 0
						? ` · last saved ${formatTokens(last.saved)}`
						: last?.action === 'failed'
							? ' · last attempt failed'
							: '';
				persist(current);
				return {
					message: `auto-compact ${current.enabled ? 'on' : 'off'} · threshold ${formatTokens(current.threshold)} · context ${measured}${lastNote}`,
				};
			}

			if (action === 'on' || action === 'off') {
				persist({...current, enabled: action === 'on'});
				return {message: `auto-compact ${action}`};
			}

			if (action === 'now') {
				void compactNow(usage?.tokens ?? null, current.threshold);
				return {message: 'auto-compact: compacting now — watch the status row below the input'};
			}

			const thresholdInput = action.startsWith('threshold') ? raw.slice('threshold'.length).trim() : raw;
			const parsed = parseThreshold(thresholdInput, usage?.contextWindow ?? undefined);
			if (parsed === undefined) {
				return {message: 'usage: /auto-compact [on|off|now|150k|200k|20%]'};
			}
			const next = Math.max(parsed, MIN_THRESHOLD);
			persist({...current, threshold: next});
			return {message: `auto-compact threshold set to ${formatTokens(next)} tokens`};
		},
	});
}
