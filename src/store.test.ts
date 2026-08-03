/**
 * The feed's behavior under history rewriting, which is where an append-only list goes wrong.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
	applyPushes,
	applyRead,
	applyDeploys,
	applyRuns,
	arrivals,
	deployStatePerRepo,
	emptyFeed,
	filterCommits,
	filterItems,
	isFresh,
	timeline,
	isUnread,
	keyOf,
	resolveCursor,
	typicalRunMs,
	unreadAbove,
	unreadCount
} from './store.ts';
import type { RawCommit } from './types.ts';

function commit(sha: string, committed: string, subject = sha): RawCommit {
	return {
		sha: sha.padEnd(40, '0'),
		short: sha,
		author: 'a-committer',
		email: 'a@b',
		authored: committed,
		committed,
		refs: '',
		parents: [],
		subject,
		body: '',
		files: 1,
		insertions: 1,
		deletions: 0
	};
}

test('the first read is history, not news', () => {
	const { feed, added } = applyRead(
		emptyFeed(),
		'gallery',
		[commit('aaa', '2026-07-29T10:00:00Z')],
		1000
	);

	assert.equal(feed.commits.length, 1);
	// Every commit that exists at launch would otherwise be announced as an arrival.
	assert.equal(added.length, 0);
	assert.equal(feed.commits[0]?.baseline, true);
	assert.equal(arrivals(feed).length, 0);
});

test('a commit appearing after the first read is an arrival', () => {
	const first = applyRead(emptyFeed(), 'gallery', [commit('aaa', '2026-07-29T10:00:00Z')], 1000);
	const second = applyRead(
		first.feed,
		'gallery',
		[commit('bbb', '2026-07-29T11:00:00Z'), commit('aaa', '2026-07-29T10:00:00Z')],
		2000
	);

	assert.equal(second.added.length, 1);
	assert.equal(second.added[0]?.short, 'bbb');
	assert.equal(second.feed.commits[0]?.short, 'bbb');
	assert.equal(second.feed.commits[0]?.firstSeen, 2000);
	assert.equal(arrivals(second.feed).length, 1);
});

test('an amended commit replaces the original rather than joining it', () => {
	const first = applyRead(emptyFeed(), 'gallery', [commit('aaa', '2026-07-29T10:00:00Z')], 1000);
	// `git commit --amend` produces a different sha, and the old one no longer exists.
	const second = applyRead(first.feed, 'gallery', [commit('zzz', '2026-07-29T10:05:00Z')], 2000);

	assert.equal(second.feed.commits.length, 1);
	assert.equal(second.feed.commits[0]?.short, 'zzz');
	assert.equal(second.added.length, 1);
});

test('a reset drops the commit from the feed', () => {
	const first = applyRead(
		emptyFeed(),
		'gallery',
		[commit('bbb', '2026-07-29T11:00:00Z'), commit('aaa', '2026-07-29T10:00:00Z')],
		1000
	);
	const second = applyRead(first.feed, 'gallery', [commit('aaa', '2026-07-29T10:00:00Z')], 2000);

	assert.deepEqual(
		second.feed.commits.map((c) => c.short),
		['aaa']
	);
});

test('one repo reading does not disturb another', () => {
	let feed = applyRead(emptyFeed(), 'gallery', [commit('aaa', '2026-07-29T10:00:00Z')], 1000).feed;
	feed = applyRead(feed, 'one-project', [commit('bbb', '2026-07-29T12:00:00Z')], 1000).feed;
	feed = applyRead(
		feed,
		'gallery',
		[commit('ccc', '2026-07-29T13:00:00Z'), commit('aaa', '2026-07-29T10:00:00Z')],
		2000
	).feed;

	assert.deepEqual(
		feed.commits.map((c) => c.short),
		['ccc', 'bbb', 'aaa']
	);
});

test('order is by committer date, so a rebase surfaces', () => {
	// Work authored last week, rebased just now: the committer date is what a live feed should sort on.
	const rebased: RawCommit = {
		...commit('old', '2026-07-29T16:00:00Z'),
		authored: '2026-07-20T09:00:00Z'
	};
	let feed = applyRead(emptyFeed(), 'a', [commit('recent', '2026-07-29T15:00:00Z')], 1000).feed;
	feed = applyRead(feed, 'b', [rebased], 2000).feed;

	assert.equal(feed.commits[0]?.short, 'old');
});

test('firstSeen survives being pushed off the end of the capped list', () => {
	// Cap of one: the second read displaces the first commit, but its bookkeeping is kept so that seeing it
	// again does not announce it as new.
	const first = applyRead(emptyFeed(), 'a', [commit('aaa', '2026-07-29T10:00:00Z')], 1000, 1);
	const second = applyRead(first.feed, 'b', [commit('bbb', '2026-07-29T11:00:00Z')], 2000, 1);
	assert.equal(second.feed.commits.length, 1);

	const third = applyRead(second.feed, 'a', [commit('aaa', '2026-07-29T10:00:00Z')], 3000, 5);
	assert.equal(third.added.length, 0, 'a commit dropped by the cap must not be announced twice');
	assert.equal(third.feed.commits.find((c) => c.short === 'aaa')?.firstSeen, 1000);
});

test('freshness applies only to arrivals, and expires', () => {
	const first = applyRead(emptyFeed(), 'a', [commit('aaa', '2026-07-29T10:00:00Z')], 1000);
	const baseline = first.feed.commits[0];
	assert.ok(baseline);
	assert.equal(isFresh(baseline, 1000), false);

	const second = applyRead(
		first.feed,
		'a',
		[commit('bbb', '2026-07-29T11:00:00Z'), commit('aaa', '2026-07-29T10:00:00Z')],
		5000
	);
	const arrival = second.feed.commits[0];
	assert.ok(arrival);
	assert.equal(isFresh(arrival, 5000), true);
	assert.equal(isFresh(arrival, 5000 + 11_000), true);
	assert.equal(isFresh(arrival, 5000 + 13_000), false);
});

test('the filter matches across fields and requires every term', () => {
	const feed = applyRead(
		emptyFeed(),
		'gallery',
		[
			commit('aaa', '2026-07-29T10:00:00Z', 'Fix overflow at 200% text'),
			commit('bbb', '2026-07-29T09:00:00Z', 'Wire the closing photograph')
		],
		1000
	).feed;

	assert.equal(filterCommits(feed.commits, 'overflow').length, 1);
	assert.equal(filterCommits(feed.commits, 'gallery').length, 2);
	assert.equal(filterCommits(feed.commits, 'gallery overflow').length, 1);
	assert.equal(filterCommits(feed.commits, 'OVERFLOW').length, 1);
	assert.equal(filterCommits(feed.commits, 'nothing here').length, 0);
	assert.equal(filterCommits(feed.commits, '').length, 2);
});

/** A deploy, as `gh run list` reports it, minus the bookkeeping the store adds. */
function run(id: number, status: string, conclusion: string | null, startedAt: string) {
	return {
		repo: 'example.dev',
		id,
		workflow: 'Deploy',
		branch: 'dev',
		sha: 'a'.repeat(40),
		short: 'aaaaaaa',
		title: 'Fix the overflow',
		event: 'push',
		status,
		conclusion,
		startedAt,
		updatedAt: startedAt,
		url: 'https://example.com/1',
		durationMs: conclusion ? 62_000 : null
	};
}

