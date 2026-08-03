/**
 * Finding the repos.
 *
 * `~/projects` is not flat and that is the whole difficulty. Twenty-eight repos sit at two different
 * depths: eighteen are its direct children, and ten more live inside `acme/`, which is itself a
 * plain folder holding a repo per project. A scan of the root's children finds eighteen of them and
 * silently misses the ten that are worked on most.
 *
 * So this walks. It descends through ordinary directories looking for git dirs, and stops descending the
 * moment it finds one — a repo's own subdirectories hold its source, not more repos, and walking into
 * them is how a scan ends up reading `node_modules`. `--list` prints what was found and exits, because
 * "did it get the nested ones" should be answerable without launching the UI.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { Repo } from './types.ts';

/**
 * How deep to go. `acme/overlay` is depth 2, so 4 leaves room for one more level of grouping
 * without turning a scan of a home directory into a walk of the entire disk.
 */
export const DEFAULT_MAX_DEPTH = 4;

/**
 * Directories never worth entering. `node_modules` is the one that matters — a single `npm install` can
 * put tens of thousands of directories under a project, and some packages ship a `.git`.
 */
const SKIP = new Set([
	'node_modules',
	'dist',
	'build',
	'out',
	'coverage',
	'vendor',
	'target',
	'.git',
	'Library',
	'__pycache__',
	'venv',
	'.venv'
]);

/**
 * Resolves the git directory for a working tree. Usually `<path>/.git`, but in a linked worktree `.git`
 * is a *file* holding `gitdir: <path>`, and refs there live partly in the main repo. Reading it costs one
 * `readFileSync` and means a worktree checkout is watched at the right place instead of not at all.
 */
export function resolveGitDir(repoPath: string): { gitDir: string; commonDir: string } | null {
	const dotGit = join(repoPath, '.git');
	let stat;
	try {
		stat = statSync(dotGit);
	} catch {
		return null;
	}

	if (stat.isDirectory()) return { gitDir: dotGit, commonDir: dotGit };
	if (!stat.isFile()) return null;

	// `gitdir: /abs/path/.git/worktrees/name`, or occasionally a path relative to the working tree.
	const match = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dotGit, 'utf8'));
	if (!match?.[1]) return null;
	const gitDir = isAbsolute(match[1]) ? match[1] : resolve(repoPath, match[1]);
	if (!existsSync(gitDir)) return null;

	// `commondir` points at the shared git dir, where `refs/heads` actually lives for this worktree.
	let commonDir = gitDir;
	const commonFile = join(gitDir, 'commondir');
	if (existsSync(commonFile)) {
		const raw = readFileSync(commonFile, 'utf8').trim();
		if (raw) commonDir = isAbsolute(raw) ? raw : resolve(gitDir, raw);
	}
	return { gitDir, commonDir };
}

/** Every working tree under `root`, in path order. */
export function discover(root: string, maxDepth = DEFAULT_MAX_DEPTH): Repo[] {
	const found: Repo[] = [];
	const rootAbs = resolve(root);

	const walk = (dir: string, depth: number) => {
		const git = resolveGitDir(dir);
		if (git) {
			found.push({
				label: basename(dir),
				path: dir,
				gitDir: git.gitDir,
				commonDir: git.commonDir,
				relPath: relative(rootAbs, dir) || basename(dir)
			});
			// A repo boundary. Its contents are source files, not more projects.
			return;
		}
		if (depth >= maxDepth) return;

		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			// Unreadable directory — a permissions problem is not a reason to abandon the whole scan.
			return;
		}
		for (const entry of entries) {
			// Symlinks are skipped rather than followed: following them invites a cycle, and a walk that
			// loops looks exactly like a hang.
			if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
			if (entry.name.startsWith('.') || SKIP.has(entry.name)) continue;
			walk(join(dir, entry.name), depth + 1);
		}
	};

	// The root itself may be a repo; depth 0 so its children are still reachable when it is not.
	walk(rootAbs, 0);
	return label(found, rootAbs);
}

/**
 * Names for the panel. A basename is what you would call the project out loud, so it wins when it is
 * unambiguous; the two repos that would both be `demo` get `acme/demo` and `archive/demo`
 * instead. Disambiguating only on collision keeps the common case short.
 */
export function label(repos: Repo[], root: string): Repo[] {
	const counts = new Map<string, number>();
	for (const repo of repos) {
		const name = basename(repo.path);
		counts.set(name, (counts.get(name) ?? 0) + 1);
	}
	return repos.map((repo) => {
		const name = basename(repo.path);
		if ((counts.get(name) ?? 0) < 2) return { ...repo, label: name };
		const parent = basename(dirname(repo.path));
		const qualified = parent && resolve(repo.path) !== root ? `${parent}/${name}` : name;
		return { ...repo, label: qualified };
	});
}

/**
 * Assigns labels across repeated scans, keeping the ones already handed out.
 *
 * Needed because the feed is keyed by label. Re-running the batch `label` on every scan would be correct in
 * isolation and wrong in motion: adding a second `demo` requalifies the *existing* one from `demo` to
 * `acme/demo`, every key belonging to it changes, and its whole history is re-announced as if it had
 * just arrived — a screen full of false arrivals caused by creating an unrelated repo.
 *
 * So the first scan labels the set symmetrically, as before, and later scans only name repos they have not seen
 * before. An incumbent keeps its short name and a newcomer that collides gets qualified, which is asymmetric —
 * but a stable name that is slightly less tidy beats a tidy one that moves under the feed. Restarting
 * normalizes it.
 */
export function createLabeler(root: string): (repos: Repo[]) => Repo[] {
	const assigned = new Map<string, string>();
	const used = new Set<string>();
	let first = true;

	const claim = (repo: Repo): string => {
		const name = basename(repo.path);
		const candidates = [
			name,
			`${basename(dirname(repo.path))}/${name}`,
			relative(root, repo.path) || name
		];
		for (const candidate of candidates) {
			if (candidate && !used.has(candidate)) return candidate;
		}
		// Three collisions is beyond anything real, but a label has to be unique or two repos share a feed.
		let n = 2;
		while (used.has(`${name}~${n}`)) n++;
		return `${name}~${n}`;
	};

	return (repos: Repo[]): Repo[] => {
		// Forget repos that have gone, so a name can be reused by whatever replaces them.
		const present = new Set(repos.map((repo) => repo.path));
		for (const [path, name] of assigned) {
			if (present.has(path)) continue;
			assigned.delete(path);
			used.delete(name);
		}

		if (first) {
			first = false;
			const labeled = label(repos, root);
			for (const repo of labeled) {
				assigned.set(repo.path, repo.label);
				used.add(repo.label);
			}
			return labeled;
		}

		return repos.map((repo) => {
			const held = assigned.get(repo.path);
			if (held) return { ...repo, label: held };
			const name = claim(repo);
			assigned.set(repo.path, name);
			used.add(name);
			return { ...repo, label: name };
		});
	};
}
