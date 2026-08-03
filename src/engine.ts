/**
 * The part that watches, reads and reconciles — with no React in it at all.
 *
 * This is deliberate. The alternative is a pile of `useEffect`s owning twenty-eight watchers, a poll timer
 * and a concurrency limit, which is both hard to reason about and impossible to test without rendering a
 * terminal. Here it is a plain object that emits snapshots, so the question that actually matters — *does a
 * commit made right now show up, and how long does it take* — is answered by a test that makes a real commit
 * in a temporary repository and waits for it, with nothing drawn on screen.
 *
 * Everything the UI needs is in the snapshot. Detail data — a commit's file list, a file's diff — is fetched
 * on demand and cached, because loading it for three hundred feed rows nobody has opened would mean six
 * hundred `git show` calls at startup.
 */
import {
	countBetween,
	readCommits,
	readDiff,
	readFiles,
	readPushes,
	readRemoteUrl,
	readStatus
} from './git.ts';
import {
	githubSlug,
	hasWorkflows,
	isActive,
	isPermanent,
	readRuns,
	runPollInterval
} from './github.ts';
import {
	deployPollInterval,
	isMissingWorker,
	isPermanent as isPermanentCloudflare,
	readDeployments,
	workersFor,
	type WorkerTarget
} from './cloudflare.ts';
import {
	applyDeploys,
	applyPushes,
	applyRead,
	applyRuns,
	emptyFeed,
	forget,
	type Feed
} from './store.ts';
import { join } from 'node:path';
import { pollInterval, watchDir, watchRepo, type WatchHandle } from './watch.ts';
import type { Commit, Deploy, FileChange, Push, Repo, RepoStatus, Run, Scope } from './types.ts';

export type Snapshot = {
	repos: Repo[];
	feed: Commit[];
	/** Pushes, newest first, merged with the commits into one timeline by the UI. */
	pushes: Push[];
	/** Deploys — GitHub Actions runs, one entry per run, updated in place as it progresses. */
	runs: Run[];
	/** Cloudflare deploys — Worker versions going live, newest first. */
	deploys: Deploy[];
	/** Why workflow runs are unavailable, when they are. Null while everything is fine. */
	githubError: string | null;
	/** Why Cloudflare deploys are unavailable, when they are. */
	cloudflareError: string | null;
	statuses: Map<string, RepoStatus>;
	/** Commit-date of each repo's newest commit, used to rank the panel and tier the poll. */
	lastCommitMs: Map<string, number>;
	errors: Map<string, string>;
	/** Repos whose first read has finished — the startup progress indicator. */
	loaded: number;
	scope: Scope;
	paused: boolean;
	startedAt: number;
	/** Total commits seen arriving since startup. */
	arrived: number;
	/** True when started with `--local`: no network pollers, so no runs or deploys will ever appear. */
	local: boolean;
};

export type EngineOptions = {
	/** Commits read per repo. Forty is far more than a feed shows and keeps one call per repo. */
	limit?: number;
	scope?: Scope;
	/** Parallel git invocations. Above about eight the process spawns cost more than they save. */
	concurrency?: number;
	/**
	 * Re-scans the disk for repositories. Without it the set is whatever existed at launch, and a client repo
	 * created ten minutes later stays invisible until the program is restarted — which on this account happens
	 * constantly, since spinning up a new client *is* creating a new repo.
	 *
	 * Injected rather than done here so the engine needs to know nothing about roots, depth or labels, and so a
	 * test can hand it a list instead of a filesystem.
	 */
	rediscover?: () => Repo[];
	/** Measured at 12ms for thirty repos, so this can be brisk without being noticeable. */
	rediscoverMs?: number;
	/**
	 * Commits and pushes only: no `gh`, no `wrangler`, nothing that leaves the machine.
	 *
	 * Exists because several of these run at once, in different terminals, and the local half costs almost
	 * nothing while the network half is what multiplies. Each instance runs its own wrangler — a fresh node
	 * process, about 1.7 seconds, up to two at a time — and every instance shares the one GitHub token, so the
	 * rate limit is a single budget however many are open. A secondary session that only wants to see commits
	 * land can skip both and cost nothing but its own git reads.
	 */
	local?: boolean;
};

