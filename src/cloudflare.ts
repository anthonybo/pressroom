/**
 * Cloudflare deploys.
 *
 * A GitHub Actions run is not the whole story. Four of the seven Workers here deploy through Actions, and the
 * other three — `overlay`, `app`, `wildcard-worker` — are deployed by running `npm run deploy` on the
 * laptop, which calls `wrangler deploy` directly. Those never touch GitHub, so nothing about them appears in
 * a workflow run and they were entirely invisible to this dashboard.
 *
 * They are also a different *fact* from a workflow run, even where both exist. A green Action says the
 * pipeline finished; a Cloudflare deployment says the Worker version actually changed. A run that succeeds
 * while skipping its deploy step is green and has changed nothing, and only one of those two sources can tell
 * you so. Both are shown.
 *
 * **It uses each project's own wrangler.** Every Worker repo here already has one in `node_modules/.bin`, and
 * using it means pressroom does not depend on wrangler itself, never runs `npx` (which would happily download
 * one), and asks with the same version the project deploys with. A repo without a local wrangler is skipped.
 *
 * **Only `deployments list`.** Read-only, by construction — there is no code path here that can deploy,
 * roll back, or modify anything.
 */
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { sanitize } from './format.ts';
import type { Deploy } from './types.ts';

const exec = promisify(execFile);

/** Wrangler is a heavy start — measured at 1.5 to 1.9 seconds — so this is generous. */
const TIMEOUT_MS = 45_000;

export type RawDeploy = Omit<Deploy, 'firstSeen' | 'baseline'>;

/** The config filenames wrangler looks for, in its own order of preference. */
const CONFIGS = ['wrangler.jsonc', 'wrangler.json', 'wrangler.toml'];

/**
 * Strips `//` and block comments from JSONC without touching the contents of strings.
 *
 * Written as a scanner rather than a regex because a regex cannot tell a comment from a URL: every
 * `"https://…"` in a config contains `//`, and stripping from there to end of line silently truncates the
 * file into something that no longer parses.
 */
export function stripJsonComments(text: string): string {
	let out = '';
	let inString = false;
	let escaped = false;

	for (let i = 0; i < text.length; i++) {
		const char = text[i];

		if (inString) {
			out += char;
			if (escaped) escaped = false;
			else if (char === '\\') escaped = true;
			else if (char === '"') inString = false;
			continue;
		}

		if (char === '"') {
			inString = true;
			out += char;
			continue;
		}
		if (char === '/' && text[i + 1] === '/') {
			while (i < text.length && text[i] !== '\n') i++;
			out += '\n';
			continue;
		}
		if (char === '/' && text[i + 1] === '*') {
			i += 2;
			while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
			i++;
			continue;
		}
		out += char;
	}
	return out;
}

/**
 * Every Worker a repo can deploy, and the hostname each one serves.
 *
 * A repo is not one Worker. The branch decides where a push goes, and that is implemented as **two separate
 * Workers** rather than two variants of one — `gallery` serves `gallery.example.dev` and `gallery-dev`
 * serves `gallery-dev.example.dev`, because one Worker serves one version to every route it owns, and two
 * hostnames showing different builds is not something routes can express.
 *
 * Reading only the top-level `name` therefore misses every review deploy: pushing `dev` deploys a Worker this
 * would never have asked about. Both are returned, and each carries its hostname — which is the thing you
 * actually want to know, because "it went live" means something different for `staging.example.dev` than for
 * `example.dev`.
 */
export type WorkerTarget = {
	worker: string;
	/** Null for the top-level config, otherwise the environment key — `dev`. */
	env: string | null;
	/** The first route's hostname, e.g. `gallery-dev.example.dev`. Null when the config declares none. */
	hostname: string | null;
	routes: string[];
};

