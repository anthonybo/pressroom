/**
 * The feed, and the bookkeeping that makes it honest.
 *
 * The obvious way to build a live commit list is to append: read the log, add anything whose sha you have
 * not seen, done. It is wrong, and it is wrong in a way that only shows up during the ordinary work of
 * this account. `git commit --amend` replaces a commit with a different sha; an interactive rebase replaces
 * twenty; `git reset --hard HEAD~1` removes one entirely. Append-only leaves all of the originals sitting
 * in the feed forever — commits that no longer exist in the repository, indistinguishable from ones that do.
 *
 * So each read *replaces* everything known about that repo. What git currently reports is the truth, and a
 * sha that has stopped being reported has stopped existing.
 *
 * That leaves one thing to preserve across reads, which is when pressroom first saw a commit. It cannot be
 * derived from the commit — an amended commit is new to the feed but carries an old author date, and a
 * rebased branch can be full of commits dated last week that arrived a second ago. `seen` holds it, and it
 * is deliberately kept outside the displayed list so that a commit pushed off the end by the cap and later
 * read again is not announced a second time as new.
 */
import type { Commit, Deploy, FeedItem, Push, RawCommit, Run } from './types.ts';

export type Feed = {
	/** Newest first, across all repos, capped. */
	commits: Commit[];
	/** Pushes, newest first, on exactly the same terms. */
	pushes: Push[];
	/** Workflow runs — one row per run, updated in place as it progresses. */
	runs: Run[];
	/** Cloudflare deploys — a Worker version going live, whether or not a workflow was involved. */
	deploys: Deploy[];
	/** `repo\0sha` → the bookkeeping that must outlive the displayed list. */
	seen: Map<string, { firstSeen: number; baseline: boolean }>;
	/** Repos whose first read has completed. Until then, everything found is history, not news. */
	loaded: Set<string>;
	/**
	 * Repos whose first *GitHub* read has completed, tracked separately from `loaded`.
	 *
	 * It has to be separate. The deploy poll is its own loop, so by the time the first run list arrives the
	 * git read has usually already marked the repo loaded — and reusing that flag would make every workflow
	 * run in the last week arrive as breaking news the moment pressroom started.
	 */
	runsLoaded: Set<string>;
	/** Repos whose first Cloudflare read has completed — separate again, and for the same reason. */
	deploysLoaded: Set<string>;
};

/** How long a commit is drawn as new. Long enough to catch your eye, short enough to settle. */
export const FRESH_MS = 12_000;

/** Beyond this the oldest commits are dropped from the display. `seen` still remembers them. */
export const DEFAULT_CAP = 600;

/**
 * `seen` grows by one entry per distinct commit observed and never shrinks on its own. At roughly fifty
 * bytes an entry this would take a very long time to matter, but a program meant to be left running for
 * weeks should have no unbounded structure in it at all.
 */
const SEEN_CAP = 20_000;

export function emptyFeed(): Feed {
	return {
		commits: [],
		pushes: [],
		runs: [],
		deploys: [],
		seen: new Map(),
		loaded: new Set(),
		runsLoaded: new Set(),
		deploysLoaded: new Set()
	};
}

/**
 * Where it went, when, and what landed — all three are needed.
 *
 * Reflog timestamps have one-second resolution, so two pushes of the same branch inside a single second
 * share an `at`, and a key built from that alone treats the second one as already seen: the push happens,
 * and nothing is ever reported. That is not hypothetical — it is what the push test caught the first time it
 * ran. The sha separates them, and keeping `at` alongside it means a force-push back to an earlier commit is
 * still its own event rather than a collision with the older entry for that sha.
 */
const pushKey = (push: Push) =>
	`push\u0000${push.repo}\u0000${push.remote}/${push.branch}\u0000${push.at}\u0000${push.sha}`;

const key = (repo: string, sha: string) => `${repo}\u0000${sha}`;

/** A Cloudflare deployment's identity. The deployment id is already unique per Worker. */
const deployKey = (deploy: { repo: string; id: string }) =>
	`deploy\u0000${deploy.repo}\u0000${deploy.id}`;

/** A run's row identity — stable while it moves from queued to finished. */
const runKey = (run: { repo: string; id: number }) => `run\u0000${run.repo}\u0000${run.id}`;