/** Why a read was asked for. */
export type RefreshReason = 'poll' | 'change' | 'manual';

/**
 * Whether a request that arrives while a read is already running deserves another read after it.
 *
 * A **poll** does not. The read in flight is already fetching current state, so the poll is redundant —
 * and queueing it is precisely how a repo whose read takes longer than its poll interval ends up reading in
 * a continuous loop: due again the instant it finishes, forever, spawning git processes as fast as the
 * machine allows.
 *
 * A **change** does. The filesystem is reporting that the repository moved *after* this read started, so the
 * result being computed is already stale. Same for a **manual** refresh, which is someone asking directly.
 */
export function queuesFollowUp(reason: RefreshReason): boolean {
	return reason !== 'poll';
}

/** Coalesces a burst of completed reads into one render. */
const EMIT_MS = 40;

/** The pause before re-reading a repo that changed while it was being read. */
const FOLLOW_UP_MS = 150;

/**
 * Reflog entries read per repo. Enough that opening pressroom shows recent pushes for context, and no more:
 * at 25 across twenty-nine repos the reflog history outnumbered the commits and pushed real commits off the
 * end of the capped timeline, which is the opposite of useful.
 */
const PUSH_LIMIT = 10;

/** Workflow runs read per repo. A handful of recent deploys is the context that is actually useful. */
const RUN_LIMIT = 8;

/**
 * Cloudflare calls are serialized to this many at once. Each one starts a wrangler, which is a fresh node
 * process of its own; seven at once would briefly cost more memory than the dashboard itself.
 */
const CLOUDFLARE_CONCURRENCY = 2;

export class Engine {
	private repos: Repo[];
	private feed: Feed = emptyFeed();
	private statuses = new Map<string, RepoStatus>();
	private lastCommitMs = new Map<string, number>();
	private errors = new Map<string, string>();
	private watchers = new Map<string, WatchHandle>();

	/** Repos with a read in flight, and repos that asked for another while one was running. */
	private inFlight = new Set<string>();
	private again = new Set<string>();
	private nextPollAt = new Map<string, number>();

	private listeners = new Set<(snapshot: Snapshot) => void>();
	private arrivalListeners = new Set<(items: (Commit | Push | Run | Deploy)[]) => void>();
	private emitTimer: NodeJS.Timeout | null = null;
	private ticker: NodeJS.Timeout | null = null;

	/** `owner/repo` per repo, or null for "not on GitHub" — resolved once, then cached. */
	private slugs = new Map<string, string | null>();
	private ghNextAt = new Map<string, number>();
	private ghInFlight = new Set<string>();
	private githubError: string | null = null;
	/** Set when the failure is one that will not fix itself, so the loop stops asking. */
	private githubDisabled = false;

	/** Worker targets and wrangler path per repo, or null for "not a Worker" — resolved once. */
	private workers = new Map<string, { targets: WorkerTarget[]; wrangler: string } | null>();
	/**
	 * Workers named in a config that Cloudflare has never heard of — a review environment nobody has pushed
	 * to yet. Remembered so the same missing Worker is not asked about every three minutes forever.
	 */
	private missingWorkers = new Set<string>();
	private cfNextAt = new Map<string, number>();
	private cfInFlight = new Set<string>();
	private cfActive = 0;
	private cloudflareError: string | null = null;
	private cloudflareDisabled = false;
	/** Watches on each Worker repo's `.wrangler`, armed lazily — the directory appears the first time
	 * wrangler is run there, which for a CI-deployed repo may be never. */
	private wranglerWatchers = new Map<string, WatchHandle>();

	private filesCache = new Map<string, FileChange[]>();
	private diffCache = new Map<string, string[]>();

	private rescanTimer: NodeJS.Timeout | null = null;
	private repoListeners = new Set<(change: { added: Repo[]; removed: Repo[] }) => void>();

	private running = false;
	private active = 0;
	private queue: (() => void)[] = [];

	readonly startedAt = Date.now();
	private arrived = 0;
	private scope: Scope;
	private paused = false;
	private readonly limit: number;
	private readonly concurrency: number;
	private readonly rediscover: (() => Repo[]) | undefined;
	private readonly rediscoverMs: number;
	private readonly local: boolean;