test('deploys already in the run list at launch are history, not news', () => {
	const { feed, added } = applyRuns(
		emptyFeed(),
		'example.dev',
		[run(1, 'completed', 'failure', '2026-07-30T04:08:59Z')],
		1000
	);

	assert.equal(feed.runs.length, 1);
	assert.equal(feed.runs[0]?.baseline, true);
	assert.equal(added.length, 0, 'launching must not announce last week of deploys');
});

test('a deploy that starts after launch is announced once', () => {
	const first = applyRuns(emptyFeed(), 'example.dev', [], 1000);
	const second = applyRuns(
		first.feed,
		'example.dev',
		[run(1, 'in_progress', null, '2026-07-30T04:08:59Z')],
		2000
	);

	assert.equal(second.added.length, 1);
	assert.equal(second.added[0]?.status, 'in_progress');
	assert.equal(second.feed.runs.length, 1);
});

test('a deploy going red is announced again, on the same row', () => {
	// This is the case the whole feature exists for: the row appeared a minute ago as "running", and the
	// thing you need to be told is what it turned into.
	let state = applyRuns(emptyFeed(), 'example.dev', [], 1000).feed;
	const started = applyRuns(
		state,
		'example.dev',
		[run(1, 'in_progress', null, '2026-07-30T04:08:59Z')],
		2000
	);
	state = started.feed;

	const finished = applyRuns(
		state,
		'example.dev',
		[run(1, 'completed', 'failure', '2026-07-30T04:08:59Z')],
		64_000
	);

	// One row, not two — the run has one identity across its whole life.
	assert.equal(finished.feed.runs.length, 1);
	assert.equal(finished.feed.runs[0]?.conclusion, 'failure');
	// And it is announced a second time, because the outcome is new information.
	assert.equal(finished.added.length, 1);
	assert.equal(finished.added[0]?.conclusion, 'failure');

	// firstSeen is when the run appeared; changedAt is when it turned red. The flash uses changedAt, so a
	// deploy that fails four minutes into a long build still draws the eye.
	assert.equal(finished.feed.runs[0]?.firstSeen, 2000);
	assert.equal(finished.feed.runs[0]?.changedAt, 64_000);
});

