/**
 * Every git invocation in the program, and the parsers for what comes back.
 *
 * Three rules hold throughout:
 *
 * **Read-only, and provably so.** The subcommands used are `log`, `status`, `show`, `rev-list` and
 * `config --get` — all of them readers, and all of them routed through the single `git()` below, so the
 * claim is checkable by grepping this file for `git(` rather than taken on trust.
 * `GIT_OPTIONAL_LOCKS=0` is set on all of them, which is exactly what that variable is for: it stops
 * `status` from taking `index.lock` to write back a refreshed index. Without it a dashboard polling
 * thirty repos would occasionally hold the lock at the moment you run `git commit` in one of them,
 * and the failure — "Unable to create index.lock: File exists" — would look like your own git breaking.
 *
 * **`LC_ALL=C`.** `--shortstat` prints a translated sentence. On a localized git, "3 files changed" is not
 * that string, and the regex below would quietly find nothing and report every commit as empty.
 *
 * **Parsers are pure and separate from the calls.** They take a string and return data, so the awkward
 * cases — a rename inside `-z` output, a body containing a blank line, an unborn branch — are covered by
 * tests with no repository involved.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { sanitize } from './format.ts';
import type { FileChange, Push, RawCommit, RepoStatus, Scope } from './types.ts';

const exec = promisify(execFile);

/**
 * Field and record separators for the log format. Both are C0 control characters that cannot appear in a
 * commit message written by any normal means, which makes splitting on them safe where splitting on
 * newlines is not: a commit body is arbitrary multi-line text and would tear a line-based parse apart.
 */
const F = '\u001f';
const R = '\u001e';

const LOG_FORMAT = `${R}%H${F}%h${F}%an${F}%ae${F}%aI${F}%cI${F}%D${F}%P${F}%s${F}%b${F}`;

/** Bounded so a wedged git — a stale lock, a filesystem hiccup — cannot freeze a repo's row forever. */
const TIMEOUT_MS = 15_000;

class GitError extends Error {}

/**
 * The environment every git invocation runs with. Exported so the three settings can be asserted, because
 * each one is invisible until it is missing and none of them announces itself when removed.
 *
 * - `GIT_OPTIONAL_LOCKS=0` stops `status` taking `index.lock` to write back a refreshed index. Without it a
 *   dashboard polling thirty repos will now and then hold the lock at the moment you run `git commit`, and
 *   the error looks like your own git breaking.
 * - `GIT_TERMINAL_PROMPT=0`: nothing here touches the network, but a misconfigured remote helper deciding to
 *   ask for a password would block on the terminal this process is drawing a UI on.
 * - `LC_ALL=C` because `--shortstat` prints a *translated* sentence. On a localized git the parser finds
 *   nothing and every commit silently reads as having changed no files at all.
 */
export function gitEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	return {
		...base,
		GIT_OPTIONAL_LOCKS: '0',
		GIT_TERMINAL_PROMPT: '0',
		LC_ALL: 'C'
	};
}

async function git(repo: string, args: string[], maxBuffer = 16 * 1024 * 1024): Promise<string> {
	try {
		const { stdout } = await exec('git', ['-C', repo, '--no-pager', ...args], {
			encoding: 'utf8',
			maxBuffer,
			timeout: TIMEOUT_MS,
			env: gitEnv()
		});
		return stdout;
	} catch (error) {
		const err = error as { stderr?: string; message?: string };
		const first = (err.stderr || err.message || 'git failed').trim().split('\n')[0];
		// Sanitized like everything else that ends up on screen. git's errors quote the things that caused
		// them — a branch name, a path — which are attacker-chosen text in exactly the way a commit subject
		// is. This was the one route to the terminal that skipped the check the rest of the program applies.
		throw new GitError(sanitize(first ?? 'git failed'));
	}
}

// ---------------------------------------------------------------------------------------------------
// git log
// ---------------------------------------------------------------------------------------------------

/**
 * `--shortstat` rather than `--numstat` for the feed, and the reason is filenames. `--numstat` prints
 * paths, so a path containing a tab or a non-ASCII byte arrives quoted and escaped and has to be decoded
 * before the numbers beside it can be trusted. `--shortstat` prints only a count sentence — no paths, no
 * quoting, nothing to get wrong. The per-file numbers are fetched by `readFiles` when a commit is opened,
 * where `-z` makes them unambiguous and the cost is one commit rather than three hundred.
 */