/**
 * A run's *state* identity, which is what decides whether something is worth announcing.
 *
 * A deploy is announced on each state it is *first seen in*, so once per transition rather than once per run.
 * In practice that is twice — in progress, then concluded — and up to three times when a run is caught while
 * still `queued`, since GitHub reports queued, in_progress and completed as separate states.
 *
 * The concluding one is what matters: a deploy going red is the thing you want to be told about, and it
 * happens a minute after the row first appeared, by which time the row has stopped being new.
 */
const runStateKey = (run: {
	repo: string;
	id: number;
	status: string;
	conclusion: string | null;
}) => `${runKey(run)}\u0000${run.status}\u0000${run.conclusion ?? ''}`;

/**
 * Feed order is by **committer** date, not author date.
 *
 * They differ exactly when history is rewritten, and then the committer date is the one that answers the
 * question the feed is asking. A rebase of work written on Monday produces commits whose author dates are
 * Monday and whose committer dates are now; sorting on author date would file that rebase into the middle
 * of last week, where nobody watching a live dashboard would ever see it.
 */
function order(a: Commit, b: Commit): number {
	const byDate = Date.parse(b.committed) - Date.parse(a.committed);
	if (byDate) return byDate;
	// Same second, which happens constantly during a rebase. First-seen, then two stable string keys, so
	// the list never reshuffles between renders.
	if (b.firstSeen !== a.firstSeen) return b.firstSeen - a.firstSeen;
	return a.repo.localeCompare(b.repo) || a.sha.localeCompare(b.sha);
}

/**
 * Folds one repo's log into the feed. Returns the new feed and the commits that are genuinely new — the
 * ones worth flashing, counting, and ringing a bell for.
 */
export function applyRead(
	feed: Feed,
	repo: string,
	raw: RawCommit[],
	now: number,
	cap = DEFAULT_CAP
): { feed: Feed; added: Commit[] } {
	const isFirstRead = !feed.loaded.has(repo);
	const seen = new Map(feed.seen);
	const added: Commit[] = [];

	const mine: Commit[] = raw.map((commit) => {
		const k = key(repo, commit.sha);
		const before = seen.get(k);
		const record = before ?? { firstSeen: now, baseline: isFirstRead };
		if (!before) {
			seen.set(k, record);
			if (!record.baseline) added.push({ ...commit, repo, ...record });
		}
		return { ...commit, repo, ...record };
	});

	// Everything from other repos, untouched; this repo's rows rebuilt from what git just said.
	const commits = feed.commits.filter((c) => c.repo !== repo).concat(mine);
	commits.sort(order);

	const loaded = new Set(feed.loaded);
	loaded.add(repo);

	const next: Feed = { ...feed, commits: commits.slice(0, cap), seen, loaded };
	return { feed: { ...next, seen: trim(seen, liveKeys(next)) }, added };
}

/**
 * The same fold for pushes. Kept as its own function rather than folded into `applyRead` because the two
 * arrive from different git invocations and either can fail on its own — a repo with no remote has commits
 * and no pushes, and that is not a degraded state to paper over.
 */
export function applyPushes(
	feed: Feed,
	repo: string,
	raw: Omit<Push, 'firstSeen' | 'baseline'>[],
	now: number,
	cap = DEFAULT_CAP
): { feed: Feed; added: Push[] } {
	// Deliberately keyed off the commit read, so the very first read of a repo treats its reflog history as
	// history. Otherwise launching pressroom would announce every push made in the last month.
	const isFirstRead = !feed.loaded.has(repo);
	const seen = new Map(feed.seen);
	const added: Push[] = [];

	const mine: Push[] = raw.map((push) => {
		const k = pushKey(push as Push);
		const before = seen.get(k);
		const record = before ?? { firstSeen: now, baseline: isFirstRead };
		if (!before) {
			seen.set(k, record);
			if (!record.baseline) added.push({ ...push, ...record });
		}
		return { ...push, ...record };
	});

	const pushes = feed.pushes.filter((p) => p.repo !== repo).concat(mine);
	pushes.sort(
		(a, b) =>
			Date.parse(b.at) - Date.parse(a.at) ||
			// Same second: newest-seen first, then two stable keys so the list never reshuffles.
			b.firstSeen - a.firstSeen ||
			a.repo.localeCompare(b.repo) ||
			a.sha.localeCompare(b.sha)
	);

	const next: Feed = { ...feed, pushes: pushes.slice(0, cap), seen };
	return { feed: { ...next, seen: trim(seen, liveKeys(next)) }, added };
}

