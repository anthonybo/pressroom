/**
 * How quickly a Cloudflare deploy shows up.
 *
 * The bug this pins: a deploy took three minutes to appear. The poll tiers used the last *commit* date as the
 * signal for "is this repo busy", and a deploy has no particular relationship to a recent commit — the one
 * that prompted this was pushed ten minutes before it was deployed, by which time the repo counted as idle and
 * the interval had relaxed to 180 seconds.
 *
 * A stub wrangler stands in for the real one, so the whole path runs — config parsing, target resolution,
 * invocation, parsing, the store — with no network and without deploying anything to a real site.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { discover } from './discover.ts';
import { Engine } from './engine.ts';

/** A wrangler that prints whatever the fixture file currently holds. */
function stubWrangler(repo: string, deploysFile: string) {
	const bin = join(repo, 'node_modules', '.bin');
	mkdirSync(bin, { recursive: true });
	const script = join(bin, 'wrangler');
	writeFileSync(script, `#!/bin/sh\ncat ${JSON.stringify(deploysFile)}\n`);
	chmodSync(script, 0o755);
}

function deployment(id: string, at: string) {
	return {
		id,
		source: 'wrangler',
		author_email: 'a@b',
		annotations: { 'workers/triggered_by': 'deployment' },
		versions: [{ version_id: `${id}-version`, percentage: 100 }],
		created_on: at
	};
}

async function waitFor(predicate: () => boolean, timeoutMs: number, what: string) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return Date.now();
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
}

test('a deploy from this laptop appears at once, not on the next poll', async (t) => {
	const root = mkdtempSync(join(tmpdir(), 'pressroom-deploywatch-'));
	t.after(() => rmSync(root, { recursive: true, force: true }));

	const repo = join(root, 'site');
	mkdirSync(repo, { recursive: true });
	execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
	writeFileSync(join(repo, 'a.txt'), 'x\n');
	execFileSync('git', ['add', '.'], { cwd: repo });
	execFileSync(
		'git',
		['-c', 'user.name=T', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'Old commit'],
		{ cwd: repo }
	);
	// Backdate the commit well past the "recently active" window, which is exactly the state the real repo was
	// in: quiet for long enough that the poll had relaxed to three minutes.
	const old = new Date(Date.now() - 60 * 60_000);
	execFileSync(
		'git',
		[
			'-c',
			'user.name=T',
			'-c',
			'user.email=t@t',
			'commit',
			'-q',
			'--amend',
			'--no-edit',
			'--date',
			old.toISOString()
		],
		{ cwd: repo, env: { ...process.env, GIT_COMMITTER_DATE: old.toISOString() } }
	);

	writeFileSync(
		join(repo, 'wrangler.jsonc'),
		'{ "name": "site", "routes": ["site.example.com/*"] }'
	);
	const deploys = join(root, 'deploys.json');
	writeFileSync(deploys, JSON.stringify([deployment('first', '2026-08-01T08:00:00Z')]));
	stubWrangler(repo, deploys);
	// `.wrangler` is what wrangler touches as it deploys, and what the watch is armed on.
	mkdirSync(join(repo, '.wrangler', 'tmp'), { recursive: true });

	const engine = new Engine(discover(root), { limit: 20 });
	t.after(() => engine.stop());

	let snapshot = engine.snapshot();
	engine.subscribe((next) => {
		snapshot = next;
	});
	engine.start();

	await waitFor(() => snapshot.deploys.length === 1, 15_000, 'the first Cloudflare read');
	assert.equal(snapshot.cloudflareError, null);

	// Now deploy: the deployment list gains an entry, and `.wrangler` is touched, exactly as wrangler does it.
	writeFileSync(
		deploys,
		JSON.stringify([
			deployment('first', '2026-08-01T08:00:00Z'),
			deployment('second', '2026-08-01T08:24:44Z')
		])
	);
	const deployedAt = Date.now();
	const marker = join(repo, '.wrangler', 'tmp');
	utimesSync(marker, new Date(), new Date());
	writeFileSync(join(repo, '.wrangler', 'tmp', 'deploy-marker'), 'x');

	const seenAt = await waitFor(
		() => snapshot.deploys.length === 2,
		20_000,
		'the new deploy to be noticed'
	);

	const latency = seenAt - deployedAt;
	assert.ok(
		latency < 15_000,
		`expected the watch to notice inside 15s, took ${latency}ms — if this is near 180000ms the .wrangler watch is dead and the idle poll is covering for it`
	);
	assert.equal(snapshot.deploys[0]?.versionId, 'second-version');
});