export function parseLog(stdout: string): RawCommit[] {
	const commits: RawCommit[] = [];
	for (const record of stdout.split(R)) {
		if (!record.trim()) continue;
		const parts = record.split(F);
		if (parts.length < 11) continue;

		// The body is everything between the subject and the trailing shortstat. Slicing from both ends
		// rather than indexing forward means a body that somehow contains the field separator still lands
		// in the body instead of shifting every field after it.
		const body = parts.slice(9, parts.length - 1).join(F);
		const stat = parseShortstat(parts[parts.length - 1] ?? '');

		commits.push({
			sha: (parts[0] ?? '').trim(),
			short: (parts[1] ?? '').trim(),
			author: sanitize(parts[2] ?? ''),
			email: sanitize(parts[3] ?? ''),
			authored: (parts[4] ?? '').trim(),
			committed: (parts[5] ?? '').trim(),
			refs: sanitize(parts[6] ?? ''),
			parents: (parts[7] ?? '').trim().split(/\s+/).filter(Boolean),
			subject: sanitize(parts[8] ?? ''),
			body: sanitize(body).trim(),
			...stat
		});
	}
	return commits;
}

/** ` 3 files changed, 42 insertions(+), 12 deletions(-)` — any of the three clauses may be absent. */
export function parseShortstat(tail: string): {
	files: number;
	insertions: number;
	deletions: number;
} {
	const num = (re: RegExp) => {
		const m = re.exec(tail);
		return m?.[1] ? Number(m[1]) : 0;
	};
	return {
		files: num(/(\d+) files? changed/),
		insertions: num(/(\d+) insertions?\(\+\)/),
		deletions: num(/(\d+) deletions?\(-\)/)
	};
}

const SCOPE_ARGS: Record<Scope, string[]> = {
	/**
	 * Local branches, which is the useful default. `HEAD` alone loses the commits you just made the
	 * moment you switch branches; `--all` includes remote-tracking refs, so one `git pull` in an old repo
	 * dumps a hundred someone-else's-commits into a feed that is meant to show what is happening here.
	 */
	branches: ['--branches'],
	head: [],
	all: ['--all']
};

export async function readCommits(repo: string, limit: number, scope: Scope): Promise<RawCommit[]> {
	try {
		const stdout = await git(repo, [
			// A repo that signs its commits prints the signature verification above each one, which lands
			// in the middle of the record and derails the parse.
			'-c',
			'log.showSignature=false',
			'log',
			'--no-color',
			'--date-order',
			'--shortstat',
			`-n${limit}`,
			`--format=${LOG_FORMAT}`,
			...SCOPE_ARGS[scope]
		]);
		return parseLog(stdout);
	} catch (error) {
		// A repo with no commits yet is not an error worth showing — it is a repo you just created.
		if (/does not have any commits|unknown revision|bad default revision/i.test(String(error))) {
			return [];
		}
		throw error;
	}
}

// ---------------------------------------------------------------------------------------------------
// Pushes, out of the remote-tracking reflogs
// ---------------------------------------------------------------------------------------------------

/**
 * `git log -g --remotes` walks the reflog of every remote-tracking ref in one invocation, which is what
 * makes this affordable — the alternative is `git reflog show` per remote branch per repo per read.
 *
 * The selector carries both the ref and the time: `refs/remotes/origin/main@{1785299984}` with
 * `--date=unix`. The message is what separates the two things that write to these reflogs — a push records
 * `update by push`, a fetch records `fetch origin: fast-forward`. Reading the message rather than inferring
 * from a sha change is what keeps someone else's commits arriving via `git pull` from being reported as
 * something you pushed.
 */
export function parsePushes(stdout: string, repo: string): Omit<Push, 'firstSeen' | 'baseline'>[] {
	const pushes: Omit<Push, 'firstSeen' | 'baseline'>[] = [];

	for (const line of stdout.split('\n')) {
		if (!line.trim()) continue;
		const [selector, subject, sha, short] = line.split(F);
		if (!selector || !sha) continue;

		// Anything that is not a push shares these reflogs and must be left alone.
		const message = subject ?? '';
		if (!/\bpush\b|forced-update/i.test(message)) continue;

		const match = /^refs\/remotes\/(.+)@\{(\d+)\}$/.exec(selector);
		if (!match?.[1] || !match[2]) continue;

		const ref = match[1];
		// The remote name is the first segment; everything after it is the branch, which may itself contain
		// slashes — `origin/feature/x` is the branch `feature/x` on `origin`.
		const slash = ref.indexOf('/');
		if (slash < 1) continue;
		const remote = ref.slice(0, slash);
		const branch = ref.slice(slash + 1);
		// `origin/HEAD` is a symbolic pointer, not a branch anyone pushed.
		if (branch === 'HEAD') continue;

		pushes.push({
			repo,
			remote: sanitize(remote),
			branch: sanitize(branch),
			sha: sha.trim(),
			short: (short ?? sha.slice(0, 7)).trim(),
			at: new Date(Number(match[2]) * 1000).toISOString(),
			count: null,
			forced: /forced/i.test(message)
		});
	}
	return pushes;
}