/**
 * Folds one repo's workflow runs in.
 *
 * The difference from commits and pushes is that a run is not immutable: the same run is read again and again
 * as it moves from queued to in progress to a conclusion. So the row keeps one identity while its state is
 * replaced, and what gets announced is keyed on the state — see `runStateKey`.
 */
export function applyRuns(
	feed: Feed,
	repo: string,
	raw: Omit<Run, 'firstSeen' | 'changedAt' | 'baseline'>[],
	now: number,
	cap = DEFAULT_CAP
): { feed: Feed; added: Run[] } {
	const isFirstRead = !feed.runsLoaded.has(repo);
	const seen = new Map(feed.seen);
	const added: Run[] = [];

	const mine: Run[] = raw.map((run) => {
		// When the run was first seen at all, which survives its status changing.
		const identity = runKey(run);
		const firstRecord = seen.get(identity) ?? { firstSeen: now, baseline: isFirstRead };
		if (!seen.has(identity)) seen.set(identity, firstRecord);

		// And when it was first seen *in this state*, which is what freshness and announcements use.
		const stateId = runStateKey(run);
		const stateRecord = seen.get(stateId) ?? { firstSeen: now, baseline: isFirstRead };
		if (!seen.has(stateId)) {
			seen.set(stateId, stateRecord);
			if (!stateRecord.baseline) {
				added.push({
					...run,
					firstSeen: firstRecord.firstSeen,
					changedAt: stateRecord.firstSeen,
					baseline: false
				});
			}
		}

		return {
			...run,
			firstSeen: firstRecord.firstSeen,
			changedAt: stateRecord.firstSeen,
			baseline: stateRecord.baseline
		};
	});

	const runs = feed.runs.filter((r) => r.repo !== repo).concat(mine);
	runs.sort(
		(a, b) =>
			Date.parse(b.startedAt) - Date.parse(a.startedAt) ||
			a.repo.localeCompare(b.repo) ||
			b.id - a.id
	);

	const runsLoaded = new Set(feed.runsLoaded);
	runsLoaded.add(repo);

	const next: Feed = { ...feed, runs: runs.slice(0, cap), seen, runsLoaded };
	return { feed: { ...next, seen: trim(seen, liveKeys(next)) }, added };
}

/**
 * Folds one repo's Cloudflare deployments in.
 *
 * A deployment is immutable once it exists — unlike a workflow run, it has no status to move through — so this
 * is the same shape as `applyPushes`: replace what is known for the repo, keep first-seen for everything that
 * was already there, announce only what is genuinely new.
 */
export function applyDeploys(
	feed: Feed,
	repo: string,
	raw: Omit<Deploy, 'firstSeen' | 'baseline'>[],
	now: number,
	cap = DEFAULT_CAP
): { feed: Feed; added: Deploy[] } {
	const isFirstRead = !feed.deploysLoaded.has(repo);
	const seen = new Map(feed.seen);
	const added: Deploy[] = [];

	const mine: Deploy[] = raw.map((deploy) => {
		const k = deployKey(deploy);
		const before = seen.get(k);
		const record = before ?? { firstSeen: now, baseline: isFirstRead };
		if (!before) {
			seen.set(k, record);
			if (!record.baseline) added.push({ ...deploy, ...record });
		}
		return { ...deploy, ...record };
	});

	const deploys = feed.deploys.filter((d) => d.repo !== repo).concat(mine);
	deploys.sort(
		(a, b) =>
			Date.parse(b.at) - Date.parse(a.at) ||
			a.repo.localeCompare(b.repo) ||
			a.id.localeCompare(b.id)
	);

	const deploysLoaded = new Set(feed.deploysLoaded);
	deploysLoaded.add(repo);

	const next: Feed = { ...feed, deploys: deploys.slice(0, cap), seen, deploysLoaded };
	return { feed: { ...next, seen: trim(seen, liveKeys(next)) }, added };
}

/**
 * Commits, pushes, workflow runs and Cloudflare deploys interleaved into one timeline, newest first.
 *
 * Merged at display time rather than stored merged, so the two reads stay independent and the commit
 * reconciliation — which has to handle rewritten history — is not entangled with reflog parsing.
 */
export function timeline(
	commits: Commit[],
	pushes: Push[],
	runs: Run[],
	deploys: Deploy[],
	cap = DEFAULT_CAP
): FeedItem[] {
	const items: FeedItem[] = [
		...commits.map((commit): FeedItem => ({ kind: 'commit', commit })),
		...pushes.map((push): FeedItem => ({ kind: 'push', push })),
		...runs.map((run): FeedItem => ({ kind: 'run', run })),
		...deploys.map((deploy): FeedItem => ({ kind: 'deploy', deploy }))
	];
	items.sort((a, b) => timeOf(b) - timeOf(a) || keyOf(a).localeCompare(keyOf(b)));
	return items.slice(0, cap);
}