test('a finished workflow run triggers the Cloudflare check that follows it', async (t) => {
	const root = mkdtempSync(join(tmpdir(), 'pressroom-cideploy-'));
	t.after(() => rmSync(root, { recursive: true, force: true }));

	const repo = join(root, 'ci-site');
	mkdirSync(join(repo, '.github', 'workflows'), { recursive: true });
	writeFileSync(join(repo, '.github', 'workflows', 'deploy.yml'), 'name: Deploy\n');
	execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
	execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/acme/ci-site.git'], {
		cwd: repo
	});
	writeFileSync(join(repo, 'a.txt'), 'x\n');
	execFileSync('git', ['add', '.'], { cwd: repo });
	const old = new Date(Date.now() - 60 * 60_000).toISOString();
	execFileSync(
		'git',
		['-c', 'user.name=T', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'Old commit'],
		{ cwd: repo, env: { ...process.env, GIT_AUTHOR_DATE: old, GIT_COMMITTER_DATE: old } }
	);

	writeFileSync(
		join(repo, 'wrangler.jsonc'),
		'{ "name": "ci-site", "routes": ["ci.example.com/*"] }'
	);
	const deploys = join(root, 'deploys.json');
	writeFileSync(deploys, JSON.stringify([deployment('before', '2026-08-01T08:00:00Z')]));
	stubWrangler(repo, deploys);

	// A `gh` on PATH that reports whatever the runs fixture holds. `readRuns` resolves `gh` from PATH, so the
	// whole GitHub path runs — slug resolution, invocation, parsing — without a network or an account.
	const runsFile = join(root, 'runs.json');
	const inProgress = [
		{
			databaseId: 1,
			name: 'Deploy',
			displayTitle: 'Deploy',
			headBranch: 'main',
			headSha: 'a'.repeat(40),
			status: 'in_progress',
			conclusion: '',
			event: 'workflow_dispatch',
			startedAt: '2026-08-01T08:20:00Z',
			updatedAt: '2026-08-01T08:20:00Z',
			url: 'https://example.com/1'
		}
	];
	writeFileSync(runsFile, JSON.stringify(inProgress));
	const fakeBin = join(root, 'bin');
	mkdirSync(fakeBin, { recursive: true });
	writeFileSync(join(fakeBin, 'gh'), `#!/bin/sh\ncat ${JSON.stringify(runsFile)}\n`);
	chmodSync(join(fakeBin, 'gh'), 0o755);
	const realPath = process.env.PATH;
	process.env.PATH = `${fakeBin}:${realPath}`;
	t.after(() => {
		process.env.PATH = realPath;
	});

	const engine = new Engine(discover(root), { limit: 20 });
	t.after(() => engine.stop());

	let snapshot = engine.snapshot();
	engine.subscribe((next) => {
		snapshot = next;
	});
	engine.start();

	await waitFor(() => snapshot.runs.length === 1, 15_000, 'the run to be read');
	await waitFor(() => snapshot.deploys.length === 1, 15_000, 'the first Cloudflare read');

	// The run finishes, and the deployment it performed now exists. Nothing touched `.wrangler` — this happened
	// on a runner — so the only thing that can shorten the wait is the run's own completion.
	writeFileSync(
		runsFile,
		JSON.stringify([{ ...inProgress[0], status: 'completed', conclusion: 'success' }])
	);
	writeFileSync(
		deploys,
		JSON.stringify([
			deployment('before', '2026-08-01T08:00:00Z'),
			deployment('after-ci', '2026-08-01T08:24:00Z')
		])
	);
	const finishedAt = Date.now();

	const seenAt = await waitFor(
		() => snapshot.deploys.length === 2,
		30_000,
		'the deploy to follow the run'
	);
	assert.ok(
		seenAt - finishedAt < 25_000,
		`expected the finished run to pull the Cloudflare check forward, took ${seenAt - finishedAt}ms`
	);
	assert.equal(snapshot.deploys[0]?.versionId, 'after-ci-version');
});