/** `gallery-dev.example.dev/*` → `gallery-dev.example.dev`. Wildcards are kept as they are. */
export function hostnameOf(route: string): string | null {
	const pattern = route.trim();
	if (!pattern) return null;
	// A route is a hostname and a path; the path is noise here, and a bare `/*` is not a hostname at all.
	const host = pattern.replace(/^https?:\/\//, '').split('/')[0];
	return host && host.includes('.') ? host : null;
}

function routesOf(config: Record<string, unknown>): string[] {
	const raw = Array.isArray(config.routes)
		? config.routes
		: config.route !== undefined
			? [config.route]
			: [];
	const out: string[] = [];
	for (const entry of raw) {
		if (typeof entry === 'string') out.push(entry);
		else if (entry && typeof entry === 'object') {
			const pattern = (entry as Record<string, unknown>).pattern;
			if (typeof pattern === 'string') out.push(pattern);
		}
	}
	return out;
}

function targetFrom(
	config: Record<string, unknown>,
	fallbackName: string | null,
	env: string | null
): WorkerTarget | null {
	const explicit = typeof config.name === 'string' && config.name ? config.name : null;
	// Wrangler's own default when an environment does not name itself: `<top-level name>-<env>`.
	const worker = explicit ?? (fallbackName && env ? `${fallbackName}-${env}` : fallbackName);
	if (!worker) return null;

	const routes = routesOf(config).map((route) => sanitize(route));
	const hostname = routes.map(hostnameOf).find((host): host is string => Boolean(host)) ?? null;
	return { worker: sanitize(worker), env, hostname, routes };
}

/**
 * The Worker targets declared by a config.
 *
 * TOML gets the top-level Worker only. Enumerating `[env.*]` sections needs a real TOML parser, and every
 * Worker in this workspace uses `wrangler.jsonc`; a TOML repo still gets its production deploys, just not its
 * review ones, which is a documented limit rather than a silent one.
 */
export function workerTargetsFrom(contents: string, filename: string): WorkerTarget[] {
	if (filename.endsWith('.toml')) {
		for (const line of contents.split('\n')) {
			if (/^\s*\[/.test(line)) break;
			const match = /^\s*name\s*=\s*"([^"]+)"/.exec(line);
			if (match?.[1])
				return [{ worker: sanitize(match[1]), env: null, hostname: null, routes: [] }];
		}
		return [];
	}

	let parsed: Record<string, unknown>;
	try {
		parsed = JSON.parse(stripJsonComments(contents)) as Record<string, unknown>;
	} catch {
		return [];
	}

	const top = targetFrom(parsed, null, null);
	if (!top) return [];

	const targets = [top];
	const envs = parsed.env;
	if (envs && typeof envs === 'object') {
		for (const [name, value] of Object.entries(envs as Record<string, unknown>)) {
			if (!value || typeof value !== 'object') continue;
			const target = targetFrom(value as Record<string, unknown>, top.worker, name);
			// A named environment that resolves to the same Worker is the same deploy; do not ask twice.
			if (target && target.worker !== top.worker) targets.push(target);
		}
	}
	return targets;
}

/** The Worker targets for a repo, and the wrangler to ask with. Empty when either is missing. */
export function workersFor(repoPath: string): { targets: WorkerTarget[]; wrangler: string } | null {
	const wrangler = join(repoPath, 'node_modules', '.bin', 'wrangler');
	if (!existsSync(wrangler)) return null;

	for (const filename of CONFIGS) {
		const path = join(repoPath, filename);
		if (!existsSync(path)) continue;
		let contents;
		try {
			contents = readFileSync(path, 'utf8');
		} catch {
			continue;
		}
		const targets = workerTargetsFrom(contents, filename);
		if (targets.length) return { targets, wrangler };
	}
	return null;
}

/**
 * `wrangler deployments list --json`.
 *
 * Two details this has to get right. The list arrives **oldest first** — measured, and the opposite of what a
 * newest-first feed wants, so it is sorted here rather than trusted. And `versions` is an array because a
 * gradual rollout splits traffic across several; the first entry is the one being deployed.
 */
export function parseDeployments(json: string, repo: string, target: WorkerTarget): RawDeploy[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch {
		return [];
	}
	if (!Array.isArray(parsed)) return [];

	const deploys: RawDeploy[] = [];
	for (const entry of parsed) {
		if (!entry || typeof entry !== 'object') continue;
		const row = entry as Record<string, unknown>;
		const id = typeof row.id === 'string' ? row.id : '';
		const at = typeof row.created_on === 'string' ? row.created_on : '';
		if (!id || !at || Number.isNaN(Date.parse(at))) continue;

		const versions = Array.isArray(row.versions) ? row.versions : [];
		const first = (versions[0] ?? {}) as Record<string, unknown>;
		const annotations = (row.annotations ?? {}) as Record<string, unknown>;

		deploys.push({
			repo,
			worker: target.worker,
			env: target.env,
			hostname: target.hostname,
			id,
			versionId: typeof first.version_id === 'string' ? first.version_id : '',
			source: sanitize(String(row.source ?? 'unknown')),
			triggeredBy: sanitize(String(annotations['workers/triggered_by'] ?? '')),
			authorEmail: sanitize(String(row.author_email ?? '')),
			at
		});
	}

	deploys.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
	return deploys;
}

export class CloudflareError extends Error {}

async function run(wrangler: string, args: string[], env: NodeJS.ProcessEnv): Promise<string> {
	const { stdout } = await exec(wrangler, args, {
		encoding: 'utf8',
		timeout: TIMEOUT_MS,
		maxBuffer: 8 * 1024 * 1024,
		env
	});
	return stdout;
}

