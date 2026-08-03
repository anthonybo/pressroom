/**
 * The question the whole program rests on: **when a commit is made, does it show up, and how fast?**
 *
 * This makes real commits in real repositories and waits for the engine to report them. Nothing is mocked,
 * because what is being tested is precisely the part that cannot be: whether a filesystem watch registered
 * on a git directory actually fires when git writes a ref through a lockfile and a rename.
 *
 * The latency bound is deliberately tighter than the poll interval. A commit found in under two seconds was
 * found by the watcher; if the watcher were broken, the three-second poll would still find it and a looser
 * assertion would pass while the feature it is meant to cover was dead.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createLabeler, discover } from './discover.ts';
import { Engine } from './engine.ts';
import type { Commit, Deploy, Push, Run } from './types.ts';

const AUTHOR = [
	'-c',
	'user.name=Pressroom Test',
	'-c',
	'user.email=test@example.com',
	'-c',
	'commit.gpgsign=false'
];

function git(cwd: string, args: string[], env?: Record<string, string>) {
	return execFileSync('git', args, {
		cwd,
		encoding: 'utf8',
		env: env ? { ...process.env, ...env } : process.env
	});
}

function makeRepo(path: string) {
	mkdirSync(path, { recursive: true });
	git(path, ['init', '-q', '-b', 'main']);
	return path;
}

/**
 * `date` is worth passing whenever a test asserts an order. Commit timestamps have one-second resolution, so
 * two commits made back to back carry the same committer date and their relative order in the feed is
 * decided by a tiebreak rather than by which was made first — a test that assumes otherwise passes or fails
 * depending on where a second boundary happened to fall.
 */
function commitFile(repo: string, name: string, contents: string, message: string, date?: string) {
	writeFileSync(join(repo, name), contents);
	git(repo, ['add', name]);
	git(
		repo,
		[...AUTHOR, 'commit', '-q', '-m', message],
		date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : undefined
	);
}

async function waitFor(predicate: () => boolean, timeoutMs: number, what: string) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
}

test('a commit made while running is reported, and fast enough to have come from the watcher', async (t) => {
	const root = mkdtempSync(join(tmpdir(), 'pressroom-engine-'));
	t.after(() => rmSync(root, { recursive: true, force: true }));

	// Nested, so this also covers the arrangement that matters: a repo inside a grouping folder.
	const repo = makeRepo(join(root, 'group', 'watched'));
	commitFile(repo, 'a.txt', 'one\n', 'Existing history');

	const engine = new Engine(discover(root), { limit: 20 });
	t.after(() => engine.stop());

	// Arrivals carry commits and pushes on one channel; this repo has no remote, so only commits appear.
	const arrived: { commits: (Commit | Push | Run | Deploy)[]; at: number }[] = [];
	engine.onArrivals((commits) => arrived.push({ commits, at: Date.now() }));

	let snapshot = engine.snapshot();
	engine.subscribe((next) => {
		snapshot = next;
	});
	engine.start();

	await waitFor(() => snapshot.loaded === 1, 10_000, 'the first read to finish');

	// The commit that already existed is history and must not be announced.
	assert.equal(snapshot.feed.length, 1);
	assert.equal(arrived.length, 0, 'existing commits must not be reported as arrivals');

	const madeAt = Date.now();
	commitFile(repo, 'b.txt', 'two\n', 'A commit made while watching');

	await waitFor(() => arrived.length > 0, 8_000, 'the new commit to be reported');

	const latency = (arrived[0]?.at ?? 0) - madeAt;
	assert.equal(arrived[0]?.commits.length, 1);
	const reported = arrived[0]?.commits[0];
	assert.ok(reported && 'subject' in reported, 'the arrival should be a commit, not a push');
	assert.equal(reported.subject, 'A commit made while watching');
	assert.equal(reported.baseline, false);
	assert.ok(
		latency < 2000,
		`expected the watcher to report inside 2000ms, took ${latency}ms — if this is near 3000ms the fs.watch path is dead and the poll is covering for it`
	);

	// And the feed itself is in the right order, newest first.
	await waitFor(() => snapshot.feed.length === 2, 4_000, 'the feed to hold both commits');
	assert.equal(snapshot.feed[0]?.subject, 'A commit made while watching');
	assert.equal(snapshot.feed[0]?.baseline, false);
	assert.equal(snapshot.feed[1]?.baseline, true);
});