test('re-reading an unchanged deploy announces nothing', () => {
	let state = applyRuns(emptyFeed(), 'example.dev', [], 1000).feed;
	state = applyRuns(
		state,
		'example.dev',
		[run(1, 'completed', 'success', '2026-07-30T04:00:00Z')],
		2000
	).feed;

	// The poll runs every ten to a hundred and twenty seconds; a settled deploy must go quiet.
	const again = applyRuns(
		state,
		'example.dev',
		[run(1, 'completed', 'success', '2026-07-30T04:00:00Z')],
		9000
	);
	assert.equal(again.added.length, 0);
	assert.equal(again.feed.runs[0]?.changedAt, 2000);
});

test('the timeline interleaves commits, pushes and deploys by time', () => {
	const feed = emptyFeed();
	const commits = applyRead(
		feed,
		'example.dev',
		[commit('aaa', '2026-07-30T04:00:00Z', 'The commit')],
		1000
	).feed.commits;
	const pushes = applyPushes(
		feed,
		'example.dev',
		[
			{
				repo: 'example.dev',
				remote: 'origin',
				branch: 'dev',
				sha: 'a'.repeat(40),
				short: 'aaaaaaa',
				at: '2026-07-30T04:00:30Z',
				count: 1,
				forced: false
			}
		],
		1000
	).feed.pushes;
	const runs = applyRuns(
		feed,
		'example.dev',
		[run(1, 'completed', 'failure', '2026-07-30T04:01:00Z')],
		1000
	).feed.runs;

	const items = timeline(commits, pushes, runs, []);
	// Newest first: the deploy, then the push that triggered it, then the commit that was pushed — which is
	// the order the story actually happened in, read upwards.
	assert.deepEqual(
		items.map((item) => item.kind),
		['run', 'push', 'commit']
	);
});

test('the filter reaches deploys', () => {
	const runs = applyRuns(
		emptyFeed(),
		'example.dev',
		[run(1, 'completed', 'failure', '2026-07-30T04:00:00Z')],
		1000
	).feed.runs;
	const items = timeline([], [], runs, []);

	assert.equal(filterItems(items, 'deploy').length, 1);
	assert.equal(filterItems(items, 'failure').length, 1);
	assert.equal(filterItems(items, 'deploy dev').length, 1);
	assert.equal(filterItems(items, 'success').length, 0);
});

/** A Cloudflare deploy, minus the bookkeeping the store adds. */
function deploy(repo: string, at: string, hostname: string, env: string | null = null) {
	return {
		repo,
		worker: hostname.split('.')[0] ?? 'worker',
		env,
		hostname,
		id: `${repo}-${at}`,
		versionId: 'ffffffff-0000-0000-0000-000000000000',
		source: 'wrangler',
		triggeredBy: 'deployment',
		authorEmail: 'a@b',
		at
	};
}

