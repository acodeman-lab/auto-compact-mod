import test from 'node:test';
import assert from 'node:assert/strict';
import {
	buildPackText,
	extractFromMessages,
	parseThreshold,
	redact,
	resetPrecisionStateForTests,
	searchFacts,
} from '../index.ts';

test('parseThreshold accepts shorthand, commas and percentages', () => {
	assert.equal(parseThreshold('800k'), 800_000);
	assert.equal(parseThreshold('150,000'), 150_000);
	assert.equal(parseThreshold('1m'), 1_000_000);
	assert.equal(parseThreshold('80%', 1_000_000), 800_000);
	assert.equal(parseThreshold('nonsense'), undefined);
});

test('redact removes obvious secrets before they reach the pack', () => {
	const output = redact('api_key=supersecret123 and sk-abcdefghijklmnop');
	assert.ok(output.includes('[REDACTED]'));
	assert.ok(!output.includes('supersecret123'));
	assert.ok(!output.includes('sk-abcdefghijklmnop'));
});

test('extraction builds a grounded pack and recall index', () => {
	resetPrecisionStateForTests();
	extractFromMessages([
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
	]);

	const pack = buildPackText();
	assert.match(pack, /Session precision pack/);
	assert.match(pack, /DynamoDB/);
	assert.match(pack, /src\/a\.ts/);
	assert.match(pack, /abc1234/);
	assert.match(pack, /TS2345/);
	assert.ok(pack.includes('[REDACTED]'));
	assert.ok(!pack.includes('supersecret123'));

	const hits = searchFacts('dynamodb', 5);
	assert.ok(hits.length > 0);
	assert.match(hits[0]!.text, /DynamoDB/);

	const pathHits = searchFacts('src/a.ts', 5);
	assert.ok(pathHits.length > 0);
	assert.match(pathHits[0]!.text, /src\/a\.ts/);
});

test('the compaction summary is not ingested as a new user fact', () => {
	resetPrecisionStateForTests();
	extractFromMessages([
		{
			role: 'user',
			content: [
				{
					type: 'text',
					text: 'This is an auto-compacted summary of the earlier conversation.\n\nGoal: old goal',
				},
			],
		},
	]);
	assert.equal(buildPackText(), '');
});