test('commits from several repos interleave by date, and status is read for each', async (t) => {
	const root = mkdtempSync(join(tmpdir(), 'pressroom-multi-'));
	t.after(() => rmSync(root, { recursive: true, force: true }));

	const one = makeRepo(join(root, 'one'));
	const two = makeRepo(join(root, 'nested', 'two'));
	// An hour apart, so "newest first across repos" is a real assertion rather than a coin toss.
	commitFile(one, 'a.txt', 'a\n', 'From one', '2026-07-29T10:00:00-07:00');
	commitFile(two, 'b.txt', 'b\n', 'From two', '2026-07-29T11:00:00-07:00');
	// An uncommitted change, which the repo panel reports.
	writeFileSync(join(two, 'dirty.txt'), 'pending\n');

	const engine = new Engine(discover(root), { limit: 20 });
	t.after(() => engine.stop());

	let snapshot = engine.snapshot();
	engine.subscribe((next) => {
		snapshot = next;
	});
	engine.start();

	await waitFor(() => snapshot.loaded === 2, 10_000, 'both repos to be read');

	assert.equal(snapshot.feed.length, 2);
	assert.deepEqual(new Set(snapshot.feed.map((c) => c.repo)), new Set(['one', 'two']));
	// Newest first across repos.
	assert.equal(snapshot.feed[0]?.subject, 'From two');

	const status = snapshot.statuses.get('two');
	assert.equal(status?.branch, 'main');
	assert.equal(status?.untracked, 1);
	// No remote configured, so there is nothing to be ahead of.
	assert.equal(status?.upstream, null);
	assert.equal(snapshot.errors.size, 0);
});

test('an amended commit replaces the original in the live feed', async (t) => {
	const root = mkdtempSync(join(tmpdir(), 'pressroom-amend-'));
	t.after(() => rmSync(root, { recursive: true, force: true }));

	const repo = makeRepo(join(root, 'repo'));
	commitFile(repo, 'a.txt', 'one\n', 'Original message');

	const engine = new Engine(discover(root), { limit: 20 });
	t.after(() => engine.stop());

	let snapshot = engine.snapshot();
	engine.subscribe((next) => {
		snapshot = next;
	});
	engine.start();
	await waitFor(() => snapshot.loaded === 1, 10_000, 'the first read');

	const before = snapshot.feed[0]?.sha;
	git(repo, [...AUTHOR, 'commit', '-q', '--amend', '-m', 'Amended message']);

	await waitFor(() => snapshot.feed[0]?.subject === 'Amended message', 8_000, 'the amend to land');

	// The original sha is gone, not sitting above or below the new one.
	assert.equal(snapshot.feed.length, 1);
	assert.notEqual(snapshot.feed[0]?.sha, before);
});

test('a repo with no commits yet is not an error', async (t) => {
	const root = mkdtempSync(join(tmpdir(), 'pressroom-empty-'));
	t.after(() => rmSync(root, { recursive: true, force: true }));

	makeRepo(join(root, 'brand-new'));

	const engine = new Engine(discover(root), { limit: 20 });
	t.after(() => engine.stop());

	let snapshot = engine.snapshot();
	engine.subscribe((next) => {
		snapshot = next;
	});
	engine.start();

	await waitFor(() => snapshot.loaded === 1, 10_000, 'the read to finish');
	assert.equal(snapshot.feed.length, 0);
	assert.equal(snapshot.errors.size, 0);
	assert.equal(snapshot.statuses.get('brand-new')?.unborn, true);
});

