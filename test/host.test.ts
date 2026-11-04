import test from 'node:test';
import assert from 'node:assert/strict';
import createMod, {resetPrecisionStateForTests} from '../index.ts';

function sampleMessages() {
	return [
		{
			role: 'user',
			content: [
				{
					type: 'text',
					text: 'Never edit secrets.ts. Use DynamoDB instead of ECS. api_key=supersecret123',
				},
			],
		},
		{
			role: 'assistant',
			content: [{type: 'tool_use', name: 'write_file', input: {file_path: 'src/a.ts'}}],
		},
		{
			role: 'user',
			content: [
				{
					type: 'tool_result',
					content: [{type: 'text', text: 'Error: TS2345 src/x.ts:42\n[main abc1234] fix: x'}],
				},
			],
		},
	];
}

function createHarness(seedCustom: Array<{customType: string; data: any}> = []) {
	const storeData = new Map<string, unknown>();
	const stateData = new Map<string, unknown>();
	const custom: Array<{customType: string; data: any}> = [...seedCustom];
	const flags: Record<string, unknown> = {
		'auto-compact-threshold': '800000',
		'auto-compact-off': false,
		'auto-compact-debug': false,
	};
	const usage = {tokens: 0, contextWindow: 1_000_000, percent: 0};
	const notifications: string[] = [];
	const statuses: string[] = [];
	const handlers: Record<string, Function> = {};
	const commands: Record<string, any> = {};
	const hooks: Record<string, Function> = {};
	let tool: any;
	let compactCalls = 0;
	let storeWrites = 0;

	const cmd = {
		addFlag: () => ({dispose() {}}),
		addCommand: (command: any) => {
			commands[command.name] = command;
			return {dispose() {}};
		},
		addTool: (definition: any) => {
			tool = definition;
			return {dispose() {}};
		},
		hooks: (registered: Record<string, Function>) => {
			Object.assign(hooks, registered);
			return {dispose() {}};
		},
		on: (event: string, handler: Function) => {
			handlers[event] = handler;
			return {dispose() {}};
		},
		getFlag: (name: string) => flags[name],
		getContextUsage: () => ({...usage}),
		store: {
			get: (key: string) => storeData.get(key),
			set: (key: string, value: unknown) => {
				storeWrites += 1;
				storeData.set(key, value);
			},
			delete: (key: string) => {
				storeData.delete(key);
			},
		},
		state: {
			get: (key: string) => stateData.get(key),
			set: (key: string, value: unknown) => {
				stateData.set(key, value);
			},
		},
		session: {
			appendCustomEntry: (entry: {customType: string; data: any}) => {
				custom.push(entry);
			},
			getCustomEntries: ({customType}: {customType: string}) =>
				custom.filter((entry) => entry.customType === customType),
		},
		sessions: {
			compact: async () => {
				compactCalls += 1;
			},
		},
		ui: {
			setStatus: (message: string | null) => {
				if (message) statuses.push(message);
			},
			notify: (message: string) => {
				notifications.push(message);
			},
			confirm: async () => true,
		},
		clock: {
			every: () => ({dispose() {}}),
			after: (_ms: number, callback: Function) => {
				callback();
				return {dispose() {}};
			},
		},
	};

	createMod(cmd as any);

	return {
		cmd,
		commands,
		hooks,
		getTool: () => tool,
		usage,
		notifications,
		statuses,
		custom,
		handlers,
		get compactCalls() {
			return compactCalls;
		},
		get storeWrites() {
			return storeWrites;
		},
	};
}

test('free mode never calls the paid compactor and builds a redacted pack', async () => {
	resetPrecisionStateForTests();
	const harness = createHarness();
	harness.handlers.session_start?.({type: 'session_start'});
	await harness.hooks.onTurnStart?.({state: {messages: []}});
	harness.usage.tokens = 500_000;
	await harness.hooks.onRunEnd?.({state: {messages: sampleMessages()}});

	assert.equal(harness.compactCalls, 0);
	assert.equal(harness.storeWrites, 0);

	const pack = harness.hooks.appendSystemPrompt?.({state: {messages: []}});
	assert.equal(typeof pack, 'string');
	assert.match(pack, /DynamoDB/);
	assert.match(pack, /src\/a\.ts/);
	assert.match(pack, /abc1234/);
	assert.match(pack, /TS2345/);
	assert.ok(!pack.includes('supersecret123'));
	assert.ok(pack.includes('[REDACTED]'));

	const status = await harness.commands['auto-compact'].handler({
		args: '',
		ui: harness.cmd.ui,
	});
	assert.match(status.message, /free/);
	assert.match(status.message, /no paid compaction/);
	assert.equal(harness.compactCalls, 0);

	const recall = await harness.getTool().run({input: {query: 'DynamoDB'}});
	assert.match(recall.content[0].text, /DynamoDB/);
});

test('handoff mode compacts only after it is explicitly enabled', async () => {
	resetPrecisionStateForTests();
	const harness = createHarness();
	harness.handlers.session_start?.({type: 'session_start'});
	await harness.commands['auto-compact'].handler({args: 'mode handoff', ui: harness.cmd.ui});
	await harness.commands['auto-compact'].handler({args: 'on', ui: harness.cmd.ui});

	harness.usage.tokens = 900_000;
	await harness.hooks.onRunEnd?.({state: {messages: sampleMessages()}});
	assert.equal(harness.compactCalls, 1);

	await harness.commands['auto-compact'].handler({args: 'mode free', ui: harness.cmd.ui});
	harness.usage.tokens = 950_000;
	await harness.hooks.onRunEnd?.({state: {messages: sampleMessages()}});
	assert.equal(harness.compactCalls, 1);
});

test('manual now is the explicit paid path in free mode', async () => {
	resetPrecisionStateForTests();
	const harness = createHarness();
	harness.handlers.session_start?.({type: 'session_start'});
	harness.usage.tokens = 100_000;
	await harness.commands['auto-compact'].handler({args: 'now', ui: harness.cmd.ui});
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(harness.compactCalls, 1);
});

test('precision facts survive a session restart from the custom-entry snapshot', async () => {
	resetPrecisionStateForTests();
	const at = new Date().toISOString();
	const harness = createHarness([
		{
			customType: 'auto-compact/precision',
			data: {
				version: 1,
				at,
				facts: [
					{
						key: 'constraint:resume',
						kind: 'constraint',
						at,
						text: 'Use DynamoDB instead of ECS',
						ref: 'm:resume',
						priority: 10,
					},
				],
			},
		},
	]);
	harness.handlers.session_start?.({type: 'session_start'});
	await harness.hooks.onTurnStart?.({state: {messages: []}});

	const pack = harness.hooks.appendSystemPrompt?.({state: {messages: []}});
	assert.match(pack, /DynamoDB/);

	const recall = await harness.getTool().run({input: {query: 'DynamoDB'}});
	assert.match(recall.content[0].text, /DynamoDB/);
});
