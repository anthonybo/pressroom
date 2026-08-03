/**
 * How a workflow run reads while it is still going.
 *
 * This exists because of a question that should not have needed asking: a `gallery` deploy sat at "running"
 * for three minutes and there was no way to tell from the screen whether that was normal. It was — that
 * workflow drives headless-browser checks across four site designs and takes five and a half minutes, where
 * `demo` and `starter` finish in about one. The row now carries the comparison, and these are the cases it has
 * to get right, including the one where "twice as long as usual" is not yet interesting.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runLook, subjectOfRun } from './components/Feed.tsx';
import { UI } from './theme.ts';
import type { Run } from './types.ts';

const NOW = Date.parse('2026-07-30T09:48:00Z');

function running(startedAt: string, status = 'in_progress'): Run {
	return {
		repo: 'gallery',
		id: 1,
		workflow: 'Deploy',
		branch: 'main',
		sha: '6adcbb1'.padEnd(40, '0'),
		short: '6adcbb1',
		title: 'Correct the comment',
		event: 'push',
		status,
		conclusion: null,
		startedAt,
		updatedAt: startedAt,
		url: 'https://example.com/1',
		durationMs: null,
		firstSeen: 0,
		changedAt: 0,
		baseline: false
	};
}

test('a running job shows how long it has been going', () => {
	const look = runLook(running('2026-07-30T09:45:00Z'), { now: NOW });
	assert.equal(look.glyph, '◔');
	assert.equal(look.outcome, 'running 3m');
});

test('a running job compares itself to how long the workflow usually takes', () => {
	// The real numbers: three minutes into a workflow whose successful runs take five and a half.
	const look = runLook(running('2026-07-30T09:45:00Z'), { now: NOW, typicalMs: 330_000 });
	assert.equal(look.outcome, 'running 3m  ·  usually 5m 30s');
	// Not overdue, so it must not be dressed as a problem.
	assert.notEqual(look.color, UI.error);
});

test('a job well past its usual duration says so, and is colored as a problem', () => {
	const look = runLook(running('2026-07-30T09:33:00Z'), { now: NOW, typicalMs: 74_000 });
	assert.equal(look.outcome, 'running 15m  ·  over the usual 1m 14s');
	assert.equal(look.color, UI.error);
	// Still a clock and not a cross: it is late, not failed, and the two must not look the same.
	assert.equal(look.glyph, '◔');
});

test('twice a very short duration is not yet worth flagging', () => {
	// Double fifteen seconds is thirty, which is noise. Overdue needs a full extra minute on top of double.
	const soon = runLook(running('2026-07-30T09:47:20Z'), { now: NOW, typicalMs: 15_000 });
	assert.equal(soon.outcome, 'running 40s  ·  usually 15s');
	assert.notEqual(soon.color, UI.error);

	const genuinely = runLook(running('2026-07-30T09:45:30Z'), { now: NOW, typicalMs: 15_000 });
	assert.equal(genuinely.color, UI.error);
});

test('a queued job says queued, not running', () => {
	const look = runLook(running('2026-07-30T09:47:00Z', 'queued'), { now: NOW });
	assert.equal(look.outcome, 'queued 1m');
});

test('with no history to compare against, it reports only the elapsed time', () => {
	const look = runLook(running('2026-07-30T09:45:00Z'), { now: NOW, typicalMs: null });
	assert.equal(look.outcome, 'running 3m');
});

test('a finished run is unaffected by the clock', () => {
	const done: Run = {
		...running('2026-07-30T09:40:00Z'),
		status: 'completed',
		conclusion: 'success',
		durationMs: 336_000
	};
	const look = runLook(done, { now: NOW, typicalMs: 330_000 });
	assert.equal(look.glyph, '✔');
	assert.equal(look.outcome, 'ok in 5m 36s');
});

test('a failure reads as a failure whatever the expectation was', () => {
	const failed: Run = {
		...running('2026-07-30T09:40:00Z'),
		status: 'completed',
		conclusion: 'failure',
		durationMs: 62_000
	};
	const look = runLook(failed, { now: NOW, typicalMs: 330_000 });
	assert.equal(look.glyph, '✖');
	assert.equal(look.outcome, 'failed in 1m 2s');
	assert.equal(look.color, UI.error);
});

/** A workflow run, as `gh run list` reports one. */
function ran(over: Partial<Run>): Run {
	return {
		...running('2026-07-30T09:40:00Z'),
		status: 'completed',
		conclusion: 'success',
		durationMs: 74_000,
		...over
	};
}

test('a dispatched run shows what it was dispatched for, when the workflow says', () => {
	// The provisioning case. GitHub exposes no `workflow_dispatch` inputs on a run at all, so the only way the
	// slug can reach a dashboard is the workflow's own `run-name:` — which arrives here as the title.
	const provisioned = ran({
		workflow: 'Provision a client site',
		title: 'Provision a-new-client — design-two',
		event: 'workflow_dispatch',
		branch: 'main',
		durationMs: 124_000
	});
	assert.match(subjectOfRun(provisioned), /Provision a-new-client — design-two/);
});

test('a dispatched run with no run-name falls back to the workflow name', () => {
	// Which is today's state: the title and the workflow name are the same string, so there is nothing to add.
	const plain = ran({
		workflow: 'Provision a client site',
		title: 'Provision a client site',
		event: 'workflow_dispatch'
	});
	assert.match(subjectOfRun(plain), /^Provision a client site main/);
});

test('a push-triggered run keeps the workflow and branch, not the commit subject', () => {
	// The commit subject is already on the row directly below. Showing it here would duplicate a line and lose
	// `Deploy dev`, which is the part that says where it went.
	const pushed = ran({
		workflow: 'Deploy',
		title: 'Let body text break in every template',
		event: 'push',
		branch: 'dev'
	});
	const subject = subjectOfRun(pushed);
	assert.match(subject, /^Deploy dev/);
	assert.doesNotMatch(subject, /body text/);
});

test('a dispatched deploy still says which branch it went to', () => {
	// Deploys became dispatch-only, and dev versus main is two different hostnames.
	const dispatched = ran({
		workflow: 'Deploy',
		title: 'Deploy',
		event: 'workflow_dispatch',
		branch: 'dev'
	});
	assert.match(subjectOfRun(dispatched), /^Deploy dev/);
});
