/**
 * Cloudflare deploy parsing.
 *
 * The two cases worth guarding are the ones that would go wrong quietly: comment stripping that eats a URL
 * (every wrangler config contains `https://`, and a naive `//` strip truncates the file into something that no
 * longer parses, so the Worker name comes back null and the repo is silently never asked about), and the
 * ordering of `deployments list`, which arrives oldest-first — the opposite of what the feed wants.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
	deployPollInterval,
	isPermanent,
	parseDeployments,
	stripJsonComments,
	workerTargetsFrom,
	hostnameOf,
	isMissingWorker
} from './cloudflare.ts';

/** A resolved production target, as the engine would hand one to the parser. */
const TARGET = {
	worker: 'app',
	env: null,
	hostname: 'app.example.dev',
	routes: ['app.example.dev/*']
};

test('stripJsonComments leaves URLs inside strings alone', () => {
	const config = `{
		// the Worker
		"name": "app",
		"routes": ["https://app.example.dev/*"],
		/* block */
		"vars": { "SITE": "https://example.com//double" }
	}`;

	const parsed = JSON.parse(stripJsonComments(config)) as Record<string, unknown>;
	assert.equal(parsed.name, 'app');
	assert.deepEqual(parsed.routes, ['https://app.example.dev/*']);
	assert.deepEqual(parsed.vars, { SITE: 'https://example.com//double' });
});

test('stripJsonComments respects escaped quotes', () => {
	const text = String.raw`{"a": "say \"hi\" // not a comment", "b": 1}`;
	const parsed = JSON.parse(stripJsonComments(text)) as Record<string, unknown>;
	assert.equal(parsed.a, 'say "hi" // not a comment');
	assert.equal(parsed.b, 1);
});

test('workerTargetsFrom finds the production Worker and the review Worker', () => {
	// The real shape of every Worker config here: two separate Workers, because one Worker serves one version
	// to every route it owns. Reading only the top-level name misses every review deploy.
	const config = `{
	// The template gallery.
	"name": "gallery",
	"routes": [{ "pattern": "gallery.example.dev/*", "zone_name": "example.dev" }],
	"env": {
		"dev": {
			"name": "gallery-dev",
			"routes": [{ "pattern": "gallery-dev.example.dev/*", "zone_name": "example.dev" }]
		}
	}
}`;

	const targets = workerTargetsFrom(config, 'wrangler.jsonc');
	assert.equal(targets.length, 2);
	assert.deepEqual(targets[0], {
		worker: 'gallery',
		env: null,
		hostname: 'gallery.example.dev',
		routes: ['gallery.example.dev/*']
	});
	assert.deepEqual(targets[1], {
		worker: 'gallery-dev',
		env: 'dev',
		hostname: 'gallery-dev.example.dev',
		routes: ['gallery-dev.example.dev/*']
	});
});

test('workerTargetsFrom handles a review hostname that is not derived from the Worker name', () => {
	// example.dev is the case that proves the hostname has to be read rather than guessed: the Worker
	// `example-dev` is production on example.dev, and `example-dev-staging` is review on staging.
	const config = `{
	"name": "example-dev",
	"routes": [
		{ "pattern": "example.dev/*" },
		{ "pattern": "www.example.dev/*" }
	],
	"env": { "dev": { "name": "example-dev-staging", "routes": [{ "pattern": "staging.example.dev/*" }] } }
}`;

	const targets = workerTargetsFrom(config, 'wrangler.jsonc');
	// The first route is the primary hostname; www is a second name for the same site.
	assert.equal(targets[0]?.hostname, 'example.dev');
	assert.equal(targets[0]?.routes.length, 2);
	assert.equal(targets[1]?.worker, 'example-dev-staging');
	assert.equal(targets[1]?.hostname, 'staging.example.dev');
});

test('workerTargetsFrom applies wrangler default naming when an environment does not name itself', () => {
	const config = '{"name": "thing", "env": { "dev": { "routes": ["dev.example.com/*"] } } }';
	const targets = workerTargetsFrom(config, 'wrangler.jsonc');
	assert.equal(targets[1]?.worker, 'thing-dev');
	assert.equal(targets[1]?.hostname, 'dev.example.com');
});

test('workerTargetsFrom takes only the top-level name from a toml config', () => {
	// A durable object binding further down has a name of its own, and querying that Worker would 404.
	const toml =
		'name = "overlay"\nmain = "worker/src/index.ts"\n\n[[durable_objects.bindings]]\nname = "ROOM"\n';
	const targets = workerTargetsFrom(toml, 'wrangler.toml');
	assert.equal(targets.length, 1);
	assert.equal(targets[0]?.worker, 'overlay');
});

