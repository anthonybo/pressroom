/**
 * Memory probe. Runs the real engine (and optionally the real ink render) against the real repos, forcing a
 * full GC before each measurement so what is printed is *retained* memory, not uncollected garbage.
 *
 *   npm run probe -- engine
 *   npm run probe -- ink
 *   PROBE_SNAPSHOTS=1 npm run probe -- ink      also writes two heap snapshots
 *
 * **A heap snapshot is a dump of everything the process was holding**, which includes `process.env` and every
 * commit message read so far. They are written inside the project, where `.gitignore` covers them, rather
 * than to a shared temp directory — and they are worth deleting once a leak hunt is over rather than leaving
 * around. They are off unless `PROBE_SNAPSHOTS` is set for that reason.
 */
import { render } from 'ink';
import { mkdirSync } from 'node:fs';
import { writeHeapSnapshot } from 'node:v8';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { App } from '../src/components/App.tsx';
import { discover, label } from '../src/discover.ts';
import { Engine } from '../src/engine.ts';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const MODE = process.argv[2] ?? 'engine';
/** The same default as the app: the directory this project sits in. Overridable, and not anyone's home path. */
const ROOT = process.env.PRESSROOM_ROOT ?? dirname(PROJECT_ROOT);
const SNAPSHOT_DIR = join(PROJECT_ROOT, '.probe');
const DURATION_MS = Number(process.argv[3] ?? 150_000);

/** Deliberately does not keep what was written — a probe that buffers frames measures its own leak. */
class Sink extends EventEmitter {
	isTTY = true;
	columns = 120;
	rows = 40;
	lastLength = 0;
	frames = 0;
	write(chunk: string): boolean {
		this.frames++;
		this.lastLength = chunk.length;
		return true;
	}
	cursorTo() {}
	clearLine() {}
}

class Keyboard extends PassThrough {
	isTTY = true;
	setRawMode() {
		return this;
	}
	ref() {
		return this;
	}
	unref() {
		return this;
	}
}

const repos = label(discover(ROOT), ROOT);
const engine = new Engine(repos, { limit: 40 });

let emits = 0;
engine.subscribe(() => emits++);
engine.start();

const sink = new Sink();
if (MODE === 'ink') {
	render(<App engine={engine} root={ROOT} />, {
		stdout: sink as never,
		stdin: new Keyboard() as never,
		patchConsole: false,
		exitOnCtrlC: false
	});
}

const started = Date.now();
const mb = (bytes: number) => (bytes / 1048576).toFixed(1).padStart(7);

console.log(`mode=${MODE} repos=${repos.length}`);
console.log('  elapsed     heap      rss external arrayBuf  emits frames');

const timer = setInterval(() => {
	global.gc?.();
	global.gc?.();
	const m = process.memoryUsage();
	const seconds = Math.round((Date.now() - started) / 1000);
	console.log(
		`  ${String(seconds).padStart(5)}s ${mb(m.heapUsed)} ${mb(m.rss)} ${mb(m.external)} ${mb(m.arrayBuffers)} ${String(emits).padStart(6)} ${String(sink.frames).padStart(6)}`
	);
	const snapAt = Number(process.env.PROBE_SNAPSHOTS ?? 0);
	if (snapAt && (seconds === 30 || seconds === 120)) {
		mkdirSync(SNAPSHOT_DIR, { recursive: true });
		const path = join(SNAPSHOT_DIR, `heap-${seconds}.heapsnapshot`);
		writeHeapSnapshot(path);
		// Said out loud, because the file holds the environment and every commit message read so far, and it
		// is tens of megabytes. It should not be forgotten about after the leak is found.
		console.log(`    wrote ${path} — contains process.env and feed contents; delete when done`);
	}
	if (Date.now() - started > DURATION_MS) {
		clearInterval(timer);
		engine.stop();
		process.exit(0);
	}
}, 15_000);