/**
 * Where an item sits on the timeline.
 *
 * A run is placed by when it **started**, not when it last changed. Ordering by `updatedAt` would make an
 * in-progress deploy climb to the top on every poll and drag the rows under it around while you were reading
 * them; placed by start time it stays next to the push that triggered it, which is where it makes sense, and
 * its status changes in place.
 */
export function timeOf(item: FeedItem): number {
	if (item.kind === 'commit') return Date.parse(item.commit.committed);
	if (item.kind === 'push') return Date.parse(item.push.at);
	if (item.kind === 'deploy') return Date.parse(item.deploy.at);
	return Date.parse(item.run.startedAt);
}

/** Stable identity for an item, used to hold the cursor on a moving list. */
export function keyOf(item: FeedItem): string {
	if (item.kind === 'commit') return key(item.commit.repo, item.commit.sha);
	if (item.kind === 'push') return pushKey(item.push);
	if (item.kind === 'deploy') return deployKey(item.deploy);
	return runKey(item.run);
}

export function repoOf(item: FeedItem): string {
	if (item.kind === 'commit') return item.commit.repo;
	if (item.kind === 'push') return item.push.repo;
	if (item.kind === 'deploy') return item.deploy.repo;
	return item.run.repo;
}

export function isItemFresh(item: FeedItem, now: number): boolean {
	// A run is fresh from when its *state* last changed, so a deploy turning red flashes even though the run
	// itself started several minutes ago.
	if (item.kind === 'run') {
		return !item.run.baseline && now - item.run.changedAt < FRESH_MS;
	}
	const { baseline, firstSeen } =
		item.kind === 'commit' ? item.commit : item.kind === 'deploy' ? item.deploy : item.push;
	return !baseline && now - firstSeen < FRESH_MS;
}

/**
 * Every `seen` key the feed currently references — what {@link trim} must not evict.
 *
 * Built from the four lists rather than tracked incrementally, because it has to be exactly right: a key
 * missed here is a row that gets re-announced as new the next time its repo is read.
 */
function liveKeys(feed: Feed): Set<string> {
	const live = new Set<string>();
	for (const commit of feed.commits) live.add(key(commit.repo, commit.sha));
	for (const push of feed.pushes) live.add(pushKey(push));
	for (const run of feed.runs) {
		live.add(runKey(run));
		live.add(runStateKey(run));
	}
	for (const deploy of feed.deploys) live.add(deployKey(deploy));
	return live;
}

/**
 * Bounds the bookkeeping map, without evicting anything still on screen.
 *
 * Evicting by age alone is what makes this dangerous, and it took a review to notice: the oldest `firstSeen`
 * values belong to the commits loaded at *startup*, so an age-ordered eviction removes exactly the baseline
 * records. The next ordinary read of an untouched repo then finds no entry, `loaded` still holds the repo so
 * it is not a first read, and forty unchanged commits are rebuilt as arrivals — bell, counter, unread marks
 * and all, for a repo where nothing happened.
 *
 * So `live` — every key the feed currently references — is never evicted, and only unreferenced entries are
 * dropped, oldest first. Those are records for things no longer reported by git, which is precisely the set it
 * is safe to forget.
 */
function trim(seen: Map<string, { firstSeen: number; baseline: boolean }>, live: Set<string>) {
	if (seen.size <= SEEN_CAP) return seen;

	const evictable = [...seen.entries()]
		.filter(([key]) => !live.has(key))
		.sort((a, b) => a[1].firstSeen - b[1].firstSeen);

	const target = Math.max(0, seen.size - Math.floor(SEEN_CAP / 2));
	const kept = new Map(seen);
	for (const [key] of evictable.slice(0, target)) kept.delete(key);
	return kept;
}

/**
 * Removes a repo entirely — used when a repo disappears from disk between scans.
 *
 * Every kind of key has to be considered, not just the commit ones. A commit key is `<repo>\0<sha>`, but a
 * push, run or deploy key is *prefixed* with its kind — `push\0<repo>\0…` — so matching on a leading repo
 * name found the commits and quietly left everything else behind.
 */