	constructor(repos: Repo[], options: EngineOptions = {}) {
		this.repos = repos;
		this.limit = options.limit ?? 40;
		this.scope = options.scope ?? 'branches';
		this.concurrency = options.concurrency ?? 6;
		this.rediscover = options.rediscover;
		this.rediscoverMs = options.rediscoverMs ?? 30_000;
		this.local = options.local ?? false;
	}

	// -------------------------------------------------------------------------------------------------
	// Lifecycle
	// -------------------------------------------------------------------------------------------------

	start(): void {
		if (this.running) return;
		this.running = true;

		for (const [index, repo] of this.repos.entries()) this.adopt(repo, index);

		// One timer for all repos, checking who is due. Cheaper and easier to stop than a timer each.
		this.ticker = setInterval(() => this.tick(), 1_000);
		this.ticker.unref?.();

		if (this.rediscover) {
			this.rescanTimer = setInterval(() => this.rescan(), this.rediscoverMs);
			this.rescanTimer.unref?.();
		}

		for (const repo of this.repos) this.refresh(repo, 'manual');
	}

	/** Begins watching one repo: a filesystem watch, and a place in each of the three poll schedules. */
	private adopt(repo: Repo, stagger: number): void {
		this.watchers.set(
			repo.label,
			watchRepo(repo, () => {
				if (!this.paused) this.refresh(repo, 'change');
			})
		);
		// Staggered so thirty repos do not all poll on the same tick forever.
		this.nextPollAt.set(repo.label, Date.now() + stagger * 200);
		// Deploys are checked shortly after the git reads, so the first frame is commits rather than a screen
		// waiting on the network.
		this.ghNextAt.set(repo.label, Date.now() + 1_500 + stagger * 250);
		// Cloudflare last, and spread widest: each call starts a wrangler.
		this.cfNextAt.set(repo.label, Date.now() + 3_000 + stagger * 400);
	}

	/**
	 * Whether this exact repo is still in the watched set.
	 *
	 * By **path**, because that is the identity — a label can be reassigned to a different path when a repo is
	 * moved, and an in-flight read of the old one must not be mistaken for the new.
	 */
	private watching(repo: Repo): boolean {
		return this.repos.some((held) => held.path === repo.path);
	}

	/** Stops watching one repo and forgets everything known about it. */
	private release(repo: Repo): void {
		this.watchers.get(repo.label)?.close();
		this.watchers.delete(repo.label);
		this.wranglerWatchers.get(repo.label)?.close();
		this.wranglerWatchers.delete(repo.label);
		for (const map of [this.nextPollAt, this.ghNextAt, this.cfNextAt]) map.delete(repo.label);
		this.slugs.delete(repo.label);
		this.workers.delete(repo.label);
		this.statuses.delete(repo.label);
		this.lastCommitMs.delete(repo.label);
		this.errors.delete(repo.label);
		this.inFlight.delete(repo.label);
		this.again.delete(repo.label);
		// Its rows go too. A repo that has been deleted has no commits, and leaving them on screen would be
		// asserting the existence of something that is gone.
		this.feed = forget(this.feed, repo.label);
	}

	/**
	 * Replaces the watched set, keyed by path.
	 *
	 * Paths rather than labels, because a label is a display name and a path is the identity. Repos that were
	 * already here are left completely untouched — no re-read, no re-announcement — so a scan that finds one new
	 * repo costs exactly one repo's worth of work.
	 */
	setRepos(next: Repo[]): void {
		const before = new Map(this.repos.map((repo) => [repo.path, repo]));
		const after = new Map(next.map((repo) => [repo.path, repo]));

		const removed = [...before.values()].filter((repo) => !after.has(repo.path));
		const added = [...after.values()].filter((repo) => !before.has(repo.path));
		if (!removed.length && !added.length) return;

		for (const repo of removed) this.release(repo);
		this.repos = next;

		if (this.running) {
			for (const [index, repo] of added.entries()) {
				this.adopt(repo, index);
				// Read it now rather than on the next tick: a repo that has just appeared is the one you are
				// most likely to be looking for.
				this.refresh(repo, 'manual');
			}
		}

		for (const listener of this.repoListeners) listener({ added, removed });
		this.scheduleEmit();
	}

