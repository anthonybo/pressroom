/**
 * Deploy parsing and the polling cadence.
 *
 * The slug cases matter because getting one wrong means either querying the wrong repository or silently never
 * querying at all, and both look identical from the outside: "deploys just do not show up".
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { githubSlug, isActive, isPermanent, parseRuns, runPollInterval } from './github.ts';

const ESC = String.fromCharCode(27);

test('githubSlug reads both URL forms git uses', () => {
	assert.equal(githubSlug('https://github.com/owner/example.dev.git'), 'owner/example.dev');
	assert.equal(githubSlug('https://github.com/acme/demo'), 'acme/demo');
	assert.equal(githubSlug('git@github.com:acme/gallery.git'), 'acme/gallery');
	assert.equal(
		githubSlug('ssh://git@github.com/owner/another-project.git'),
		'owner/another-project'
	);
	// A dot in the repo name is normal here — `example.dev` must not lose part of itself to the `.git` strip.
	assert.equal(githubSlug('git@github.com:owner/example.dev.git'), 'owner/example.dev');
});

test('githubSlug returns null for anything not GitHub', () => {
	assert.equal(githubSlug(''), null);
	assert.equal(githubSlug('/srv/git/local-remote.git'), null);
	assert.equal(githubSlug('git@gitlab.com:someone/thing.git'), null);
	assert.equal(githubSlug('https://bitbucket.org/someone/thing.git'), null);
	// Contains "github.com" but is not it.
	assert.equal(githubSlug('https://github.com.evil.example/owner/repo.git'), null);
});

test('parseRuns reads a finished run, with its duration', () => {
	// The failed deploy that prompted this feature, verbatim from `gh run list --json`.
	const json = JSON.stringify([
		{
			conclusion: 'failure',
			createdAt: '2026-07-30T04:08:59Z',
			databaseId: 30513078161,
			displayTitle: 'Install Chromium in CI so the mobile check can actually run',
			event: 'push',
			headBranch: 'dev',
			headSha: '3a3e720241fc95c247f35933c6a340cd9489044e',
			name: 'Deploy',
			startedAt: '2026-07-30T04:08:59Z',
			status: 'completed',
			updatedAt: '2026-07-30T04:10:01Z',
			url: 'https://github.com/owner/example.dev/actions/runs/30513078161'
		}
	]);

	const [run] = parseRuns(json, 'example.dev');
	assert.ok(run);
	assert.equal(run.id, 30513078161);
	assert.equal(run.workflow, 'Deploy');
	assert.equal(run.branch, 'dev');
	assert.equal(run.short, '3a3e720');
	assert.equal(run.status, 'completed');
	assert.equal(run.conclusion, 'failure');
	assert.equal(run.durationMs, 62_000);
	assert.equal(isActive(run), false);
});

test('parseRuns leaves a running job without a conclusion or a duration', () => {
	const json = JSON.stringify([
		{
			conclusion: '',
			databaseId: 1,
			displayTitle: 'Wire the closing photograph',
			event: 'push',
			headBranch: 'main',
			headSha: 'abcdef1234567890',
			name: 'Deploy',
			startedAt: '2026-07-30T04:08:59Z',
			status: 'in_progress',
			updatedAt: '2026-07-30T04:09:10Z',
			url: 'https://example.com/1'
		}
	]);

	const [run] = parseRuns(json, 'repo');
	assert.ok(run);
	// An empty conclusion means "not finished", which has to stay distinct from a finished run whose outcome
	// is unknown — otherwise a deploy in flight would be drawn as one that ended in nothing.
	assert.equal(run.conclusion, null);
	assert.equal(run.durationMs, null);
	assert.equal(isActive(run), true);
});

test('parseRuns survives anything that is not the JSON it expected', () => {
	// This is network input parsed inside a render loop; none of these may throw.
	assert.deepEqual(parseRuns('', 'repo'), []);
	assert.deepEqual(parseRuns('not json', 'repo'), []);
	assert.deepEqual(parseRuns('{}', 'repo'), []);
	assert.deepEqual(parseRuns('[null, 3, "x"]', 'repo'), []);
	// A row with no id cannot be tracked across polls, so it is dropped rather than duplicated forever.
	assert.deepEqual(parseRuns('[{"name":"Deploy"}]', 'repo'), []);
});

test('parseRuns strips escape sequences out of a workflow name and title', () => {
	const json = JSON.stringify([
		{
			databaseId: 1,
			name: `${ESC}[31mDeploy`,
			displayTitle: `${ESC}[2Jcleared`,
			headSha: 'a',
			status: 'completed',
			conclusion: 'success',
			startedAt: '2026-07-30T04:00:00Z',
			updatedAt: '2026-07-30T04:00:10Z'
		}
	]);
	const [run] = parseRuns(json, 'repo');
	assert.equal(run?.workflow, 'Deploy');
	assert.equal(run?.title, 'cleared');
});

test('the poll interval tightens around a run in flight', () => {
	const now = Date.parse('2026-07-30T04:10:00Z');

	// Watching a deploy finish is the case worth spending requests on.
	assert.equal(runPollInterval(now, { hasActiveRun: true }), 10_000);
	// Just committed, so one is probably about to start.
	assert.equal(runPollInterval(now, { hasActiveRun: false, lastActivityMs: now - 60_000 }), 20_000);
	// A quiet repo: a deploy nobody triggered is not going to appear.
	assert.equal(
		runPollInterval(now, { hasActiveRun: false, lastActivityMs: now - 3600_000 }),
		120_000
	);
	assert.equal(runPollInterval(now, { hasActiveRun: false }), 120_000);
});

test('a missing or logged-out gh is permanent; a network blip is not', () => {
	assert.equal(isPermanent('spawn gh ENOENT'), true);
	assert.equal(isPermanent('gh: command not found'), true);
	assert.equal(isPermanent('To get started with GitHub CLI, please run: gh auth login'), true);
	assert.equal(isPermanent('HTTP 401: Bad credentials'), true);

	// These are a closed lid or a flaky connection, and they do fix themselves.
	assert.equal(isPermanent('error connecting to api.github.com'), false);
	assert.equal(isPermanent('dial tcp: lookup api.github.com: no such host'), false);
	assert.equal(isPermanent('timed out'), false);
});