test('the panel keeps both facts: the newest run and the newest deploy', () => {
	// app is why the deploy half is needed: no workflows at all, so a panel looking only at Actions runs
	// left it blank while the feed one line below said "app went live".
	const runs = applyRuns(
		emptyFeed(),
		'example.dev',
		[run(1, 'completed', 'failure', '2026-07-30T04:00:00Z')],
		1000
	).feed.runs;
	const deploys = applyDeploys(
		emptyFeed(),
		'app',
		[deploy('app', '2026-07-30T05:00:00Z', 'app.example.dev')],
		1000
	).feed.deploys;

	const state = deployStatePerRepo(runs, deploys);
	assert.equal(state.get('app')?.run, undefined);
	assert.equal(state.get('app')?.deploy?.hostname, 'app.example.dev');
	assert.equal(state.get('example.dev')?.run?.conclusion, 'failure');
	assert.equal(state.get('example.dev')?.deploy, undefined);
	assert.equal(state.get('notes'), undefined);
});

test('a deploy does not hide the outcome of the run that performed it', () => {
	// The regression this replaces: a workflow *is* what runs wrangler, so the Cloudflare deployment always
	// lands after the run starts. Choosing whichever was newer therefore hid every pass-or-fail, permanently.
	const runs = applyRuns(
		emptyFeed(),
		'gallery',
		[{ ...run(1, 'completed', 'failure', '2026-07-30T05:00:00Z'), repo: 'gallery' }],
		1000
	).feed.runs;
	const deploys = applyDeploys(
		emptyFeed(),
		'gallery',
		[deploy('gallery', '2026-07-30T05:00:40Z', 'gallery.example.dev')],
		1000
	).feed.deploys;

	const state = deployStatePerRepo(runs, deploys).get('gallery');
	assert.equal(state?.run?.conclusion, 'failure', 'the run outcome must survive a later deploy');
	assert.equal(state?.deploy?.hostname, 'gallery.example.dev');
});

test('the newest of each kind wins within its own column', () => {
	const runs = applyRuns(
		emptyFeed(),
		'gallery',
		[
			{ ...run(2, 'completed', 'success', '2026-07-30T06:00:00Z'), repo: 'gallery' },
			{ ...run(1, 'completed', 'failure', '2026-07-30T04:00:00Z'), repo: 'gallery' }
		],
		1000
	).feed.runs;
	const deploys = applyDeploys(
		emptyFeed(),
		'gallery',
		[
			deploy('gallery', '2026-07-30T04:10:00Z', 'gallery-dev.example.dev', 'dev'),
			deploy('gallery', '2026-07-30T06:10:00Z', 'gallery.example.dev')
		],
		1000
	).feed.deploys;

	const state = deployStatePerRepo(runs, deploys).get('gallery');
	assert.equal(state?.run?.conclusion, 'success');
	assert.equal(state?.deploy?.hostname, 'gallery.example.dev');
});

test('production and review deploys are separate rows on the timeline', () => {
	// They are separate Workers serving separate hostnames, and telling them apart is the whole point.
	const deploys = applyDeploys(
		emptyFeed(),
		'gallery',
		[
			deploy('gallery', '2026-07-30T05:00:00Z', 'gallery.example.dev'),
			deploy('gallery', '2026-07-30T04:00:00Z', 'gallery-dev.example.dev', 'dev')
		],
		1000
	).feed.deploys;

	assert.equal(deploys.length, 2);
	const items = timeline([], [], [], deploys);
	assert.equal(items.length, 2);
	assert.equal(items[0]?.kind === 'deploy' && items[0].deploy.hostname, 'gallery.example.dev');
	assert.equal(items[1]?.kind === 'deploy' && items[1].deploy.env, 'dev');

	/*
	 * And the hostname is searchable, which is the thing the row actually shows.
	 *
	 * The earlier version of this assertion filtered on `gallery-dev` and passed for the wrong reason: the
	 * fixture derives the Worker name from the hostname, so the match came from the *worker* field and the
	 * test stayed green with `hostname` set to null. These filter on a fragment that appears **only** in the
	 * hostname, so they fail if it is dropped from the haystack again.
	 */
	assert.equal(filterItems(items, 'dev.example').length, 1);
	assert.equal(filterItems(items, 'gallery.example.dev').length, 1);

	const hostless = items.map((item) =>
		item.kind === 'deploy' ? { ...item, deploy: { ...item.deploy, hostname: null } } : item
	);
	assert.equal(
		filterItems(hostless, 'dev.example').length,
		0,
		'the match must come from the hostname'
	);
});

