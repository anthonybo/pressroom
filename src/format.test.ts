/**
 * Sanitizing and measuring.
 *
 * `sanitize` is a security boundary as much as a formatting one: a commit subject is arbitrary text from
 * whoever wrote the commit, and it is about to be printed to a terminal that interprets escape sequences.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { age, fit, pad, padStart, sanitize, truncate, width } from './format.ts';

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

test('sanitize removes color and cursor sequences entirely', () => {
	assert.equal(sanitize(`${ESC}[31mred${ESC}[0m`), 'red');
	assert.equal(sanitize(`${ESC}[2Jcleared`), 'cleared');
	assert.equal(sanitize(`before${ESC}[1;32mafter`), 'beforeafter');
});

test('sanitize removes an OSC sequence including its payload', () => {
	// Setting the terminal title from a commit message is not something a dashboard should permit.
	assert.equal(sanitize(`${ESC}]0;new title${BEL}text`), 'text');
	assert.equal(sanitize(`${ESC}]8;;http://example.com${ESC}\\link`), 'link');
});

test('sanitize drops carriage returns, which would overwrite the row', () => {
	assert.equal(sanitize('one\rtwo'), 'onetwo');
	assert.equal(sanitize('a\u0000b'), 'ab');
	assert.equal(sanitize('a\u0007b'), 'ab');
});

test('sanitize keeps newlines, because bodies and diffs are multi-line', () => {
	assert.equal(sanitize('one\ntwo'), 'one\ntwo');
});

test('sanitize turns tabs into a known number of columns', () => {
	// A tab left in place makes every width calculation on the row wrong.
	assert.equal(sanitize('a\tb'), 'a    b');
	assert.equal(width(sanitize('\tindented')), 12);
});

test('sanitize leaves ordinary text, including non-ASCII, alone', () => {
	assert.equal(
		sanitize('Fix 239px of overflow at 200% text — measured'),
		'Fix 239px of overflow at 200% text — measured'
	);
	assert.equal(sanitize('café ✓ 🤖'), 'café ✓ 🤖');
});

test('truncate measures display width, not character count', () => {
	assert.equal(truncate('abcdef', 10), 'abcdef');
	assert.equal(truncate('abcdef', 6), 'abcdef');
	assert.equal(truncate('abcdef', 5), 'abcd…');
	assert.equal(width(truncate('abcdef', 5)), 5);

	// An emoji is two columns wide; truncating by length would overflow the column by one.
	const emoji = '🤖 Generated with Claude Code';
	assert.ok(width(truncate(emoji, 10)) <= 10);
	assert.ok(width(truncate(emoji, 11)) <= 11);
});

test('truncate never splits a wide character in half', () => {
	for (let max = 1; max <= 12; max++) {
		const out = truncate('🤖🤖🤖🤖🤖🤖', max);
		assert.ok(width(out) <= max, `width ${width(out)} exceeded ${max}`);
	}
});

test('fit produces exactly the requested width, whatever it is given', () => {
	for (const text of ['', 'short', 'a much longer string than the column', '🤖🤖🤖', 'café']) {
		for (const size of [0, 1, 4, 8, 20]) {
			assert.equal(width(fit(text, size)), size, `fit(${JSON.stringify(text)}, ${size})`);
		}
	}
});

test('pad and padStart do not truncate', () => {
	assert.equal(pad('ab', 5), 'ab   ');
	assert.equal(padStart('ab', 5), '   ab');
	assert.equal(pad('abcdef', 3), 'abcdef');
});

test('age is short, and never more than four columns for anything under a year', () => {
	const now = Date.parse('2026-07-29T16:00:00Z');
	const ago = (ms: number) => new Date(now - ms).toISOString();

	assert.equal(age(now, ago(2_000)), 'now');
	assert.equal(age(now, ago(45_000)), '45s');
	assert.equal(age(now, ago(12 * 60_000)), '12m');
	assert.equal(age(now, ago(5 * 3600_000)), '5h');
	assert.equal(age(now, ago(3 * 86400_000)), '3d');
	assert.equal(age(now, ago(20 * 86400_000)), '2w');
	assert.equal(age(now, ago(120 * 86400_000)), '4mo');
	assert.equal(age(now, ago(800 * 86400_000)), '2y');

	for (const ms of [0, 1000, 60_000, 3600_000, 86400_000, 30 * 86400_000]) {
		assert.ok(width(age(now, ago(ms))) <= 4);
	}
});

test('a clock skew that puts a commit in the future reads as now, not as a negative age', () => {
	const now = Date.parse('2026-07-29T16:00:00Z');
	assert.equal(age(now, new Date(now + 60_000).toISOString()), 'now');
});

test('an unparseable date does not produce NaN on screen', () => {
	assert.equal(age(Date.now(), 'not a date'), '?');
});
