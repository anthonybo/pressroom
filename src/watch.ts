/**
 * Noticing that something happened.
 *
 * The point of this program is that a commit appears without being asked for, which means polling
 * every repository is the fallback, not the mechanism. `fs.watch` gives sub-second notice; the
 * poll exists because `fs.watch` cannot be trusted alone.
 *
 * **Watch directories, never ref files.** git updates a ref by writing `refs/heads/main.lock` and renaming
 * it over the target. A watch registered on the path `refs/heads/main` is a watch on that *inode*, and
 * after the first commit the inode it is holding has been replaced and unlinked — the watch stays open,
 * reports nothing, and looks exactly like a repo where nobody is working. Watching the containing directory
 * survives the rename, because the directory is the thing being modified.
 *
 * **Watch several places.** A commit on a branch touches `logs/HEAD`, `logs/refs/heads/<branch>`,
 * `refs/heads/<branch>`, `index` and `COMMIT_EDITMSG`. Any one of them is enough, and they are watched
 * together because each has a case where it is the only one: `refs/heads` is untouched when the ref is
 * packed, and `logs/` does not exist at all in a repo with reflogs disabled.
 *
 * **Then poll anyway.** Editors, network filesystems and `git gc` all have ways of producing changes that
 * FSEvents coalesces or drops. A slow poll — very slow for repos last touched years ago — costs almost
 * nothing and turns a missed event into a few seconds of delay instead of a row that never updates.
 */
import { watch, type FSWatcher } from 'node:fs';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Repo } from './types.ts';

/**
 * A commit produces a burst of filesystem events. This collects them into one refresh, and is short enough
 * that the commit still feels instant.
 */
const DEBOUNCE_MS = 120;

export type WatchHandle = { close(): void };

export function watchRepo(repo: Repo, onChange: () => void): WatchHandle {
	let timer: NodeJS.Timeout | null = null;
	let closed = false;

	const fire = () => {
		if (closed) return;
		if (timer) clearTimeout(timer);
		timer = setTimeout(() => {
			timer = null;
			if (!closed) onChange();
		}, DEBOUNCE_MS);
	};

	const watchers: FSWatcher[] = [];
	const add = (path: string, recursive: boolean) => {
		if (!existsSync(path)) return;
		try {
			// `persistent: false` so these watchers alone never hold the process open. The UI's stdin does
			// that, and a dashboard that cannot be closed because of a file watcher is a bad dashboard.
			watchers.push(watch(path, { persistent: false, recursive }, fire));
		} catch {
			// A repo can be deleted or replaced while this runs. The poll will pick up whatever is there.
		}
	};

	// The git dir itself, non-recursively: catches HEAD, index, COMMIT_EDITMSG, ORIG_HEAD, packed-refs.
	// Not recursive, because that would mean watching `objects/`, which receives an event per written
	// object — thousands during a fetch, for no extra information.
	add(repo.gitDir, false);

	// Refs and reflogs, recursively, because a branch named `feature/x` is a directory named `feature`.
	for (const dir of new Set([repo.gitDir, repo.commonDir])) {
		add(join(dir, 'refs', 'heads'), true);
		add(join(dir, 'logs'), true);
	}

	return {
		close() {
			closed = true;
			if (timer) clearTimeout(timer);
			for (const watcher of watchers) {
				try {
					watcher.close();
				} catch {
					// Already gone.
				}
			}
			watchers.length = 0;
		}
	};
}

/**
 * How often to poll a repo, from how recently it last received a commit.
 *
 * Most of this account is archive: repos last touched a year or more ago, which do not need checking every
 * few seconds. The one being worked on right now does. Tiering by recency keeps the total work low without
 * making the active repo feel slow — and `fs.watch` still reports anything in any of them immediately, so
 * these intervals only decide how long a *missed* event goes unnoticed.
 */
export function pollInterval(nowMs: number, lastCommitMs: number | undefined): number {
	if (lastCommitMs === undefined) return 60_000;
	const age = nowMs - lastCommitMs;
	if (age < 60 * 60 * 1000) return 3_000;
	if (age < 24 * 60 * 60 * 1000) return 15_000;
	if (age < 30 * 24 * 60 * 60 * 1000) return 60_000;
	return 300_000;
}

/**
 * Watches one directory, if it is there.
 *
 * Used for a repo's `.wrangler`, which `wrangler deploy` touches as it runs — measured at three seconds
 * before the deployment Cloudflare records. That makes a laptop deploy something to be *told* about rather
 * than polled for, which is the difference between a row appearing at once and appearing up to three minutes
 * later.
 */
export function watchDir(path: string, onChange: () => void): WatchHandle | null {
	if (!existsSync(path)) return null;

	let timer: NodeJS.Timeout | null = null;
	let closed = false;
	let watcher: FSWatcher;
	try {
		watcher = watch(path, { persistent: false, recursive: true }, () => {
			if (closed) return;
			if (timer) clearTimeout(timer);
			timer = setTimeout(() => {
				timer = null;
				if (!closed) onChange();
			}, DEBOUNCE_MS);
		});
	} catch {
		return null;
	}

	return {
		close() {
			closed = true;
			if (timer) clearTimeout(timer);
			try {
				watcher.close();
			} catch {
				// Already gone.
			}
		}
	};
}
