/**
 * Builds a workspace of invented repositories and runs pressroom against it.
 *
 *   npm run demo              build if needed, then launch
 *   npm run demo -- --rebuild start the fixture again from scratch
 *   npm run demo -- --frame   print one rendered frame and exit
 *
 * Two jobs. It lets anyone try this without pointing it at their own work — which otherwise means the first
 * thing a stranger does is aim an unfamiliar program at every repository they own. And it is where the sample
 * output in the README comes from: rendered from this fixture rather than typed by hand, so the columns line up
 * because they were produced by the same code that draws them, and no real project is named.
 *
 * The fixture includes stub `gh` and `wrangler` executables on PATH, so workflow runs and Cloudflare deploys
 * appear too. Nothing here reaches the network and nothing outside `.demo/` is touched.
 */
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEMO = join(ROOT, '.demo');
const WORK = join(DEMO, 'workspace');
const BIN = join(DEMO, 'bin');

const REBUILD = process.argv.includes('--rebuild');
const FRAME = process.argv.includes('--frame');
const SHOT = process.argv.includes('--screenshot');

/**
 * Anchored to when the fixture is built, not to a fixed date.
 *
 * A hard-coded date was the first attempt, and it produced a screen where every row read "now": the date was
 * in the future, and an age is clamped rather than shown as negative. Building relative to the present gives
 * the spread of ages the display is actually for.
 */
const START = Date.now();
const ago = (minutes) => new Date(START - minutes * 60_000).toISOString();

const AUTHORS = [
	['Ada W.', 'ada@example.com'],
	['Rune O.', 'rune@example.com'],
	['Mira K.', 'mira@example.com']
];

function git(cwd, args, env = {}) {
	execFileSync('git', args, { cwd, stdio: 'pipe', env: { ...process.env, ...env } });
}

function commit(repo, { file, body, message, minutes, author = 0 }) {
	// `file` may name a subdirectory, so make it rather than requiring every caller to remember.
	mkdirSync(dirname(join(repo, file)), { recursive: true });
	writeFileSync(join(repo, file), body);
	git(repo, ['add', file]);
	const [name, email] = AUTHORS[author % AUTHORS.length];
	git(repo, ['commit', '-q', '-m', message], {
		GIT_AUTHOR_NAME: name,
		GIT_AUTHOR_EMAIL: email,
		GIT_COMMITTER_NAME: name,
		GIT_COMMITTER_EMAIL: email,
		GIT_AUTHOR_DATE: ago(minutes),
		GIT_COMMITTER_DATE: ago(minutes)
	});
}

function repo(path, branch = 'main') {
	mkdirSync(path, { recursive: true });
	git(path, ['init', '-q', '-b', branch]);
	git(path, ['config', 'user.name', 'Ada W.']);
	git(path, ['config', 'user.email', 'ada@example.com']);
	return path;
}

/** A stub executable that prints a fixed payload, standing in for a real CLI. */
function stub(name, payload) {
	mkdirSync(BIN, { recursive: true });
	const data = join(BIN, `${name}.json`);
	writeFileSync(data, payload);
	const script = join(BIN, name);
	writeFileSync(script, `#!/bin/sh\ncat ${JSON.stringify(data)}\n`);
	chmodSync(script, 0o755);
}

