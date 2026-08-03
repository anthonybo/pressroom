/** The shared vocabulary. Everything here is plain data — no methods, nothing that holds a handle. */

/** One git repository found on disk. */
export type Repo = {
	/** What the UI calls it. Basename where that is unique, else `parent/basename`. */
	label: string;
	/** Absolute path to the working tree. */
	path: string;
	/** Absolute path to the git directory — not always `<path>/.git`; see `resolveGitDir`. */
	gitDir: string;
	/** Absolute path to the *common* git dir, which differs from `gitDir` only in a linked worktree. */
	commonDir: string;
	/** Path relative to the scan root, for display in the repo panel. */
	relPath: string;
};

/** A commit exactly as git reported it, before pressroom adds any bookkeeping. */
export type RawCommit = {
	sha: string;
	short: string;
	author: string;
	email: string;
	/** ISO 8601, when the work was written. */
	authored: string;
	/** ISO 8601, when the commit object was made. This is the one the feed sorts on. */
	committed: string;
	/** `%D` — the ref names pointing here, e.g. `HEAD -> main, origin/main`. */
	refs: string;
	parents: string[];
	subject: string;
	body: string;
	files: number;
	insertions: number;
	deletions: number;
};

/** A commit in the feed: what git said, plus when pressroom first laid eyes on it. */
export type Commit = RawCommit & {
	/** `Repo.label` of the repo it came from. */
	repo: string;
	/** `Date.now()` of the first read that contained this sha. */
	firstSeen: number;
	/**
	 * True when this commit was already present in the first read of its repo. Baseline commits are
	 * history; they must never flash as new, or every launch would announce three hundred arrivals.
	 */
	baseline: boolean;
};

/** Working-tree and upstream state, all of it from a single `git status --porcelain=v2 --branch`. */
export type RepoStatus = {
	branch: string;
	/** Null on a detached HEAD or a branch with no configured upstream. */
	upstream: string | null;
	/** Commits on this branch that the upstream does not have — on this workspace, undeployed work. */
	ahead: number;
	behind: number;
	/**
	 * Tracked files with any change at all, counted once each.
	 *
	 * Not `staged + unstaged`: a file that was staged and then edited again is reported by git as `MM`, which
	 * appears in both halves, and summing them calls one changed file two of them.
	 */
	changed: number;
	staged: number;
	unstaged: number;
	untracked: number;
	conflicted: number;
	/** True before the first commit, when there is no HEAD to compare against. */
	unborn: boolean;
	/** Set when git failed for this repo — shown in place of the numbers rather than thrown. */
	error?: string;
};

/**
 * A push, reconstructed from the reflog of a remote-tracking ref.
 *
 * Pushing writes an entry to `.git/logs/refs/remotes/<remote>/<branch>` whose message is `update by push` —
 * which is what makes this knowable at all, and what distinguishes it from a `fetch`, whose entries land in
 * the same reflog with a different message. The reflog also carries the timestamp, so a push that happened
 * before pressroom was launched still appears with the time it really occurred.
 */
export type Push = {
	repo: string;
	/** The remote, e.g. `origin`. */
	remote: string;
	/** The branch that was pushed, e.g. `main` or `feature/x`. */
	branch: string;
	sha: string;
	short: string;
	/** ISO 8601, from the reflog entry. */
	at: string;
	/** Commits the remote ref advanced by. Computed for live pushes only; null for reflog history. */
	count: number | null;
	/** A non-fast-forward update — history on the remote was replaced. */
	forced: boolean;
	firstSeen: number;
	baseline: boolean;
};

/**
 * A deploy: one GitHub Actions workflow run.
 *
 * Unlike a commit or a push, a run **changes** after it appears — queued, then in progress, then a
 * conclusion. So it is one row that updates in place, and `changedAt` records when its state last moved,
 * which is what makes a deploy that has just gone red draw the eye even though the run itself started
 * minutes ago.
 */
export type Run = {
	repo: string;
	/** GitHub's numeric run id — the stable identity across status changes. */
	id: number;
	/** The workflow's name, e.g. `Deploy`. */
	workflow: string;
	branch: string;
	sha: string;
	short: string;
	/** The commit title the run was triggered by. */
	title: string;
	/** `push`, `workflow_dispatch`, `schedule`, … */
	event: string;
	/** `queued`, `in_progress`, `completed`. */
	status: string;
	/** `success`, `failure`, `cancelled`, … or null while it is still running. */
	conclusion: string | null;
	startedAt: string;
	updatedAt: string;
	url: string;
	/** Wall-clock duration once finished, null while running. */
	durationMs: number | null;
	firstSeen: number;
	/** When this run's status or conclusion was first seen to be what it now is. */
	changedAt: number;
	baseline: boolean;
};

/**
 * A Cloudflare deploy: one Worker version going live.
 *
 * Distinct from a workflow run on purpose. A run is a pipeline that may or may not have deployed anything;
 * this is Cloudflare confirming the Worker changed. Three of the Workers here are deployed straight from the
 * laptop with `wrangler deploy` and have no workflow run at all.
 *
 * There is no commit sha in Cloudflare's record, so a deploy row is not tied to a commit — the deployment id
 * and version id are what identify it.
 */
export type Deploy = {
	repo: string;
	/** The Worker's name at Cloudflare, which is not the repo name: `example.dev` deploys `example-dev`. */
	worker: string;
	/** The wrangler environment this Worker belongs to — null for production, `dev` for the review copy. */
	env: string | null;
	/**
	 * The hostname it serves, from the config's routes: `gallery-dev.example.dev` rather than
	 * `gallery.example.dev`. Null when the config declares no routes, in which case the Worker name is all
	 * there is to show. This is what tells a review deploy apart from a production one at a glance.
	 */
	hostname: string | null;
	id: string;
	versionId: string;
	/** `wrangler`, `dash`, `api`, `terraform` — how it was deployed. */
	source: string;
	/** `deployment` or `rollback`. */
	triggeredBy: string;
	authorEmail: string;
	/** ISO 8601 `created_on`. */
	at: string;
	firstSeen: number;
	baseline: boolean;
};

/**
 * What the feed displays: commits, pushes, workflow runs and Cloudflare deploys on one timeline.
 *
 * They stay separate types with a tag rather than becoming one wider type, because almost nothing is shared
 * — a push has no author, no diff and no file list; a commit has no remote and no conclusion.
 */
export type FeedItem =
	| { kind: 'commit'; commit: Commit }
	| { kind: 'push'; push: Push }
	| { kind: 'run'; run: Run }
	| { kind: 'deploy'; deploy: Deploy };

/** One entry in a commit's file list. */
export type FileChange = {
	path: string;
	/** Set only for renames and copies. */
	from?: string;
	/** Null for binary files, where git reports `-` instead of a count. */
	insertions: number | null;
	deletions: number | null;
	/** git's status letter: A, M, D, R, C, T, U. */
	status: string;
};

/** Which refs the feed follows. */
export type Scope = 'branches' | 'head' | 'all';

/** Where the user is. The detail views carry enough to re-fetch their own data. */
export type View =
	| { kind: 'feed' }
	| { kind: 'commit'; repo: string; sha: string }
	| { kind: 'diff'; repo: string; sha: string; path: string }
	| { kind: 'help' };
