/**
 * Renders the real dashboard, against the real repositories, into a terminal of a chosen size that does not
 * exist — then measures the frame it produced.
 *
 *   npm run frames                     80x24, 100x40 and 200x50
 *   npm run frames -- --cols 60 --rows 20
 *
 * This is here because a screenshot proves nothing about a width. The two failures that matter — a row one
 * column too wide, and a frame one line too tall — are both invisible on the terminal that happens to be
 * open and both wreck the display on one that is a different size. So the frame is captured, every line is
 * measured, and the harness fails loudly if any line is wider than the terminal or the frame is taller.
 */
import { render } from 'ink';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { App } from '../src/components/App.tsx';
import { discover, label } from '../src/discover.ts';
import { Engine } from '../src/engine.ts';
import { width } from '../src/format.ts';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = process.env.PRESSROOM_ROOT ?? dirname(PROJECT_ROOT);
/** What the header shows. Separate from the path scanned, so a fixture render prints no real home path. */
const ROOT_LABEL = process.env.PRESSROOM_ROOT_LABEL ?? ROOT;

function arg(name: string, fallback: number): number {
	const index = process.argv.indexOf(`--${name}`);
	if (index < 0) return fallback;
	return Number(process.argv[index + 1] ?? fallback);
}

/** A stdout that is not a terminal but claims to be one of a fixed size, and keeps what was written to it. */
class FakeStdout extends EventEmitter {
	readonly writes: string[] = [];
	isTTY = true;
	columns: number;
	rows: number;
	// Fields are declared and assigned rather than written as constructor parameter properties, which
	// `erasableSyntaxOnly` forbids — that setting is what lets node run these files by stripping types.
	constructor(columns: number, rows: number) {
		super();
		this.columns = columns;
		this.rows = rows;
	}
	write(chunk: string): boolean {
		this.writes.push(chunk);
		return true;
	}
	/** ink asks; nothing here needs it to do anything. */
	cursorTo() {}
	clearLine() {}
}

/**
 * A stdin that behaves like a raw-mode terminal.
 *
 * It has to be a real stream, not an EventEmitter with the right method names. Ink reads input by attaching
 * a `readable` listener and calling `stdin.read()` in a loop — it never listens for `data` — so an emitter
 * that emits `data` events delivers nothing at all and every key silently does nothing. A `PassThrough`
 * written to from the other end drives the same code path a terminal does.
 */
class FakeStdin extends PassThrough {
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

/** Strips the escape sequences ink uses to position and color, leaving the characters that were drawn. */
function plain(text: string): string {
	let out = '';
	for (let i = 0; i < text.length; i++) {
		if (text.charCodeAt(i) === 0x1b) {
			// Skip to the end of the sequence: CSI ends on a byte in @..~, anything else is two characters.
			if (text[i + 1] === '[') {
				i += 2;
				while (i < text.length) {
					const code = text.charCodeAt(i);
					if (code >= 0x40 && code <= 0x7e) break;
					i++;
				}
			} else {
				i += 1;
			}
			continue;
		}
		out += text[i];
	}
	return out;
}

/**
 * The escape sequences a terminal actually sends, so `--keys enter,down,enter` drives the real key handler
 * rather than a test-only path into the views. Without this the commit and diff panes could only be checked
 * by opening them by hand, which is exactly the kind of verification that gets skipped.
 */
const KEYS: Record<string, string> = {
	enter: '\r',
	down: '\u001b[B',
	up: '\u001b[A',
	left: '\u001b[D',
	right: '\u001b[C',
	escape: '\u001b',
	tab: '\t',
	space: ' ',
	/** Sends nothing; just spends one interval, for watching something land mid-run. */
	wait: ''
};

async function capture(columns: number, rows: number, waitMs: number) {
	if (!existsSync(ROOT)) throw new Error(`${ROOT} does not exist`);
	const repos = label(discover(ROOT), ROOT);

	const stdout = new FakeStdout(columns, rows);
	const stdin = new FakeStdin();
	const engine = new Engine(repos, { limit: 40 });
	engine.start();

	const instance = render(<App engine={engine} root={ROOT_LABEL} />, {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		stdout: stdout as any,
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		stdin: stdin as any,
		patchConsole: false,
		exitOnCtrlC: false
	});

	await new Promise((r) => setTimeout(r, waitMs));

	// Keys are sent as a terminal would send them: raw bytes on stdin's 'data' event.
	const keys = (process.argv[process.argv.indexOf('--keys') + 1] ?? '').split(',').filter(Boolean);
	for (const name of keys) {
		const sequence = KEYS[name] ?? name;
		stdin.write(sequence);
		// Long enough for a `git show` to come back and the pane to re-render with real content.
		await new Promise((r) => setTimeout(r, 600));
	}

	// Ink rewrites the whole frame on every render, so the last non-trivial write is the current screen.
	const frame = [...stdout.writes].reverse().find((chunk) => plain(chunk).trim().length > 0) ?? '';
	instance.unmount();
	engine.stop();

	return plain(frame).replace(/\n+$/, '').split('\n');
}

const sizes: [number, number][] =
	process.argv.includes('--cols') || process.argv.includes('--rows')
		? [[arg('cols', 100), arg('rows', 40)]]
		: [
				[80, 24],
				[100, 40],
				[200, 50]
			];

let failures = 0;

for (const [columns, rows] of sizes) {
	const lines = await capture(columns, rows, arg('wait', 2500));

	const widest = Math.max(0, ...lines.map((line) => width(line)));
	const over = lines.filter((line) => width(line) > columns);

	console.log(`\n${'═'.repeat(columns)}`);
	console.log(`  ${columns}×${rows}  —  ${lines.length} lines drawn, widest ${widest} columns`);
	console.log('═'.repeat(columns));
	// A ruler, so a row that runs long is visible rather than inferred.
	console.log('┌' + '─'.repeat(columns) + '┐');
	for (const line of lines) console.log('│' + line.padEnd(columns).slice(0, columns) + '│');
	console.log('└' + '─'.repeat(columns) + '┘');

	if (over.length) {
		failures++;
		console.error(`  FAIL: ${over.length} line(s) wider than ${columns} columns`);
		for (const line of over.slice(0, 3)) console.error(`    ${width(line)}: ${line.slice(0, 120)}`);
	}
	if (lines.length > rows) {
		failures++;
		console.error(`  FAIL: frame is ${lines.length} lines in a ${rows}-row terminal`);
	}
	if (!over.length && lines.length <= rows) {
		console.log(`  ok: fits ${columns}×${rows}`);
	}
}

process.exit(failures ? 1 : 0);