export function forget(feed: Feed, repo: string): Feed {
	const seen = new Map(feed.seen);
	for (const key of seen.keys()) {
		const [first, second] = key.split('\u0000');
		const kinded = first === 'push' || first === 'run' || first === 'deploy';
		if (first === repo || (kinded && second === repo)) seen.delete(key);
	}
	const loaded = new Set(feed.loaded);
	loaded.delete(repo);
	const runsLoaded = new Set(feed.runsLoaded);
	runsLoaded.delete(repo);
	const deploysLoaded = new Set(feed.deploysLoaded);
	deploysLoaded.delete(repo);
	return {
		commits: feed.commits.filter((c) => c.repo !== repo),
		pushes: feed.pushes.filter((p) => p.repo !== repo),
		runs: feed.runs.filter((r) => r.repo !== repo),
		deploys: feed.deploys.filter((d) => d.repo !== repo),
		seen,
		loaded,
		runsLoaded,
		deploysLoaded
	};
}

/** True while a commit should still be drawn as having just arrived. */
export function isFresh(commit: Commit, now: number): boolean {
	return !commit.baseline && now - commit.firstSeen < FRESH_MS;
}

/** Commits that arrived since the program started, newest first. */
export function arrivals(feed: Feed): Commit[] {
	return feed.commits.filter((c) => !c.baseline);
}

/**
 * The filter behind `/`. Matches repo, subject, author and sha, case-insensitively, on every
 * space-separated term — so `gallery over` finds the overflow commit in one repo without a query syntax.
 */
export function filterItems(items: FeedItem[], query: string): FeedItem[] {
	const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
	if (!terms.length) return items;
	return items.filter((item) => {
		const haystack =
			item.kind === 'commit'
				? `${item.commit.repo} ${item.commit.subject} ${item.commit.author} ${item.commit.sha} ${item.commit.body}`
				: item.kind === 'push'
					? // "push" and the branch are both searchable, so `/push` shows only pushes and `/push main`
						// narrows to one branch.
						`${item.push.repo} push pushed ${item.push.branch} ${item.push.remote} ${item.push.sha}`
					: item.kind === 'run'
						? // Likewise `/deploy`, `/failed`, or `/deploy dev`.
							`${item.run.repo} deploy run ${item.run.workflow} ${item.run.branch} ${item.run.status} ${item.run.conclusion ?? 'running'} ${item.run.sha} ${item.run.title}`
						: // `/cloudflare`, `/live`, `/rollback`, a Worker name — and the **hostname**, which is what
							// the row actually shows. Leaving it out meant typing the thing on screen,
							// `staging.example.dev`, matched nothing at all.
							`${item.deploy.repo} deploy deployed live cloudflare ${item.deploy.hostname ?? ''} ${item.deploy.worker} ${item.deploy.source} ${item.deploy.triggeredBy}`;
		return terms.every((term) => haystack.toLowerCase().includes(term));
	});
}

export function filterCommits(commits: Commit[], query: string): Commit[] {
	const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
	if (!terms.length) return commits;
	return commits.filter((commit) => {
		const haystack =
			`${commit.repo} ${commit.subject} ${commit.author} ${commit.sha} ${commit.body}`.toLowerCase();
		return terms.every((term) => haystack.includes(term));
	});
}

/**
 * The newest workflow run and the newest Cloudflare deploy per repo — **both**, not whichever is newer.
 *
 * Picking the newer one was the obvious design and it was wrong, structurally rather than occasionally. A
 * workflow *is* what runs wrangler, so an Actions deploy always produces a Cloudflare deployment a moment
 * after the run starts. Comparing the two therefore hands the panel to the deploy every single time, and the
 * pass-or-fail outcome — the one thing you want from a glance — is permanently hidden. Two different facts were
 * competing for one column: whether the pipeline passed, and whether the site is live. They get one each.
 */
export type DeployState = { run?: Run; deploy?: Deploy };

export function deployStatePerRepo(runs: Run[], deploys: Deploy[]): Map<string, DeployState> {
	const state = new Map<string, DeployState>();
	const at = (iso: string) => Date.parse(iso) || 0;

	for (const run of runs) {
		const held = state.get(run.repo) ?? {};
		if (!held.run || at(run.startedAt) > at(held.run.startedAt)) held.run = run;
		state.set(run.repo, held);
	}
	for (const deploy of deploys) {
		const held = state.get(deploy.repo) ?? {};
		if (!held.deploy || at(deploy.at) > at(held.deploy.at)) held.deploy = deploy;
		state.set(deploy.repo, held);
	}
	return state;
}