test('the typical duration comes from successful runs only', () => {
	// gallery really does take five and a half minutes; a failure that died in 39s is not evidence about how
	// long the work takes, and letting it into the median would make every normal run look overdue.
	const runs = applyRuns(
		emptyFeed(),
		'gallery',
		[
			{
				...run(1, 'completed', 'success', '2026-07-30T09:00:00Z'),
				repo: 'gallery',
				durationMs: 324_000
			},
			{
				...run(2, 'completed', 'success', '2026-07-30T08:00:00Z'),
				repo: 'gallery',
				durationMs: 330_000
			},
			{
				...run(3, 'completed', 'failure', '2026-07-30T07:00:00Z'),
				repo: 'gallery',
				durationMs: 39_000
			},
			{
				...run(4, 'in_progress', null, '2026-07-30T09:45:00Z'),
				repo: 'gallery',
				durationMs: null
			}
		],
		1000
	).feed.runs;

	assert.equal(typicalRunMs(runs, 'gallery', 'Deploy'), 330_000);
	// A workflow with no successful history yet has nothing to compare against, and must say so rather than
	// inventing a number.
	assert.equal(typicalRunMs(runs, 'gallery', 'Other'), null);
	assert.equal(typicalRunMs(runs, 'demo', 'Deploy'), null);
});

test('a single successful run is enough to set an expectation', () => {
	const runs = applyRuns(
		emptyFeed(),
		'demo',
		[
			{
				...run(1, 'completed', 'success', '2026-07-30T09:00:00Z'),
				repo: 'demo',
				durationMs: 74_000
			}
		],
		1000
	).feed.runs;
	assert.equal(typicalRunMs(runs, 'demo', 'Deploy'), 74_000);
});

test('nothing is unread while the cursor is following the newest row', () => {
	// markAt null means "I am watching the top"; there is no such thing as missing something you are looking at.
	const feed = applyRead(emptyFeed(), 'a', [commit('aaa', '2026-07-30T10:00:00Z')], 1000).feed;
	const arrived = applyRead(
		feed,
		'a',
		[commit('bbb', '2026-07-30T10:05:00Z'), commit('aaa', '2026-07-30T10:00:00Z')],
		9000
	).feed;

	const items = timeline(arrived.commits, [], [], []);
	assert.equal(unreadCount(items, null), 0);
	assert.equal(isUnread(items[0]!, null), false);
});

test('anything arriving after the cursor was parked stays marked, however long you are gone', () => {
	const first = applyRead(emptyFeed(), 'a', [commit('aaa', '2026-07-30T10:00:00Z')], 1000);
	// The cursor is parked at 5000.
	const parked = 5000;
	const later = applyRead(
		first.feed,
		'a',
		[commit('bbb', '2026-07-30T10:05:00Z'), commit('aaa', '2026-07-30T10:00:00Z')],
		9000
	);

	const items = timeline(later.feed.commits, [], [], []);
	assert.equal(unreadCount(items, parked), 1);
	// The commit that was already there is not new, and the one that arrived is — and stays so. This is the
	// whole difference from the twelve-second flash, which would have faded long before you walked back.
	assert.equal(isUnread(items[0]!, parked), true);
	assert.equal(isUnread(items[1]!, parked), false);
});

test('baseline history is never unread, however the mark is set', () => {
	// Otherwise parking the cursor and then discovering a new repo would mark that repo's entire history.
	const feed = applyRead(
		emptyFeed(),
		'a',
		[commit('aaa', '2026-07-30T10:00:00Z'), commit('bbb', '2026-07-30T09:00:00Z')],
		9000
	).feed;
	const items = timeline(feed.commits, [], [], []);
	assert.equal(unreadCount(items, 1000), 0);
});

test('a deploy that turned red while you were away counts as unread', () => {
	// A run is judged on when its state changed, not when the row first appeared: the row was already there
	// before you left, and the thing you need to know is what it became.
	let state = applyRuns(emptyFeed(), 'example.dev', [], 1000).feed;
	state = applyRuns(
		state,
		'example.dev',
		[run(1, 'in_progress', null, '2026-07-30T10:00:00Z')],
		2000
	).feed;
	const parked = 3000;
	const finished = applyRuns(
		state,
		'example.dev',
		[run(1, 'completed', 'failure', '2026-07-30T10:00:00Z')],
		9000
	).feed;

	const items = timeline([], [], finished.runs, []);
	assert.equal(unreadCount(items, parked), 1);
});