test('a push is reported, with the branch that was pushed', async (t) => {
	const root = mkdtempSync(join(tmpdir(), 'pressroom-push-'));
	t.after(() => rmSync(root, { recursive: true, force: true }));

	// A bare repo on disk is a real remote as far as git is concerned, so this exercises the whole path —
	// `git push` writing an `update by push` entry into the remote-tracking reflog — with no network.
	const remote = join(root, 'remote.git');
	mkdirSync(remote, { recursive: true });
	git(remote, ['init', '-q', '--bare', '-b', 'main']);

	const repo = makeRepo(join(root, 'work'));
	git(repo, ['remote', 'add', 'origin', remote]);
	commitFile(repo, 'a.txt', 'one\n', 'Before any push');
	git(repo, ['push', '-q', '-u', 'origin', 'main']);

	const engine = new Engine(discover(root), { limit: 20 });
	t.after(() => engine.stop());

	const arrived: (Commit | Push | Run | Deploy)[] = [];
	engine.onArrivals((items) => arrived.push(...items));

	let snapshot = engine.snapshot();
	engine.subscribe((next) => {
		snapshot = next;
	});
	engine.start();

	// The bare remote is discovered too; wait for the working repo specifically.
	await waitFor(() => snapshot.loaded >= 1 && snapshot.pushes.length > 0, 10_000, 'the first read');

	// The push made before launch is history, read out of the reflog — present, but not announced.
	assert.equal(snapshot.pushes.length, 1);
	assert.equal(snapshot.pushes[0]?.branch, 'main');
	assert.equal(snapshot.pushes[0]?.remote, 'origin');
	assert.equal(snapshot.pushes[0]?.baseline, true);
	assert.equal(arrived.length, 0, 'a push already in the reflog must not be announced as new');

	// Now push while watching.
	commitFile(repo, 'b.txt', 'two\n', 'To be pushed');
	commitFile(repo, 'c.txt', 'three\n', 'Also to be pushed');
	git(repo, ['push', '-q', 'origin', 'main']);

	await waitFor(
		() => snapshot.pushes.some((push) => !push.baseline),
		8_000,
		'the push to be reported'
	);

	const live = snapshot.pushes.find((push) => !push.baseline);
	assert.equal(live?.branch, 'main');
	assert.equal(live?.remote, 'origin');
	assert.equal(live?.forced, false);
	// It is announced on the same channel as commits, so the bell and the counter cover both.
	assert.ok(
		arrived.some((item) => 'branch' in item && item.branch === 'main'),
		'the push should arrive as an announcement'
	);

	// And the commit count is filled in afterwards, without blocking the row from appearing.
	await waitFor(
		() => snapshot.pushes.find((push) => !push.baseline)?.count === 2,
		8_000,
		'the pushed-commit count to be counted'
	);
});

test('a fetch is not reported as a push', async (t) => {
	const root = mkdtempSync(join(tmpdir(), 'pressroom-fetch-'));
	t.after(() => rmSync(root, { recursive: true, force: true }));

	const remote = join(root, 'remote.git');
	mkdirSync(remote, { recursive: true });
	git(remote, ['init', '-q', '--bare', '-b', 'main']);

	// One clone pushes; a second clone fetches. Both write to their own remote-tracking reflog, and only the
	// first did anything a dashboard should call a push.
	const author = makeRepo(join(root, 'author'));
	git(author, ['remote', 'add', 'origin', remote]);
	commitFile(author, 'a.txt', 'one\n', 'Shared work');
	git(author, ['push', '-q', '-u', 'origin', 'main']);

	git(root, ['clone', '-q', remote, join(root, 'reader')]);
	const reader = join(root, 'reader');

	commitFile(author, 'b.txt', 'two\n', 'More shared work');
	git(author, ['push', '-q', 'origin', 'main']);
	// The reader pulls someone else's commit down. Its reflog gains an entry saying `fetch`.
	git(reader, ['fetch', '-q', 'origin']);

	const engine = new Engine(
		[...discover(root)].filter((r) => r.label === 'reader'),
		{ limit: 20 }
	);
	t.after(() => engine.stop());

	let snapshot = engine.snapshot();
	engine.subscribe((next) => {
		snapshot = next;
	});
	engine.start();
	await waitFor(() => snapshot.loaded === 1, 10_000, 'the read to finish');

	assert.equal(
		snapshot.pushes.length,
		0,
		'a fetch shares the remote-tracking reflog with pushes and must not be counted as one'
	);
});

