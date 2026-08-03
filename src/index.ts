#!/usr/bin/env node
/**
 * Entry point. Works out what to watch, then hands over to ink.
 *
 * The root defaults to the directory this project sits in — `~/projects/pressroom` means `~/projects` — so
 * it watches its siblings, and itself, with no configuration. Paths can be given as arguments to watch
 * something else, and `--list` prints what a scan found and exits, which is the quick way to confirm that
 * the nested repos inside a grouping folder were picked up.
 *
 * **This file contains no JSX, and imports neither ink nor React.** That is load-bearing.
 *
 * React chooses which build of itself to use by reading `process.env.NODE_ENV` when it is first imported,
 * and its development build reports to the User Timing API on every render — entries Node buffers for the
 * life of the process, which crashed this program with a four-gigabyte heap after about three hours of
 * watching. Setting `NODE_ENV` here fixes it, but only while nothing has already pulled React in: ES module
 * imports are hoisted and run before any statement in the file, and one piece of JSX is enough to add a
 * hoisted import of `react/jsx-runtime`. So the assignment happens first and the UI arrives afterwards,
 * through a dynamic `import()` of `run.tsx`.
 */
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { createLabeler, discover, DEFAULT_MAX_DEPTH, resolveGitDir } from './discover.ts';
import type { Repo, Scope } from './types.ts';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

type Options = {
	roots: string[];
	depth: number;
	scope: Scope;
	limit: number;
	list: boolean;
	help: boolean;
	/** Commits and pushes only — no `gh`, no `wrangler`, nothing off this machine. */
	local: boolean;
};

function parse(argv: string[]): Options {
	const options: Options = {
		roots: [],
		depth: DEFAULT_MAX_DEPTH,
		scope: 'branches',
		limit: 40,
		list: false,
		help: false,
		local: false
	};

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (!arg) continue;
		if (arg === '--list' || arg === '-l') options.list = true;
		else if (arg === '--help' || arg === '-h') options.help = true;
		else if (arg === '--local') options.local = true;
		else if (arg === '--depth') options.depth = Number(argv[++i] ?? options.depth);
		else if (arg === '--limit') options.limit = Number(argv[++i] ?? options.limit);
		else if (arg === '--scope') {
			const value = argv[++i];
			if (value === 'branches' || value === 'head' || value === 'all') options.scope = value;
		} else if (!arg.startsWith('-')) options.roots.push(arg);
	}
	return options;
}

const USAGE = `
  pressroom — every commit, push and deploy landing across your projects, live

    pressroom                 watch ${'`'}~/projects${'`'} and everything nested inside it
    pressroom --list          print the repos a scan finds, then exit
    pressroom ~/work ~/side   watch specific directories instead
    pressroom --local         commits and pushes only — no network, cheap to run several of
    pressroom --depth 5       look deeper for nested repos (default ${DEFAULT_MAX_DEPTH})
    pressroom --limit 80      commits read per repo (default 40)
    pressroom --scope all     include remote-tracking refs

  ${'`'}npm start -- <flags>${'`'} works too, from the project directory. ${'`'}npm link${'`'} once and the
  ${'`'}pressroom${'`'} command works from anywhere.

  Press ? inside for the keys.
`;

const options = parse(process.argv.slice(2));

if (options.help) {
	console.log(USAGE);
	process.exit(0);
}

/**
 * The scan root. `~/projects/pressroom` watching `~/projects` is the intended arrangement, so the default
 * is one level up from this project — but only when that looks like a directory of projects rather than
 * somewhere it was copied to.
 */
function defaultRoots(): string[] {
	const fromEnv = process.env.PRESSROOM_ROOT;
	if (fromEnv) return [resolve(fromEnv)];

	const parent = dirname(PROJECT_ROOT);
	if (existsSync(parent)) return [parent];
	return [resolve(homedir(), 'projects')];
}

const roots = (options.roots.length ? options.roots : defaultRoots()).map((path) => resolve(path));

/**
 * One scan of every root, labelled.
 *
 * Called again on a timer while running, because new repos appear constantly here — spinning up a client *is*
 * creating a repo — and a set fixed at launch means the newest project is the one thing the dashboard cannot
 * see. Measured at 12ms for thirty repos.
 */
function scan(): Repo[] {
	const found: Repo[] = [];
	const seen = new Set<string>();
	for (const root of roots) {
		if (!existsSync(root)) continue;
		// A root that is itself a repo is watched directly, so `pressroom .` inside one project works.
		const direct = resolveGitDir(root);
		const here = direct
			? [
					{
						label: '',
						path: root,
						gitDir: direct.gitDir,
						commonDir: direct.commonDir,
						relPath: root
					}
				]
			: discover(root, options.depth);
		for (const repo of here) {
			if (seen.has(repo.path)) continue;
			seen.add(repo.path);
			found.push(repo);
		}
	}
	// Labels are assigned across the combined set, so two repos of the same name from two different roots are
	// still told apart — and stay told apart the same way on every later scan.
	return relabel(found);
}

for (const root of roots) {
	if (existsSync(root)) continue;
	console.error(`pressroom: ${root} does not exist`);
	process.exit(1);
}

const relabel = createLabeler(roots[0] ?? PROJECT_ROOT);
const labeled = scan();

if (!labeled.length) {
	console.error(`pressroom: no git repositories found under ${roots.join(', ')}`);
	console.error(
		`  try --depth ${options.depth + 2}, or pass the directories to watch as arguments`
	);
	process.exit(1);
}

if (options.list) {
	console.log(`\n  ${labeled.length} repositories under ${roots.join(', ')}\n`);
	const width = Math.max(...labeled.map((repo) => repo.label.length));
	for (const repo of labeled) {
		console.log(`  ${repo.label.padEnd(width)}  ${repo.relPath}`);
	}
	console.log('');
	process.exit(0);
}

if (!process.stdin.isTTY) {
	console.error('pressroom: needs an interactive terminal (stdin is not a TTY)');
	console.error('  --list works without one');
	process.exit(1);
}

/**
 * Production React, unless the environment insists otherwise. Set before `run.tsx` is imported, because that
 * import is what loads React — see the note at the top of this file.
 */
process.env.NODE_ENV ??= 'production';

const { start } = await import('./run.tsx');
start(labeled, shorten(roots), {
	limit: options.limit,
	scope: options.scope,
	rediscover: scan,
	local: options.local
});

/** `~/projects` reads better than the full home path in a header with a row to spare. */
function shorten(paths: string[]): string {
	const home = homedir();
	return paths
		.map((path) => (path.startsWith(home) ? `~${path.slice(home.length)}` : path))
		.join(' ');
}