/**
 * How long this workflow usually takes, from the runs already loaded.
 *
 * Exists because "running" on its own cannot be read. A `gallery` deploy takes five and a half minutes —
 * it drives headless-browser checks across four site designs — while `demo` and `starter` finish in about one, so
 * the same three-minute-old "running" row is unremarkable for one repo and overdue for another. Without a
 * number beside it there is no way to tell, and the only way to find out is to go and look at GitHub, which is
 * the thing this dashboard exists to save you.
 *
 * Only **successful** runs count. A deploy that died in thirty-nine seconds is not evidence about how long the
 * work takes, and letting failures into the median would make every normal run look overdue.
 */
export function typicalRunMs(runs: Run[], repo: string, workflow: string): number | null {
	const durations = runs
		.filter(
			(run) =>
				run.repo === repo &&
				run.workflow === workflow &&
				run.conclusion === 'success' &&
				run.durationMs !== null
		)
		.map((run) => run.durationMs as number)
		.sort((a, b) => a - b);

	if (!durations.length) return null;
	// Median rather than mean: one queue-bound outlier should not move the expectation.
	return durations[Math.floor(durations.length / 2)] ?? null;
}

/**
 * When an item arrived, and whether it was already there at startup.
 *
 * A run reports its **state** change rather than its first sighting: a deploy that turned red while you were
 * away is news, even though the run itself appeared before you left.
 */
function arrival(item: FeedItem): { baseline: boolean; at: number } {
	if (item.kind === 'run') return { baseline: item.run.baseline, at: item.run.changedAt };
	if (item.kind === 'push') return { baseline: item.push.baseline, at: item.push.firstSeen };
	if (item.kind === 'deploy') return { baseline: item.deploy.baseline, at: item.deploy.firstSeen };
	return { baseline: item.commit.baseline, at: item.commit.firstSeen };
}

/**
 * Whether an item arrived after the cursor was parked.
 *
 * This is the difference between a flash and a mark. `isItemFresh` fades after twelve seconds, which is right
 * while you are sitting there watching and useless if you walk away — come back after five minutes and nothing
 * on screen distinguishes what landed while you were gone. `markAt` is set the moment the cursor leaves the
 * newest row, and everything that arrives after it stays marked until you go back to the top.
 */
export function isUnread(item: FeedItem, markAt: number | null): boolean {
	if (markAt === null) return false;
	const { baseline, at } = arrival(item);
	return !baseline && at > markAt;
}

export function unreadCount(items: FeedItem[], markAt: number | null): number {
	if (markAt === null) return 0;
	let count = 0;
	for (const item of items) if (isUnread(item, markAt)) count++;
	return count;
}

/**
 * How many unread items are scrolled off the top.
 *
 * The count on its own is not enough: what you need to know on returning is whether the new rows are on screen
 * or above it, because those are two different actions — read them, or press `g`.
 */
export function unreadAbove(items: FeedItem[], markAt: number | null, from: number): number {
	if (markAt === null) return 0;
	let count = 0;
	for (let i = 0; i < Math.min(from, items.length); i++) {
		const item = items[i];
		if (item && isUnread(item, markAt)) count++;
	}
	return count;
}

/**
 * Where the cursor is, given what the user last did.
 *
 * Pulled out as a pure function because it is the single most confusing thing in the program when it is
 * wrong, and it was wrong: "no commit explicitly selected" was being treated as "follow the newest", so
 * sitting on the top row without having pressed a key meant every arrival took the cursor with it. The user
 * sees a highlighted row and an arriving commit steal it.
 *
 * `following` is now a state of its own rather than something inferred from the cursor being at row zero.
 * Being *on* the newest row and *following* it are different things, and only one of them should move.
 */
export function resolveCursor(
	items: FeedItem[],
	held: { following: boolean; selected: string | null; lastIndex: number }
): number {
	if (!items.length) return 0;
	// Following means the newest row, whatever is now newest.
	if (held.following) return 0;

	if (held.selected) {
		const found = items.findIndex((item) => keyOf(item) === held.selected);
		// Held and still present: stay exactly there, however many rows arrived above it.
		if (found >= 0) return found;
	}
	// Held, but rewritten out of existence by a rebase or dropped by a filter. Keep the row rather than
	// jumping to the top, which would silently change what pressing enter opens.
	return Math.max(0, Math.min(held.lastIndex, items.length - 1));
}