test('workerTargetsFrom returns nothing when there is no name to find', () => {
	assert.deepEqual(workerTargetsFrom('{}', 'wrangler.jsonc'), []);
	assert.deepEqual(workerTargetsFrom('not json at all', 'wrangler.jsonc'), []);
	assert.deepEqual(workerTargetsFrom('main = "src/index.ts"', 'wrangler.toml'), []);
});

test('hostnameOf strips the path and keeps a wildcard', () => {
	assert.equal(hostnameOf('gallery-dev.example.dev/*'), 'gallery-dev.example.dev');
	assert.equal(hostnameOf('*.example.dev/*'), '*.example.dev');
	assert.equal(hostnameOf('https://app.example.dev/api/*'), 'app.example.dev');
	// Not a hostname at all.
	assert.equal(hostnameOf('/*'), null);
	assert.equal(hostnameOf(''), null);
});

test('a Worker that has never been deployed is not a broken setup', () => {
	// Exactly what Cloudflare says, verbatim. Treating it as permanent would switch off deploy tracking for
	// every repo because one review environment had not been pushed to yet.
	const message = 'This Worker does not exist on your account. [code: 10007]';
	assert.equal(isMissingWorker(message), true);
	assert.equal(isPermanent(message), false);
});

test('parseDeployments reads a deployment and sorts newest first', () => {
	// Verbatim shape from `wrangler deployments list --json`, in the order it actually arrives: oldest first.
	const json = JSON.stringify([
		{
			id: '11111111-2222-3333-4444-555555555555',
			source: 'wrangler',
			strategy: 'percentage',
			author_email: 'deployer@example.com',
			annotations: { 'workers/triggered_by': 'deployment' },
			versions: [{ version_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', percentage: 100 }],
			created_on: '2026-07-28T22:50:28.293349Z'
		},
		{
			id: 'later-deploy',
			source: 'dash',
			author_email: 'deployer@example.com',
			annotations: { 'workers/triggered_by': 'rollback' },
			versions: [{ version_id: 'ffffffff-0000-0000-0000-000000000000', percentage: 100 }],
			created_on: '2026-07-30T05:38:26.563047Z'
		}
	]);

	const deploys = parseDeployments(json, 'app', TARGET);
	assert.equal(deploys.length, 2);
	// Newest first, which is the reverse of how wrangler returned them.
	assert.equal(deploys[0]?.id, 'later-deploy');
	assert.equal(deploys[0]?.source, 'dash');
	assert.equal(deploys[0]?.triggeredBy, 'rollback');
	assert.equal(deploys[1]?.versionId, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
	assert.equal(deploys[1]?.worker, 'app');
	assert.equal(deploys[1]?.source, 'wrangler');
});

test('parseDeployments drops entries it cannot place in time', () => {
	// Without a usable timestamp a row cannot be positioned on the timeline at all.
	const json = JSON.stringify([
		{ id: 'a', created_on: 'not a date', versions: [] },
		{ id: '', created_on: '2026-07-30T05:00:00Z', versions: [] },
		{ created_on: '2026-07-30T05:00:00Z', versions: [] }
	]);
	assert.deepEqual(parseDeployments(json, 'repo', TARGET), []);
});

test('parseDeployments survives anything that is not the JSON it expected', () => {
	assert.deepEqual(parseDeployments('', 'repo', TARGET), []);
	assert.deepEqual(parseDeployments('wrangler said something else', 'repo', TARGET), []);
	assert.deepEqual(parseDeployments('{"error":"nope"}', 'repo', TARGET), []);
	assert.deepEqual(parseDeployments('[null,1]', 'repo', TARGET), []);
});

test('parseDeployments copes with a deployment that has no versions listed', () => {
	const json = JSON.stringify([
		{ id: 'a', created_on: '2026-07-30T05:00:00Z', source: 'api', versions: [] }
	]);
	const [deploy] = parseDeployments(json, 'repo', TARGET);
	assert.equal(deploy?.versionId, '');
	assert.equal(deploy?.source, 'api');
});

test('the poll interval is slower than the others, and tightens after a commit', () => {
	const now = Date.parse('2026-07-30T05:00:00Z');
	// Each call starts a wrangler — 1.5 seconds of a fresh node process — so the resting rate is low.
	assert.equal(deployPollInterval(now, {}), 180_000);
	assert.equal(deployPollInterval(now, { lastActivityMs: now - 60_000 }), 30_000);
	assert.equal(deployPollInterval(now, { lastActivityMs: now - 3600_000 }), 180_000);
});

test('a logged-out wrangler is permanent; a network blip is not', () => {
	assert.equal(isPermanent('spawn wrangler ENOENT'), true);
	assert.equal(
		isPermanent('In a non-interactive environment, it is mandatory to specify an account ID'),
		true
	);
	assert.equal(isPermanent('Authentication error [code: 10000]'), true);

	assert.equal(isPermanent('fetch failed'), false);
	assert.equal(isPermanent('connect ETIMEDOUT'), false);
});