test('--local reads git and touches nothing off the machine', async (t) => {
	/*
	 * Several of these run at once, in different terminals, and the network half is what multiplies: each
	 * instance runs its own wrangler — a fresh node process, ~1.7s, two at a time — and every instance spends
	 * from the same GitHub token's rate limit. A secondary session that only wants to watch commits land
	 * should cost nothing but its own git reads.
	 *
	 * The stubs here would answer instantly if they were called at all, so an empty result is proof the
	 * pollers never ran rather than proof they were slow.
	 */
	const root = mkdtempSync(join(tmpdir(), 'pressroom-local-'));
	t.after(() => rmSync(root, { recursive: true, force: true }));

	const repo = join(root, 'site');
	mkdirSync(join(repo, '.github', 'workflows'), { recursive: true });
	writeFileSync(join(repo, '.github', 'workflows', 'deploy.yml'), 'name: Deploy\n');
	execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
	execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/acme/site.git'], {
		cwd: repo
	});
	writeFileSync(join(repo, 'a.txt'), 'x\n');
	execFileSync('git', ['add', '.'], { cwd: repo });
	execFileSync(
		'git',
		['-c', 'user.name=T', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'A local commit'],
		{ cwd: repo }
	);

	writeFileSync(
		join(repo, 'wrangler.jsonc'),
		'{ "name": "site", "routes": ["site.example.com/*"] }'
	);
	const deploys = join(root, 'deploys.json');
	writeFileSync(deploys, JSON.stringify([deployment('would-appear', '2026-08-01T08:00:00Z')]));
	stubWrangler(repo, deploys);
	mkdirSync(join(repo, '.wrangler'), { recursive: true });

	const runsFile = join(root, 'runs.json');
	writeFileSync(
		runsFile,
		JSON.stringify([
			{
				databaseId: 7,
				name: 'Deploy',
				displayTitle: 'Deploy',
				headBranch: 'main',
				headSha: 'b'.repeat(40),
				status: 'completed',
				conclusion: 'success',
				event: 'push',
				startedAt: '2026-08-01T08:00:00Z',
				updatedAt: '2026-08-01T08:01:00Z',
				url: 'https://example.com/7'
			}
		])
	);
	const fakeBin = join(root, 'bin');
	mkdirSync(fakeBin, { recursive: true });
	writeFileSync(join(fakeBin, 'gh'), `#!/bin/sh\ncat ${JSON.stringify(runsFile)}\n`);
	chmodSync(join(fakeBin, 'gh'), 0o755);
	const realPath = process.env.PATH;
	process.env.PATH = `${fakeBin}:${realPath}`;
	t.after(() => {
		process.env.PATH = realPath;
	});

	const engine = new Engine(discover(root), { limit: 20, local: true });
	t.after(() => engine.stop());

	let snapshot = engine.snapshot();
	engine.subscribe((next) => {
		snapshot = next;
	});
	engine.start();

	// The local half works.
	await waitFor(() => snapshot.feed.length === 1, 15_000, 'the commit to be read');
	assert.equal(snapshot.feed[0]?.subject, 'A local commit');
	assert.equal(
		snapshot.local,
		true,
		'the header needs this, or a local session looks like a dead one'
	);

	// Long enough that both pollers would have fired several times over — the GitHub tier is 20s at its
	// slowest for a repo this fresh, and Cloudflare is 30s.
	await new Promise((resolve) => setTimeout(resolve, 8000));

	assert.equal(snapshot.runs.length, 0, 'no workflow runs may be fetched');
	assert.equal(snapshot.deploys.length, 0, 'no Cloudflare deployments may be fetched');
	assert.equal(snapshot.githubError, null);
	assert.equal(snapshot.cloudflareError, null);
});
