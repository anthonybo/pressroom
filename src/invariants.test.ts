/**
 * The settings that are only correct because someone made them correct.
 *
 * Everything else in this suite tests behavior you can see. These six are different: each is a single line
 * that looks arbitrary, removable, or like leftover boilerplate, and each has a failure mode that is either
 * silent or takes hours to appear. They were guarded by nothing but a comment, which is no guard at all
 * against a tidy-up — so they are asserted here, with the consequence written next to each one.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { queuesFollowUp } from './engine.ts';
import { gitEnv } from './git.ts';
import { clearPerformanceTimeline } from './housekeeping.ts';

const SRC = dirname(fileURLToPath(import.meta.url));

test('every git call runs with the three settings that make its output trustworthy', () => {
	const env = gitEnv({ PATH: '/usr/bin', LC_ALL: 'de_DE.UTF-8', GIT_OPTIONAL_LOCKS: '1' });

	// Without this, `status` takes `index.lock` to write back a refreshed index, and a dashboard polling
	// thirty repos will eventually hold it at the moment you run `git commit` — an error that looks exactly
	// like your own git breaking.
	assert.equal(env.GIT_OPTIONAL_LOCKS, '0');

	// `--shortstat` prints a *translated* sentence. On a localized git the parser matches nothing and every
	// commit silently reports as having changed no files — the worst kind of failure, because it looks like
	// data rather than like a bug.
	assert.equal(env.LC_ALL, 'C');

	// A remote helper deciding to ask for a password would block on the terminal this process is drawing on.
	assert.equal(env.GIT_TERMINAL_PROMPT, '0');

	// And it is the caller's environment plus those, not a replacement for it: git needs PATH to run at all.
	assert.equal(env.PATH, '/usr/bin');
});

test('the entry point imports no UI, so React can still be sent to production', () => {
	/*
	 * This is the four-gigabyte crash, and it is entirely a matter of import order.
	 *
	 * React picks its build by reading `process.env.NODE_ENV` when it is first imported, and its development
	 * build reports to the User Timing API on every render — entries Node buffers forever. `index.ts` sets
	 * NODE_ENV and then reaches the UI through a dynamic `import()`. But ES module imports are hoisted and run
	 * before any statement in the file, so a single static import of ink, React, or any `.tsx` would load
	 * React *before* the assignment and quietly restore the leak. Nothing about that is visible in a diff.
	 */
	const source = readFileSync(join(SRC, 'index.ts'), 'utf8');
	const staticImports = [...source.matchAll(/^import\s[^;]*?from\s+'([^']+)';/gm)]
		.map((match) => match[1])
		.filter((specifier): specifier is string => Boolean(specifier));

	assert.ok(staticImports.length > 0, 'the regex should have found the real imports');
	for (const specifier of staticImports) {
		assert.ok(
			specifier !== 'ink' && specifier !== 'react' && !specifier.endsWith('.tsx'),
			`index.ts statically imports ${specifier}, which loads React before NODE_ENV is set`
		);
	}

	// And the assignment must still be there, ahead of the dynamic import that pulls the UI in.
	const assignment = source.indexOf('NODE_ENV');
	const dynamicImport = source.indexOf("await import('./run.tsx')");
	assert.ok(assignment > 0, 'index.ts no longer sets NODE_ENV');
	assert.ok(dynamicImport > assignment, 'the UI is imported before NODE_ENV is set');
});

test('the performance timeline can be emptied, which is the fallback for that crash', () => {
	// Under `NODE_ENV=development` React emits these on every render — measured at ~350 a second — and nothing
	// in Node evicts them. This is what stops that being a crash rather than merely wasteful.
	performance.mark('pressroom-test-mark');
	performance.measure('pressroom-test-measure', 'pressroom-test-mark');
	assert.ok(performance.getEntriesByType('measure').length > 0, 'the fixture should have made one');

	clearPerformanceTimeline();

	assert.equal(performance.getEntriesByType('measure').length, 0);
	assert.equal(performance.getEntriesByType('mark').length, 0);
});

test('a poll arriving mid-read is dropped, and a change is not', () => {
	// Queueing the poll is how a repo whose read takes longer than its interval reads in a continuous loop —
	// due again the instant it finishes, forever, spawning git processes as fast as the machine allows.
	assert.equal(queuesFollowUp('poll'), false);

	// A change means the repository moved after this read started, so the result being computed is stale.
	assert.equal(queuesFollowUp('change'), true);
	// And a manual refresh is someone asking directly.
	assert.equal(queuesFollowUp('manual'), true);
});

test('subprocess error text is sanitized before it can be rendered', async () => {
	/*
	 * The one route to the terminal that skipped the check the rest of the program applies.
	 *
	 * `format.ts` exists because a commit subject is attacker-chosen text and a terminal interprets escape
	 * sequences. Error messages are the same problem wearing a different hat: git, gh and wrangler all quote
	 * the thing that caused the failure — a branch name, a path, a Worker name — straight back at you, and
	 * that text was reaching the screen through `githubError`, `cloudflareError` and the repo row's error
	 * cell without ever passing through `sanitize`.
	 */
	const producers = ['git.ts', 'github.ts', 'cloudflare.ts'];
	for (const file of producers) {
		const source = readFileSync(join(SRC, file), 'utf8');
		const usesStderr = source.includes('err.stderr');
		assert.ok(usesStderr, `${file} should still be the place that reads stderr`);
		assert.match(
			source,
			/sanitize\(/,
			`${file} builds a message from subprocess stderr and must sanitize it`
		);
	}

	// And the sanitizer really does neutralize what a hostile branch name would carry.
	const { sanitize } = await import('./format.ts');
	const hostile = `${String.fromCharCode(27)}[2Jrefs/heads/${String.fromCharCode(27)}[31mred`;
	assert.equal(sanitize(hostile), 'refs/heads/red');
});

test('no source file writes a heap snapshot outside the project', () => {
	// A snapshot is a dump of everything the process held, `process.env` included. An earlier version wrote
	// them to a shared temp directory, where two 130MB files sat forgotten containing the whole feed.
	const probe = readFileSync(resolve(SRC, '..', 'scripts', 'probe.tsx'), 'utf8');
	assert.match(
		probe,
		/SNAPSHOT_DIR/,
		'snapshots should go to a named directory inside the project'
	);
	assert.doesNotMatch(probe, /writeHeapSnapshot\(\s*`?\/(tmp|private|var|Users)/);

	// And that directory has to be ignored, or a leak hunt ends with the heap in a commit.
	const ignore = readFileSync(resolve(SRC, '..', '.gitignore'), 'utf8');
	assert.match(ignore, /\.probe\//);
	assert.match(ignore, /\*\.heapsnapshot/);
});