	/** Fires when the watched set changes, so the UI can say so rather than silently growing. */
	onRepos(listener: (change: { added: Repo[]; removed: Repo[] }) => void): () => void {
		this.repoListeners.add(listener);
		return () => this.repoListeners.delete(listener);
	}

	private rescan(): void {
		if (!this.running || !this.rediscover) return;
		try {
			this.setRepos(this.rediscover());
		} catch {
			// A scan can fail on a permissions change or a directory disappearing mid-walk. The next one will
			// do just as well, and a failed scan must not take the dashboard down.
		}
	}

	stop(): void {
		this.running = false;
		if (this.rescanTimer) clearInterval(this.rescanTimer);
		this.rescanTimer = null;
		for (const handle of this.wranglerWatchers.values()) handle.close();
		this.wranglerWatchers.clear();
		for (const handle of this.watchers.values()) handle.close();
		this.watchers.clear();
		if (this.ticker) clearInterval(this.ticker);
		if (this.emitTimer) clearTimeout(this.emitTimer);
		this.ticker = null;
		this.emitTimer = null;
		this.queue.length = 0;
	}

	subscribe(listener: (snapshot: Snapshot) => void): () => void {
		this.listeners.add(listener);
		listener(this.snapshot());
		return () => this.listeners.delete(listener);
	}

	/** Fires with the commits and pushes from one read that had not been seen before. */
	onArrivals(listener: (items: (Commit | Push | Run | Deploy)[]) => void): () => void {
		this.arrivalListeners.add(listener);
		return () => this.arrivalListeners.delete(listener);
	}

	// -------------------------------------------------------------------------------------------------
	// Controls
	// -------------------------------------------------------------------------------------------------

	setScope(scope: Scope): void {
		if (scope === this.scope) return;
		this.scope = scope;
		/*
		 * Changing scope changes which commits exist, so every repo is re-read — and each of those reads has to
		 * count as a *first* read, or everything the wider scope reveals is announced as if it just happened.
		 * Pressing `a` for `--all` on this account pulls in a hundred commits fetched from other people: a
		 * hundred bells, a hundred rows flashed fresh, a hundred unread.
		 *
		 * Emptying `loaded` is what makes them baseline. The previous line copied the set instead, which
		 * preserved every entry and therefore did nothing at all. `seen` is deliberately left intact, so
		 * anything already known keeps the `firstSeen` it already had.
		 */
		this.feed = {
			...this.feed,
			loaded: new Set(),
			runsLoaded: new Set(),
			deploysLoaded: new Set()
		};
		for (const repo of this.repos) this.refresh(repo, 'manual');
		this.scheduleEmit();
	}

	setPaused(paused: boolean): void {
		this.paused = paused;
		if (!paused) for (const repo of this.repos) this.refresh(repo, 'manual');
		this.scheduleEmit();
	}

	isPaused(): boolean {
		return this.paused;
	}

	getScope(): Scope {
		return this.scope;
	}

	refreshAll(): void {
		// Remotes are re-resolved and a permanent GitHub failure is retried, so `R` is the way to pick up a
		// remote you just added or a `gh auth login` you just did.
		this.slugs.clear();
		this.workers.clear();
		this.missingWorkers.clear();
		// Look for new repos too, so `R` is the way to pick up a client repo created a moment ago without
		// waiting for the next scan.
		this.rescan();
		this.githubDisabled = false;
		this.cloudflareDisabled = false;
		for (const repo of this.repos) {
			this.refresh(repo, 'manual');
			this.ghNextAt.set(repo.label, 0);
			this.cfNextAt.set(repo.label, 0);
		}
	}

	// -------------------------------------------------------------------------------------------------
	// Reading
	// -------------------------------------------------------------------------------------------------