test('unreadAbove counts only what is scrolled off the top', () => {
	// The count alone is not enough: on screen you simply read them, above it you press g.
	const feed = applyRead(
		emptyFeed(),
		'a',
		[
			commit('new1', '2026-07-30T10:03:00Z'),
			commit('new2', '2026-07-30T10:02:00Z'),
			commit('old', '2026-07-30T10:00:00Z')
		],
		9000
	);
	// Re-read with the two newest treated as arrivals.
	const withHistory = applyRead(
		emptyFeed(),
		'a',
		[commit('old', '2026-07-30T10:00:00Z')],
		1000
	).feed;
	const arrived = applyRead(
		withHistory,
		'a',
		[
			commit('new1', '2026-07-30T10:03:00Z'),
			commit('new2', '2026-07-30T10:02:00Z'),
			commit('old', '2026-07-30T10:00:00Z')
		],
		9000
	).feed;
	assert.equal(feed.feed.commits.length, 3);

	const items = timeline(arrived.commits, [], [], []);
	assert.equal(unreadCount(items, 5000), 2);
	// Window starting at row 0: both are visible, so nothing is above.
	assert.equal(unreadAbove(items, 5000, 0), 0);
	// Scrolled down by one: one of them is off the top.
	assert.equal(unreadAbove(items, 5000, 1), 1);
	assert.equal(unreadAbove(items, 5000, 2), 2);
	// And with no mark there is nothing to count.
	assert.equal(unreadAbove(items, null, 2), 0);
});

/** Builds a timeline of commits newest-first, as the feed would hold them. */
function feedOf(...shas: string[]) {
	const at = (i: number) => `2026-07-30T10:${String(30 - i).padStart(2, '0')}:00Z`;
	let state = emptyFeed();
	state = applyRead(
		state,
		'a',
		shas.map((sha, i) => commit(sha, at(i))),
		1000
	).feed;
	return timeline(state.commits, [], [], []);
}

test('a held row stays held when commits arrive above it', () => {
	const before = feedOf('mine', 'older');
	const held = { following: false, selected: keyOf(before[0]!), lastIndex: 0 };
	assert.equal(resolveCursor(before, held), 0);

	// Two commits land above it. The cursor must not move to them.
	const after = feedOf('new1', 'new2', 'mine', 'older');
	assert.equal(resolveCursor(after, held), 2);
	const at = after[resolveCursor(after, held)];
	assert.equal(at?.kind === 'commit' && at.commit.short, 'mine');
});

test('the row at the very top is held too, which is the case that was broken', () => {
	// Reported: "when I am hovering the top item and a new item comes in my cursor goes to the new item".
	// Being *on* the newest row and *following* it are different things, and only following should move.
	const before = feedOf('mine', 'older');
	const held = { following: false, selected: keyOf(before[0]!), lastIndex: 0 };

	const after = feedOf('brand-new', 'mine', 'older');
	const index = resolveCursor(after, held);
	assert.equal(index, 1, 'the cursor follows the commit, not the row number');
	const at = after[index];
	assert.equal(at?.kind === 'commit' && at.commit.short, 'mine');
});

test('following tracks the newest row on purpose', () => {
	// Left alone, the dashboard should behave like a live feed rather than sinking down the list.
	const after = feedOf('brand-new', 'mine', 'older');
	assert.equal(resolveCursor(after, { following: true, selected: 'ignored', lastIndex: 7 }), 0);
});

test('a held commit rewritten out of existence keeps the row, not the top', () => {
	// An amend or a rebase removes the sha. Jumping to the top would silently change what enter opens.
	const after = feedOf('new1', 'new2', 'older');
	const index = resolveCursor(after, { following: false, selected: 'gone', lastIndex: 2 });
	assert.equal(index, 2);
});

test('a held row is clamped when the list shrinks under it', () => {
	// Typing a filter can leave the held row past the end of the list.
	const short = feedOf('only');
	assert.equal(resolveCursor(short, { following: false, selected: 'gone', lastIndex: 9 }), 0);
	assert.equal(resolveCursor([], { following: false, selected: 'gone', lastIndex: 9 }), 0);
});
