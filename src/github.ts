/**
 * Deploys.
 *
 * In this workspace a deploy **is** a GitHub Actions workflow run: pushing a branch triggers the workflow,
 * and the workflow is what runs `wrangler deploy`. So the Actions run is the right thing to watch. Asking
 * Cloudflare directly would report the result of a deploy that succeeded while knowing nothing about one that
 * was attempted — and most failures happen before wrangler is ever reached, in the build or the checks. The
 * failure email that prompted this feature was exactly that case: "Deploy / deploy — Failed in 57 seconds".
 *
 * This is one of the two parts of the program that leave the machine — the other is `cloudflare.ts`, which
 * asks wrangler about Worker deployments. Everything else reads the local disk. Both are treated accordingly.
 *
 * **It asks about as few repositories as possible.** Twenty-three of the repos here have a GitHub remote and
 * only five contain `.github/workflows`. Checking for that directory on disk costs nothing and removes
 * eighteen repositories from every polling round — repositories that would answer with an empty list forever.
 *
 * **It goes through `gh`.** The CLI already holds a token in the keychain, so there is no credential for this
 * program to store, prompt for, or leak into a crash log. If `gh` is missing or logged out, deploy rows are
 * simply absent and the reason is reported once; nothing else degrades.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { sanitize } from './format.ts';
import type { Run } from './types.ts';

const exec = promisify(execFile);

/** Network call, so more generous than the git timeout — but still bounded. */
const TIMEOUT_MS = 20_000;

const FIELDS = [
	'databaseId',
	'name',
	'displayTitle',
	'headBranch',
	'headSha',
	'status',
	'conclusion',
	'event',
	'startedAt',
	'updatedAt',
	'url'
].join(',');

export type RawRun = Omit<Run, 'firstSeen' | 'changedAt' | 'baseline'>;

/**
 * `owner/repo` out of a remote URL, for both forms git uses:
 * `https://github.com/owner/example.dev.git` and `git@github.com:acme/demo.git`.
 *
 * Returns null for anything that is not GitHub, which is how a repo with a GitLab remote, a local remote, or
 * no remote at all opts out of ever being asked about.
 */
export function githubSlug(remoteUrl: string): string | null {
	const url = remoteUrl.trim();
	if (!url) return null;

	// ssh: git@github.com:owner/repo.git — and the ssh:// form, which has a slash instead of a colon.
	const ssh = /^(?:ssh:\/\/)?(?:[^@]+@)?github\.com[:/]+([^/]+)\/(.+?)(?:\.git)?\/?$/.exec(url);
	if (ssh?.[1] && ssh[2]) return `${ssh[1]}/${ssh[2]}`;

	// https: https://github.com/owner/repo.git
	const https = /^https?:\/\/(?:[^@]+@)?github\.com\/([^/]+)\/(.+?)(?:\.git)?\/?$/.exec(url);
	if (https?.[1] && https[2]) return `${https[1]}/${https[2]}`;

	return null;
}

/**
 * Whether this checkout has workflows at all. A local check, so it is free — and it is the filter that keeps
 * the polling round small.
 */
export function hasWorkflows(repoPath: string): boolean {
	return existsSync(join(repoPath, '.github', 'workflows'));
}

/** `gh run list --json` output. Anything malformed is dropped rather than allowed to throw mid-render. */
export function parseRuns(json: string, repo: string): RawRun[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch {
		return [];
	}
	if (!Array.isArray(parsed)) return [];

	const runs: RawRun[] = [];
	for (const entry of parsed) {
		if (!entry || typeof entry !== 'object') continue;
		const row = entry as Record<string, unknown>;
		const id = Number(row.databaseId);
		if (!Number.isFinite(id)) continue;

		const startedAt = String(row.startedAt ?? row.createdAt ?? '');
		const updatedAt = String(row.updatedAt ?? startedAt);
		const status = String(row.status ?? 'unknown');
		// `conclusion` is an empty string while a run is still going, which is not the same as a conclusion
		// of "no result" — null keeps "still running" distinguishable from "finished, outcome unknown".
		const conclusionRaw = row.conclusion == null ? '' : String(row.conclusion);
		const conclusion = conclusionRaw === '' ? null : conclusionRaw;

		const started = Date.parse(startedAt);
		const updated = Date.parse(updatedAt);
		const sha = String(row.headSha ?? '');

		runs.push({
			repo,
			id,
			workflow: sanitize(String(row.name ?? 'workflow')),
			branch: sanitize(String(row.headBranch ?? '')),
			sha,
			short: sha.slice(0, 7),
			title: sanitize(String(row.displayTitle ?? '')),
			event: sanitize(String(row.event ?? '')),
			status,
			conclusion,
			startedAt,
			updatedAt,
			url: String(row.url ?? ''),
			durationMs:
				conclusion && Number.isFinite(started) && Number.isFinite(updated)
					? Math.max(0, updated - started)
					: null
		});
	}
	return runs;
}

export class GitHubError extends Error {}

export async function readRuns(slug: string, repo: string, limit: number): Promise<RawRun[]> {
	try {
		const { stdout } = await exec(
			'gh',
			['run', 'list', '-R', slug, '--limit', String(limit), '--json', FIELDS],
			{
				encoding: 'utf8',
				timeout: TIMEOUT_MS,
				maxBuffer: 4 * 1024 * 1024,
				env: {
					...process.env,
					// A version-update banner on stdout would land in the middle of the JSON.
					GH_NO_UPDATE_NOTIFIER: '1',
					GH_PROMPT_DISABLED: '1',
					GH_PAGER: 'cat',
					NO_COLOR: '1'
				}
			}
		);
		return parseRuns(stdout, repo);
	} catch (error) {
		const err = error as { stderr?: string; message?: string; code?: string };
		const detail = (err.stderr || err.message || 'gh failed').trim().split('\n')[0] ?? 'gh failed';
		// Sanitized: this string is rendered, and gh quotes repository and branch names back at you.
		throw new GitHubError(sanitize(detail));
	}
}

/**
 * Whether a failure means "stop asking" or "ask again later".
 *
 * A missing `gh`, or one that is logged out, will not fix itself while the program runs, and retrying it
 * every twenty seconds across five repos is pointless noise. A timeout or a DNS failure is a laptop that
 * closed its lid, and that does fix itself.
 */
export function isPermanent(message: string): boolean {
	return /ENOENT|not found|command not found|gh auth login|authentication|not logged|Bad credentials|HTTP 401|HTTP 403/i.test(
		message
	);
}

/**
 * How long before asking about a repo again.
 *
 * A run in flight is worth watching closely — it is the case where you are sitting there waiting to see
 * whether the deploy went green, and it typically finishes inside a minute, so it is checked every ten
 * seconds. A repo committed to in the last five minutes is about to have one: every twenty seconds.
 * Everything else is asked once every two minutes, because a deploy nobody triggered is not going to appear.
 */
export function runPollInterval(
	now: number,
	options: { hasActiveRun: boolean; lastActivityMs?: number }
): number {
	if (options.hasActiveRun) return 10_000;
	if (options.lastActivityMs !== undefined && now - options.lastActivityMs < 5 * 60_000)
		return 20_000;
	return 120_000;
}

/** True while a run has not finished. */
export function isActive(run: { status: string; conclusion: string | null }): boolean {
	return run.conclusion === null && run.status !== 'completed';
}