	private tick(): void {
		if (!this.running || this.paused) return;
		const now = Date.now();
		for (const repo of this.repos) {
			const due = this.nextPollAt.get(repo.label) ?? 0;
			if (now >= due) this.refresh(repo, 'poll');

			// `--local` stops here: the git reads above are cheap and stay, the two network pollers below are
			// what multiply across concurrent instances.
			if (this.local) continue;

			const ghDue = this.ghNextAt.get(repo.label) ?? 0;
			if (now >= ghDue) this.pollDeploys(repo);

			const cfDue = this.cfNextAt.get(repo.label) ?? 0;
			if (now >= cfDue) this.pollCloudflare(repo);
		}
	}

	// -------------------------------------------------------------------------------------------------
	// Deploys
	// -------------------------------------------------------------------------------------------------

	/**
	 * Asks GitHub about one repo's workflow runs, if it is worth asking at all.
	 *
	 * Two local checks come first and remove most of the work: a repo with no GitHub remote is never asked,
	 * and neither is one without a `.github/workflows` directory — eighteen of the twenty-three GitHub repos
	 * on this account have no workflows and would answer with an empty list forever.
	 */
	private pollDeploys(repo: Repo): void {
		if (!this.running || this.paused || this.githubDisabled) return;
		if (this.ghInFlight.has(repo.label)) return;

		// Re-checked every poll rather than cached, because it is one `existsSync` and a branch switch can bring
		// workflows in or out of the checkout.
		if (!hasWorkflows(repo.path)) {
			this.ghNextAt.set(repo.label, Date.now() + 120_000);
			return;
		}

		this.ghInFlight.add(repo.label);
		this.run(async () => {
			try {
				const slug = await this.slugFor(repo);
				if (!slug) {
					// Not a GitHub repo. Check again rarely, in case a remote is added.
					this.ghNextAt.set(repo.label, Date.now() + 600_000);
					return;
				}
				const runs = await readRuns(slug, repo.label, RUN_LIMIT);
				const { feed, added } = applyRuns(this.feed, repo.label, runs, Date.now());
				this.feed = feed;
				this.githubError = null;
				if (added.length) {
					this.arrived += added.length;
					for (const listener of this.arrivalListeners) listener(added);
					// A run that has just finished is a workflow that has just run wrangler, so the Cloudflare
					// deployment already exists. Asking now costs one call and saves up to three minutes of the
					// deploy row trailing the run row that caused it.
					if (added.some((run) => run.conclusion !== null)) this.cfNextAt.set(repo.label, 0);
				}
				this.scheduleEmit();
			} catch (error) {
				const message = String(error).replace(/^\w*Error:\s*/, '');
				this.githubError = message;
				// A missing or logged-out `gh` will not start working while this runs; retrying it across five
				// repos every twenty seconds would be pure noise.
				if (isPermanent(message)) this.githubDisabled = true;
				this.scheduleEmit();
			} finally {
				this.ghInFlight.delete(repo.label);
				const now = Date.now();
				const mine = this.feed.runs.filter((run) => run.repo === repo.label);
				this.ghNextAt.set(
					repo.label,
					now +
						runPollInterval(now, {
							hasActiveRun: mine.some(isActive),
							lastActivityMs: this.lastCommitMs.get(repo.label)
						})
				);
			}
		});
	}