export async function readPushes(
	repo: string,
	label: string,
	limit: number
): Promise<Omit<Push, 'firstSeen' | 'baseline'>[]> {
	try {
		const stdout = await git(repo, [
			'-c',
			'log.showSignature=false',
			'log',
			'-g',
			'--remotes',
			'--no-color',
			'--date=unix',
			`-n${limit}`,
			`--format=%gD${F}%gs${F}%H${F}%h`
		]);
		return parsePushes(stdout, label);
	} catch {
		// A repo with no remote, or one whose remote-tracking refs have no reflog, has no pushes to report.
		// That is the normal state of half the repositories here, not an error worth a row.
		return [];
	}
}

/**
 * How many commits a push added, as `old..new`. Run only for pushes seen arriving live — doing it for the
 * reflog history of every repo at startup would be a hundred extra invocations for numbers nobody is
 * waiting on.
 */
export async function countBetween(repo: string, from: string, to: string): Promise<number | null> {
	try {
		const stdout = await git(repo, ['rev-list', '--count', `${from}..${to}`]);
		const count = Number(stdout.trim());
		return Number.isFinite(count) ? count : null;
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------------------------------
// git status
// ---------------------------------------------------------------------------------------------------

/**
 * One call for branch, upstream, ahead/behind and the working tree. `--porcelain=v2 --branch` is
 * documented as stable output, unlike v1 where the ahead/behind count is not available at all and the
 * branch name arrives in a human sentence.
 *
 * On this account ahead-count is the number that matters most: these repos deploy by push, so `↑3` is
 * three commits of work that exist only on this laptop.
 */
export function parseStatus(stdout: string): RepoStatus {
	const status: RepoStatus = {
		branch: '?',
		upstream: null,
		ahead: 0,
		behind: 0,
		changed: 0,
		staged: 0,
		unstaged: 0,
		untracked: 0,
		conflicted: 0,
		unborn: false
	};

	// `-z` terminates every line with NUL, headers included.
	const lines = stdout.split('\0');
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (!line) continue;

		if (line.startsWith('# branch.head ')) {
			const name = line.slice('# branch.head '.length);
			status.branch = name === '(detached)' ? 'detached' : sanitize(name);
		} else if (line.startsWith('# branch.upstream ')) {
			status.upstream = sanitize(line.slice('# branch.upstream '.length));
		} else if (line.startsWith('# branch.oid ')) {
			status.unborn = line.slice('# branch.oid '.length) === '(initial)';
		} else if (line.startsWith('# branch.ab ')) {
			const m = /\+(\d+)\s+-(\d+)/.exec(line);
			status.ahead = Number(m?.[1] ?? 0);
			status.behind = Number(m?.[2] ?? 0);
		} else if (line.startsWith('1 ') || line.startsWith('2 ')) {
			// `<XY>` is the staged and unstaged state; `.` means unchanged in that half.
			const xy = line.slice(2, 4);
			const stagedHere = Boolean(xy[0] && xy[0] !== '.');
			const unstagedHere = Boolean(xy[1] && xy[1] !== '.');
			if (stagedHere) status.staged++;
			if (unstagedHere) status.unstaged++;
			// Counted once per *file*. A file that is staged and then modified again reports `MM`, and adding
			// the two halves together would call one changed file two of them.
			if (stagedHere || unstagedHere) status.changed++;
			// A rename entry carries a second path in the following NUL-separated chunk, which must not
			// be read as a status line of its own.
			if (line.startsWith('2 ')) i++;
		} else if (line.startsWith('u ')) {
			status.conflicted++;
			status.changed++;
		} else if (line.startsWith('? ')) {
			status.untracked++;
		}
	}
	return status;
}

export async function readStatus(repo: string): Promise<RepoStatus> {
	return parseStatus(await git(repo, ['status', '--porcelain=v2', '--branch', '-z']));
}

// ---------------------------------------------------------------------------------------------------
// git show — the per-commit file list
// ---------------------------------------------------------------------------------------------------

/** `ins\tdel\tpath`, or for a rename `ins\tdel\t` then the old and new paths as separate chunks. */
export function parseNumstat(
	stdout: string
): Map<string, { insertions: number | null; deletions: number | null; from?: string }> {
	const out = new Map<
		string,
		{ insertions: number | null; deletions: number | null; from?: string }
	>();
	const chunks = stdout.split('\0');
	for (let i = 0; i < chunks.length; i++) {
		const chunk = chunks[i];
		if (!chunk) continue;
		const m = /^(\S+)\t(\S+)\t(.*)$/.exec(chunk);
		if (!m) continue;
		// A binary file's counts are printed as `-`, which is genuinely unknown rather than zero.
		const insertions = m[1] === '-' ? null : Number(m[1]);
		const deletions = m[2] === '-' ? null : Number(m[2]);
		if (m[3] === '') {
			const from = chunks[i + 1];
			const to = chunks[i + 2];
			if (to)
				out.set(sanitize(to), { insertions, deletions, from: from ? sanitize(from) : undefined });
			i += 2;
		} else {
			out.set(sanitize(m[3] ?? ''), { insertions, deletions });
		}
	}
	return out;
}

/** `M\0path\0`, and for renames and copies `R100\0old\0new\0`. */
export function parseNameStatus(stdout: string): Map<string, string> {
	const out = new Map<string, string>();
	const chunks = stdout.split('\0');
	for (let i = 0; i < chunks.length; i++) {
		const code = chunks[i];
		if (!code || !/^[A-Z]\d*$/.test(code)) continue;
		const letter = code[0] ?? '?';
		if (letter === 'R' || letter === 'C') {
			const to = chunks[i + 2];
			if (to) out.set(sanitize(to), letter);
			i += 2;
		} else {
			const path = chunks[i + 1];
			if (path) out.set(sanitize(path), letter);
			i += 1;
		}
	}
	return out;
}

export async function readFiles(repo: string, sha: string): Promise<FileChange[]> {
	// Two calls because no single git option gives both line counts and status letters. They run
	// together, and only when a commit is actually opened.
	const [numstat, nameStatus] = await Promise.all([
		git(repo, ['show', '--format=', '--numstat', '-z', '--find-renames', sha]),
		git(repo, ['show', '--format=', '--name-status', '-z', '--find-renames', sha])
	]);
	const counts = parseNumstat(numstat);
	const letters = parseNameStatus(nameStatus);

	const files: FileChange[] = [];
	for (const [path, count] of counts) {
		files.push({
			path,
			from: count.from,
			insertions: count.insertions,
			deletions: count.deletions,
			status: letters.get(path) ?? 'M'
		});
	}
	// Paths only `--name-status` knew about: a pure mode change has a status letter and no line counts.
	for (const [path, letter] of letters) {
		if (!counts.has(path)) files.push({ path, insertions: 0, deletions: 0, status: letter });
	}
	return files;
}

// ---------------------------------------------------------------------------------------------------
// git show — one file's patch
// ---------------------------------------------------------------------------------------------------

/** Enough for any hand-written change; a regenerated lockfile gets truncated and says so. */
const DIFF_MAX_BYTES = 2 * 1024 * 1024;

export async function readDiff(repo: string, sha: string, path: string): Promise<string[]> {
	const stdout = await git(
		repo,
		[
			'show',
			'--format=',
			'--no-color',
			// Without this, a repo with a configured textconv filter would run an external program to
			// render the diff — slow at best, and not something a dashboard should trigger.
			'--no-textconv',
			'-U3',
			'--find-renames',
			sha,
			'--',
			path
		],
		DIFF_MAX_BYTES + 1024
	);
	const lines = stdout.split('\n').map(sanitize);
	if (lines.length && lines[lines.length - 1] === '') lines.pop();
	return lines;
}

/** The whole commit as a patch, for when no single file is selected. */
export async function readCommitDiffStat(repo: string, sha: string): Promise<string> {
	return git(repo, ['show', '--format=', '--stat=100', '--no-color', sha]);
}

/**
 * The origin remote's URL, for working out whether a repo is on GitHub.
 *
 * `config --get` rather than `remote get-url`, because it exits non-zero rather than printing an error when
 * there is no remote — which is the common case here and not worth an exception.
 */
export async function readRemoteUrl(repo: string): Promise<string | null> {
	try {
		const stdout = await git(repo, ['config', '--get', 'remote.origin.url']);
		return stdout.trim() || null;
	} catch {
		return null;
	}
}