export async function readDeployments(
	repoPath: string,
	repo: string,
	target: WorkerTarget,
	wrangler: string
): Promise<RawDeploy[]> {
	// `--cwd` so wrangler resolves that project's config, and `--name` so it never has to guess.
	const args = ['deployments', 'list', '--name', target.worker, '--json', '--cwd', repoPath];
	const base: NodeJS.ProcessEnv = {
		...process.env,
		// Wrangler is being asked a question, not run interactively; nothing here should ever prompt.
		WRANGLER_SEND_METRICS: 'false',
		CI: '1',
		NO_COLOR: '1'
	};

	try {
		return parseDeployments(await run(wrangler, args, base), repo, target);
	} catch (error) {
		const first = messageOf(error);

		/**
		 * The documented trap in this workspace, and worth one retry rather than an hour of confusion:
		 * wrangler prefers `CLOUDFLARE_API_TOKEN` over its own OAuth login whenever the variable is set, and
		 * the token kept here does not carry every permission the OAuth session does. When it is set and the
		 * call was refused, the same call is tried once more with the variable removed — which is exactly what
		 * `unset CLOUDFLARE_API_TOKEN` does by hand.
		 */
		if (
			process.env.CLOUDFLARE_API_TOKEN &&
			/7403|10000|authoriz|permission|denied|forbidden|401|403/i.test(first)
		) {
			const withoutToken = { ...base };
			delete withoutToken.CLOUDFLARE_API_TOKEN;
			try {
				return parseDeployments(await run(wrangler, args, withoutToken), repo, target);
			} catch (retry) {
				throw new CloudflareError(messageOf(retry));
			}
		}
		throw new CloudflareError(first);
	}
}

/**
 * The one line of a wrangler failure that says what went wrong.
 *
 * Taking the *first* line is wrong, and wrongly in a way that disabled a whole feature. Wrangler leads with a
 * banner — `A request to the Cloudflare API (/accounts/<id>/workers/scripts/<name>/deployments) failed.` — and
 * puts the reason two lines later. Selecting the banner meant `isMissingWorker` never matched the `[code:
 * 10007]` it exists to detect, so a Worker declared but never deployed was re-queried forever *and* its repo's
 * genuine deploys stopped being announced, because a permanent failure kept the success branch from running.
 *
 * The banner is also the line carrying the account ID, and this string is rendered in the UI. Preferring the
 * coded line fixes the classification and stops publishing an account identifier to the screen at once.
 *
 * Sanitized because wrangler colors its output — so this arrives full of escape sequences even when nothing
 * hostile is happening — and because it quotes paths and Worker names, which are attacker-chosen text.
 */
function messageOf(error: unknown): string {
	const err = error as { stderr?: string; message?: string };
	const text = (err.stderr || err.message || 'wrangler failed').trim();

	const lines = text
		.split('\n')
		.map((line) =>
			sanitize(line)
				.replace(/^[✘▲✔\s]*\[?[a-z]*\]?\s*/i, '')
				.trim()
		)
		.filter((line) => line.length > 3);

	// Cloudflare's numbered reason, when there is one — this is what the classifiers read.
	const coded = lines.find((line) => /\[code:\s*\d+\]/.test(line));
	if (coded) return coded.slice(0, 160);

	// Otherwise the first line that is not the request banner, which names an endpoint rather than a cause.
	const reason = lines.find((line) => !/^A request to the Cloudflare API/i.test(line));
	return (reason ?? lines[0] ?? 'wrangler failed').slice(0, 160);
}

/**
 * A Worker named in a config that has never actually been deployed.
 *
 * Entirely normal — a repo can declare a review environment before anyone has pushed `dev` — and it must not
 * be mistaken for a broken setup. Cloudflare answers `This Worker does not exist on your account [code:
 * 10007]` and wrangler exits 1, which without this check would read as a failure of every Cloudflare deploy
 * and switch the whole feature off.
 */
export function isMissingWorker(message: string): boolean {
	return /10007|does not exist on your account/i.test(message);
}

/**
 * Whether a failure will fix itself. A logged-out wrangler will not; a closed lid will.
 *
 * Deliberately does **not** match a bare "not found": that is what a missing Worker says, and treating it as
 * permanent would disable deploy tracking for every repo because one review Worker had never been deployed.
 */
export function isPermanent(message: string): boolean {
	return /ENOENT|wrangler login|not logged in|account id|authentication|invalid.*token|code: 10000\b/i.test(
		message
	);
}

/**
 * How long before asking about a Worker again.
 *
 * Every call is a wrangler start — a second and a half of a fresh node process — so this is deliberately
 * slower than the Actions poll. A repo committed to in the last five minutes is about to be deployed, and
 * gets asked more often; everything else is asked every three minutes, which for a deploy you did yourself is
 * still well inside the time it takes to go and check the site.
 */
export function deployPollInterval(now: number, options: { lastActivityMs?: number }): number {
	if (options.lastActivityMs !== undefined && now - options.lastActivityMs < 5 * 60_000)
		return 30_000;
	return 180_000;
}