	/**
	 * Asks Cloudflare what versions of this repo's Worker have gone live.
	 *
	 * Gated by its own concurrency limit rather than the shared one, because a wrangler start is far heavier
	 * than a git call and the two should not compete for the same slots.
	 */
	private pollCloudflare(repo: Repo): void {
		if (!this.running || this.paused || this.cloudflareDisabled) return;
		if (this.cfInFlight.has(repo.label)) return;
		if (this.cfActive >= CLOUDFLARE_CONCURRENCY) return;

		this.armWranglerWatch(repo);

		const found = this.workersFor(repo);
		if (!found) {
			// Not a Worker, or no local wrangler to ask with. Checked again rarely in case one appears.
			this.cfNextAt.set(repo.label, Date.now() + 600_000);
			return;
		}

		// Production and review are separate Workers, so a repo means more than one question. Anything not
		// deployed yet is skipped rather than asked about repeatedly.
		const targets = found.targets.filter(
			(target) => !this.missingWorkers.has(`${repo.label}/${target.worker}`)
		);
		if (!targets.length) {
			this.cfNextAt.set(repo.label, Date.now() + 600_000);
			return;
		}

		this.cfInFlight.add(repo.label);
		this.cfActive++;
		void (async () => {
			try {
				const collected = [];
				let failure: string | null = null;

				for (const target of targets) {
					try {
						collected.push(
							...(await readDeployments(repo.path, repo.label, target, found.wrangler))
						);
					} catch (error) {
						const message = String(error).replace(/^\w*Error:\s*/, '');
						if (isMissingWorker(message)) {
							// A review Worker that has never been deployed. Normal, and not an error to report.
							this.missingWorkers.add(`${repo.label}/${target.worker}`);
							continue;
						}
						failure = message;
					}
				}

				// A repo's deploys are replaced as one set, so every target has to be gathered before folding
				// them in — otherwise each target would wipe out the previous one's rows.
				const { feed, added } = applyDeploys(this.feed, repo.label, collected, Date.now());
				this.feed = feed;

				if (failure) {
					this.cloudflareError = failure;
					if (isPermanentCloudflare(failure)) this.cloudflareDisabled = true;
				} else {
					this.cloudflareError = null;
					if (added.length) {
						this.arrived += added.length;
						for (const listener of this.arrivalListeners) listener(added);
					}
				}
				this.scheduleEmit();
			} finally {
				this.cfInFlight.delete(repo.label);
				this.cfActive--;
				const now = Date.now();
				this.cfNextAt.set(
					repo.label,
					now + deployPollInterval(now, { lastActivityMs: this.lastCommitMs.get(repo.label) })
				);
			}
		})();
	}

	/**
	 * Watches `.wrangler` so a deploy run from this laptop is noticed rather than waited for.
	 *
	 * `wrangler deploy` touches that directory as it runs — measured three seconds before the deployment
	 * Cloudflare records — so this turns a laptop deploy into an event. Without it the row waits for the next
	 * poll, and the poll had already relaxed to three minutes because its "is this repo busy" signal was the
	 * last *commit* date. A deploy has no particular relationship to a recent commit: this one was pushed ten
	 * minutes before it was deployed, by which time the repo counted as idle.
	 *
	 * Armed lazily rather than at adoption, because the directory does not exist until wrangler has run in that
	 * repo at least once — three of the seven Workers here have never had it, being deployed only by CI.
	 */
	private armWranglerWatch(repo: Repo): void {
		if (this.wranglerWatchers.has(repo.label)) return;
		const handle = watchDir(join(repo.path, '.wrangler'), () => {
			if (this.paused) return;
			// Ask now rather than on the schedule. One extra call, and the row appears while you are still
			// looking at the terminal you typed the deploy into.
			this.cfNextAt.set(repo.label, 0);
		});
		if (handle) this.wranglerWatchers.set(repo.label, handle);
	}

	/** The Workers this repo deploys, resolved once. Null is cached, so a non-Worker is not re-checked. */
	private workersFor(repo: Repo): { targets: WorkerTarget[]; wrangler: string } | null {
		const cached = this.workers.get(repo.label);
		if (cached !== undefined) return cached;
		const found = workersFor(repo.path);
		this.workers.set(repo.label, found);
		return found;
	}

	/** The remote's `owner/repo`, read once. Null means "not GitHub", and is cached as such. */
	private async slugFor(repo: Repo): Promise<string | null> {
		const cached = this.slugs.get(repo.label);
		if (cached !== undefined) return cached;
		const url = await readRemoteUrl(repo.path);
		const slug = url ? githubSlug(url) : null;
		this.slugs.set(repo.label, slug);
		return slug;
	}