test('a repo created while running is picked up without a restart', async (t) => {
	const root = mkdtempSync(join(tmpdir(), 'pressroom-newrepo-'));
	t.after(() => rmSync(root, { recursive: true, force: true }));

	const existing = makeRepo(join(root, 'existing'));
	commitFile(existing, 'a.txt', 'a\n', 'History from launch');

	// The scan is injected, so this is the real discovery path on a real directory.
	const engine = new Engine(discover(root), {
		limit: 20,
		rediscover: () => discover(root),
		rediscoverMs: 500
	});
	t.after(() => engine.stop());

	const arrived: (Commit | Push | Run | Deploy)[] = [];
	engine.onArrivals((items) => arrived.push(...items));
	const changes: { added: string[]; removed: string[] }[] = [];
	engine.onRepos(({ added, removed }) =>
		changes.push({ added: added.map((r) => r.label), removed: removed.map((r) => r.label) })
	);

	let snapshot = engine.snapshot();
	engine.subscribe((next) => {
		snapshot = next;
	});
	engine.start();
	await waitFor(() => snapshot.loaded === 1, 10_000, 'the first read');
	assert.equal(snapshot.repos.length, 1);

	// Spinning up a new client is exactly this: a directory that was not there a moment ago.
	const fresh = makeRepo(join(root, 'new-client'));
	commitFile(fresh, 'b.txt', 'b\n', 'The new client had prior history');
	commitFile(fresh, 'c.txt', 'c\n', 'And more of it');

	await waitFor(() => snapshot.repos.length === 2, 10_000, 'the new repo to be discovered');
	await waitFor(() => snapshot.feed.length === 3, 10_000, 'its commits to be read');

	assert.deepEqual(
		new Set(snapshot.repos.map((repo) => repo.label)),
		new Set(['existing', 'new-client'])
	);
	assert.ok(
		changes.some((change) => change.added.includes('new-client')),
		'the UI is told, so it can say so rather than silently growing a row'
	);

	// The crucial part: a repo that already had history must arrive as history. Announcing it would mean
	// creating a client repo floods the feed with every commit that was ever made in it.
	assert.equal(arrived.length, 0, 'a newly discovered repo brings history, not news');
	for (const commit of snapshot.feed) assert.equal(commit.baseline, true);
});

test('a repo deleted while running stops being watched, and its rows go', async (t) => {
	const root = mkdtempSync(join(tmpdir(), 'pressroom-gone-'));
	t.after(() => rmSync(root, { recursive: true, force: true }));

	commitFile(makeRepo(join(root, 'keep')), 'a.txt', 'a\n', 'Kept');
	const doomed = makeRepo(join(root, 'doomed'));
	commitFile(doomed, 'b.txt', 'b\n', 'About to be deleted');

	const engine = new Engine(discover(root), {
		limit: 20,
		rediscover: () => discover(root),
		rediscoverMs: 500
	});
	t.after(() => engine.stop());

	let snapshot = engine.snapshot();
	engine.subscribe((next) => {
		snapshot = next;
	});
	engine.start();
	await waitFor(() => snapshot.feed.length === 2, 10_000, 'both repos to be read');

	rmSync(doomed, { recursive: true, force: true });

	await waitFor(() => snapshot.repos.length === 1, 10_000, 'the deleted repo to be dropped');
	assert.equal(snapshot.repos[0]?.label, 'keep');
	// Leaving its commits on screen would assert the existence of something that is gone.
	assert.equal(snapshot.feed.length, 1);
	assert.equal(snapshot.feed[0]?.repo, 'keep');
	assert.equal(snapshot.statuses.has('doomed'), false);
});

test('discovering a colliding repo does not rename the one already being watched', async (t) => {
	const root = mkdtempSync(join(tmpdir(), 'pressroom-collide-'));
	t.after(() => rmSync(root, { recursive: true, force: true }));

	const first = makeRepo(join(root, 'one', 'demo'));
	commitFile(first, 'a.txt', 'a\n', 'The incumbent');

	const relabel = createLabeler(root);
	const engine = new Engine(relabel(discover(root)), {
		limit: 20,
		rediscover: () => relabel(discover(root)),
		rediscoverMs: 500
	});
	t.after(() => engine.stop());

	const arrived: (Commit | Push | Run | Deploy)[] = [];
	engine.onArrivals((items) => arrived.push(...items));

	let snapshot = engine.snapshot();
	engine.subscribe((next) => {
		snapshot = next;
	});
	engine.start();
	await waitFor(() => snapshot.loaded === 1, 10_000, 'the first read');
	assert.equal(snapshot.repos[0]?.label, 'demo');

	// A second `demo`. Relabelling the set from scratch would rename the incumbent, change every key belonging
	// to it, and re-announce its entire history as if it had just happened.
	const second = makeRepo(join(root, 'two', 'demo'));
	commitFile(second, 'b.txt', 'b\n', 'The newcomer');

	await waitFor(() => snapshot.repos.length === 2, 10_000, 'the second demo to be discovered');
	await waitFor(() => snapshot.feed.length === 2, 10_000, 'both to be read');

	const labels = snapshot.repos.map((repo) => repo.label).sort();
	assert.deepEqual(labels, ['demo', 'two/demo']);
	assert.equal(arrived.length, 0, 'nothing may be re-announced because a name was taken');
});