function build() {
	rmSync(DEMO, { recursive: true, force: true });
	mkdirSync(WORK, { recursive: true });

	// A busy repo with several authors, so the author column earns its place.
	const atlas = repo(join(WORK, 'atlas'));
	commit(atlas, { file: 'README.md', body: '# atlas\n', message: 'Start the atlas service', minutes: 640 });
	commit(atlas, {
		file: 'src/tiles.ts',
		body: 'export const tiles = 256;\n',
		message: 'Serve tiles at 256px, not 512 — the client only ever asks for one size',
		minutes: 96,
		author: 1
	});
	commit(atlas, {
		file: 'src/cache.ts',
		body: 'export const ttl = 3600;\n',
		message: 'Cache tiles for an hour; the source data updates daily',
		minutes: 34,
		author: 2
	});

	// Deployed by hand, so it shows a Cloudflare row and no workflow run.
	const beacon = repo(join(WORK, 'beacon'));
	writeFileSync(
		join(beacon, 'wrangler.jsonc'),
		'{\n\t// The status page.\n\t"name": "beacon",\n\t"routes": ["beacon.example.dev/*"]\n}\n'
	);
	git(beacon, ['add', '.']);
	git(beacon, ['commit', '-q', '-m', 'Add the Worker config'], {
		GIT_AUTHOR_DATE: ago(300),
		GIT_COMMITTER_DATE: ago(300)
	});
	commit(beacon, {
		file: 'src/index.ts',
		body: 'export default { fetch: () => new Response("ok") };\n',
		message: 'Return a plain ok rather than JSON — the checker only reads the status',
		minutes: 21
	});
	mkdirSync(join(beacon, '.wrangler', 'tmp'), { recursive: true });

	// Pushed to a real bare remote, so the push rows come from an actual reflog.
	const bare = join(DEMO, 'remotes', 'citrine.git');
	mkdirSync(bare, { recursive: true });
	git(bare, ['init', '-q', '--bare', '-b', 'main']);
	const citrine = repo(join(WORK, 'citrine'));
	commit(citrine, { file: 'index.html', body: '<h1>citrine</h1>\n', message: 'First pass at the landing page', minutes: 180 });
	git(citrine, ['remote', 'add', 'origin', bare]);
	git(citrine, ['push', '-q', '-u', 'origin', 'main']);
	commit(citrine, {
		file: 'style.css',
		body: 'body { font: 16px/1.5 system-ui; }\n',
		message: 'Set the body size to 16px so iOS stops zooming the form',
		minutes: 12,
		author: 1
	});
	git(citrine, ['push', '-q', 'origin', 'main']);

	// A grouping folder that is not itself a repo — the nested-discovery case.
	const clients = join(WORK, 'clients');
	const northwind = repo(join(clients, 'northwind'), 'main');
	writeFileSync(
		join(northwind, 'wrangler.jsonc'),
		'{\n\t"name": "site-northwind",\n\t"routes": ["northwind.example.dev/*"],\n\t"env": { "dev": { "name": "site-northwind-dev", "routes": ["northwind-dev.example.dev/*"] } }\n}\n'
	);
	mkdirSync(join(northwind, '.github', 'workflows'), { recursive: true });
	writeFileSync(join(northwind, '.github', 'workflows', 'deploy.yml'), 'name: Deploy\n');
	git(northwind, ['add', '.']);
	git(northwind, ['commit', '-q', '-m', 'Wire the deploy workflow'], {
		GIT_AUTHOR_DATE: ago(420),
		GIT_COMMITTER_DATE: ago(420)
	});
	git(northwind, ['remote', 'add', 'origin', 'https://github.com/acme/northwind.git']);
	commit(northwind, {
		file: 'content.ts',
		body: 'export const phone = "(555) 0100";\n',
		message: 'Correct the phone number — the old one reached a disconnected line',
		minutes: 8,
		author: 2
	});
	// Uncommitted work, so the panel shows the changed and untracked counts.
	writeFileSync(join(northwind, 'content.ts'), 'export const phone = "(555) 0142";\n');
	writeFileSync(join(northwind, 'notes.md'), 'ask about the hours\n');

	const sunspot = repo(join(clients, 'sunspot'), 'redesign');
	commit(sunspot, { file: 'index.html', body: '<h1>sunspot</h1>\n', message: 'Rebuild the gallery on a grid', minutes: 55 });

	// Stub CLIs. The run is failing on purpose: a red row is the one worth seeing.
	stub(
		'gh',
		JSON.stringify([
			{
				databaseId: 4021,
				name: 'Deploy',
				displayTitle: 'Correct the phone number',
				headBranch: 'main',
				headSha: 'f3c1d90b7a52e4416d8ab0c9e7f25d3418ba6c07',
				status: 'completed',
				conclusion: 'failure',
				event: 'push',
				startedAt: ago(7),
				updatedAt: ago(6),
				url: 'https://github.com/acme/northwind/actions/runs/4021'
			},
			{
				databaseId: 4018,
				name: 'Deploy',
				displayTitle: 'Wire the deploy workflow',
				headBranch: 'main',
				headSha: 'a71e5c2f8d4b93061fe2a8c7d05b41396fa2e8d1',
				status: 'completed',
				conclusion: 'success',
				event: 'push',
				startedAt: ago(418),
				updatedAt: ago(417),
				url: 'https://github.com/acme/northwind/actions/runs/4018'
			}
		])
	);
	stub(
		'wrangler',
		JSON.stringify([
			{
				id: '9f1c77e0-3b52-4a18-9d64-0c7ea51b8f23',
				source: 'wrangler',
				author_email: 'ada@example.com',
				annotations: { 'workers/triggered_by': 'deployment' },
				versions: [{ version_id: '3d5b81aa-6c04-4e7f-b219-58cf0a7d4e16', percentage: 100 }],
				created_on: ago(19)
			}
		])
	);
	// Both Worker repos need a local wrangler for the Cloudflare read to be attempted at all.
	for (const path of [join(WORK, 'beacon'), join(clients, 'northwind')]) {
		const nm = join(path, 'node_modules', '.bin');
		mkdirSync(nm, { recursive: true });
		writeFileSync(join(nm, 'wrangler'), `#!/bin/sh\nexec ${JSON.stringify(join(BIN, 'wrangler'))} "$@"\n`);
		chmodSync(join(nm, 'wrangler'), 0o755);
	}

	console.log(`  built a workspace of five invented repositories in ${DEMO.slice(ROOT.length + 1)}/`);
}

if (REBUILD || !existsSync(WORK)) build();

const env = {
	...process.env,
	PRESSROOM_ROOT: WORK,
	PRESSROOM_ROOT_LABEL: '~/projects',
	PATH: `${BIN}:${process.env.PATH}`,
	FORCE_COLOR: '3',
	COLORTERM: 'truecolor'
};

const target = SHOT
	? [join(ROOT, 'scripts', 'screenshot.tsx')]
	: FRAME
		? [join(ROOT, 'scripts', 'frames.tsx'), '--cols', '104', '--rows', '22', '--wait', '9000']
		: [join(ROOT, 'src', 'index.ts')];

const result = spawnSync(join(ROOT, 'node_modules', '.bin', 'tsx'), target, {
	stdio: 'inherit',
	env
});
process.exit(result.status ?? 0);