	/**
	 * Queues a read of one repo. Reads of the same repo never overlap — a filesystem burst during a rebase
	 * would otherwise start a dozen.
	 */
	private refresh(repo: Repo, reason: RefreshReason): void {
		if (!this.running) return;
		if (this.inFlight.has(repo.label)) {
			if (queuesFollowUp(reason)) this.again.add(repo.label);
			return;
		}
		this.inFlight.add(repo.label);
		this.run(async () => {
			try {
				await this.read(repo);
			} finally {
				this.inFlight.delete(repo.label);
				// Nothing is rescheduled for a repo that has been released while this ran — putting an entry
				// back in `nextPollAt` would leave a schedule behind for something no longer watched.
				if (!this.watching(repo)) return;

				const now = Date.now();
				this.nextPollAt.set(repo.label, now + pollInterval(now, this.lastCommitMs.get(repo.label)));
				if (this.again.delete(repo.label)) {
					// After a short gap rather than immediately, so a long burst of events cannot become an
					// unbroken chain of reads with no pause between them.
					const timer = setTimeout(() => this.refresh(repo, 'change'), FOLLOW_UP_MS);
					timer.unref?.();
				}
			}
		});
	}

	private async read(repo: Repo): Promise<void> {
		// Three independent reads, settled together. `allSettled` rather than `all` because a repo with no
		// remote has no push reflog to read, and that must not cost it its commits.
		const [commits, status, pushes] = await Promise.allSettled([
			readCommits(repo.path, this.limit, this.scope),
			readStatus(repo.path),
			readPushes(repo.path, repo.label, PUSH_LIMIT)
		]);

		/*
		 * The repo may have been dropped while these were in flight — a rescan found it gone, or it moved.
		 * `release` has already forgotten its rows and its schedules, so writing this result back would
		 * resurrect a repo that no longer exists, permanently: nothing polls it again, so nothing ever forgets
		 * it a second time. Its rows sit in the feed and its entry sits in `statuses` for the rest of the
		 * session.
		 */
		if (!this.watching(repo)) return;

		const now = Date.now();

		if (pushes.status === 'fulfilled') {
			const { feed, added } = applyPushes(this.feed, repo.label, pushes.value, now);
			this.feed = feed;
			if (added.length) {
				this.arrived += added.length;
				for (const listener of this.arrivalListeners) listener(added);
				// How many commits each one carried, for live pushes only — see `countBetween`. The reflog is
				// newest-first, so the entry after a push in `pushes.value` is what the ref pointed at before.
				void this.fillPushCounts(repo, added, pushes.value);
			}
		}

		if (commits.status === 'fulfilled') {
			const { feed, added } = applyRead(this.feed, repo.label, commits.value, now);
			this.feed = feed;
			const newest = commits.value[0];
			if (newest) this.lastCommitMs.set(repo.label, Date.parse(newest.committed));
			this.errors.delete(repo.label);
			if (added.length) {
				this.arrived += added.length;
				for (const listener of this.arrivalListeners) listener(added);
			}
		} else {
			// A repo mid-rebase, or one deleted while running, reports its error in its own row rather than
			// taking down the twenty-seven that are fine.
			this.errors.set(repo.label, String(commits.reason).replace(/^Error:\s*/, ''));
		}

		if (status.status === 'fulfilled') {
			this.statuses.set(repo.label, status.value);
		} else {
			const previous = this.statuses.get(repo.label);
			const message = String(status.reason).replace(/^Error:\s*/, '');
			this.statuses.set(
				repo.label,
				previous
					? { ...previous, error: message }
					: {
							branch: '?',
							upstream: null,
							ahead: 0,
							behind: 0,
							changed: 0,
							staged: 0,
							unstaged: 0,
							untracked: 0,
							conflicted: 0,
							unborn: false,
							error: message
						}
			);
		}

		this.scheduleEmit();
	}

	/**
	 * Fills in "pushed 3 commits" after the fact.
	 *
	 * Deliberately not awaited by `read`: the push is already on screen, and a `rev-list` per push must not
	 * delay the row appearing. When the count comes back the push objects are replaced in place and one more
	 * snapshot goes out.
	 */
	private async fillPushCounts(
		repo: Repo,
		added: Push[],
		all: Omit<Push, 'firstSeen' | 'baseline'>[]
	): Promise<void> {
		for (const push of added) {
			const ref = `${push.remote}/${push.branch}`;
			// The next entry for the same ref in a newest-first reflog is the previous position. Matched on
			// sha as well as time, because two pushes inside one second share a timestamp and matching on
			// time alone would find the wrong entry and count the wrong range.
			const index = all.findIndex(
				(p) => p.at === push.at && p.sha === push.sha && `${p.remote}/${p.branch}` === ref
			);
			if (index < 0) continue;
			const previous = all.slice(index + 1).find((p) => `${p.remote}/${p.branch}` === ref);
			if (!previous) continue;

			const count = await countBetween(repo.path, previous.sha, push.sha);
			if (count === null) continue;

			this.feed = {
				...this.feed,
				pushes: this.feed.pushes.map((p) =>
					p.repo === push.repo &&
					p.at === push.at &&
					p.sha === push.sha &&
					`${p.remote}/${p.branch}` === ref
						? { ...p, count }
						: p
				)
			};
			this.scheduleEmit();
		}
	}

	// -------------------------------------------------------------------------------------------------
	// Detail, fetched when a commit is opened
	// -------------------------------------------------------------------------------------------------

	async files(repoLabel: string, sha: string): Promise<FileChange[]> {
		const cacheKey = `${repoLabel}\u0000${sha}`;
		const cached = this.filesCache.get(cacheKey);
		if (cached) return cached;
		const repo = this.repos.find((r) => r.label === repoLabel);
		if (!repo) return [];
		const files = await readFiles(repo.path, sha);
		// A commit's contents cannot change, so an entry never goes stale — but "never stale" is not a reason
		// to keep it forever. Bounded, because a session left open for a week is the case this program is for.
		if (this.filesCache.size > 400) this.filesCache.clear();
		this.filesCache.set(cacheKey, files);
		return files;
	}

	async diff(repoLabel: string, sha: string, path: string): Promise<string[]> {
		const cacheKey = `${repoLabel}\u0000${sha}\u0000${path}`;
		const cached = this.diffCache.get(cacheKey);
		if (cached) return cached;
		const repo = this.repos.find((r) => r.label === repoLabel);
		if (!repo) return [];
		const lines = await readDiff(repo.path, sha, path);
		// Bounded so opening every file of a long day's work cannot grow without limit.
		if (this.diffCache.size > 200) this.diffCache.clear();
		this.diffCache.set(cacheKey, lines);
		return lines;
	}

	// -------------------------------------------------------------------------------------------------
	// Plumbing
	// -------------------------------------------------------------------------------------------------

	/**
	 * The maps are **copied** on the way out, and that is not defensive habit — it is required.
	 *
	 * The engine mutates its own maps in place. Handing the same `Map` object to React on every emit means
	 * every `useMemo` keyed on it sees an unchanged reference and never recomputes, so it keeps whatever it
	 * calculated from the *first* snapshot, when the map was still empty. That is exactly how the repo panel
	 * came out sorted alphabetically instead of by recency: the ages beside each row were current, because
	 * they are read during render, while the sort that ordered the rows had run once against nothing and was
	 * never asked again. Twenty-eight entries is nothing to copy; a stale memo is very hard to see.
	 */
	snapshot(): Snapshot {
		return {
			repos: this.repos,
			feed: this.feed.commits,
			pushes: this.feed.pushes,
			runs: this.feed.runs,
			deploys: this.feed.deploys,
			githubError: this.githubError,
			cloudflareError: this.cloudflareError,
			statuses: new Map(this.statuses),
			lastCommitMs: new Map(this.lastCommitMs),
			errors: new Map(this.errors),
			loaded: this.feed.loaded.size,
			scope: this.scope,
			paused: this.paused,
			startedAt: this.startedAt,
			arrived: this.arrived,
			local: this.local
		};
	}

	private scheduleEmit(): void {
		if (this.emitTimer) return;
		this.emitTimer = setTimeout(() => {
			this.emitTimer = null;
			const snapshot = this.snapshot();
			for (const listener of this.listeners) listener(snapshot);
		}, EMIT_MS);
		this.emitTimer.unref?.();
	}

	/** A semaphore. Twenty-eight repos times two git calls would otherwise be fifty-six at once. */
	private run(task: () => Promise<void>): void {
		const start = () => {
			this.active++;
			task().finally(() => {
				this.active--;
				const next = this.queue.shift();
				if (next) next();
			});
		};
		if (this.active < this.concurrency) start();
		else this.queue.push(start);
	}
}
