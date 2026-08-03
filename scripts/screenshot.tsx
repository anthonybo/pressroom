/**
 * Renders one frame against the demo fixture and writes it out as an SVG.
 *
 *   npm run screenshot
 *
 * An SVG rather than a PNG because it needs no screen-capture tool, stays sharp at any size, and is a few
 * kilobytes of text that reviews as a diff. It is a real capture either way: the frame comes from the same
 * components that draw the terminal, and the colours are the escape sequences they actually emitted, parsed
 * back out — not a palette re-typed by hand into a picture.
 *
 * The data is the invented workspace built by `scripts/demo.mjs`, so nothing here names a real project.
 */
import { render } from 'ink';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { App } from '../src/components/App.tsx';
import { discover, label } from '../src/discover.ts';
import { Engine } from '../src/engine.ts';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ESC = String.fromCharCode(27);

const COLUMNS = Number(process.env.SHOT_COLS ?? 104);
const ROWS = Number(process.env.SHOT_ROWS ?? 22);
const OUT = process.env.SHOT_OUT ?? join(PROJECT_ROOT, 'docs', 'screenshot.svg');
const ROOT = process.env.PRESSROOM_ROOT ?? dirname(PROJECT_ROOT);
const ROOT_LABEL = process.env.PRESSROOM_ROOT_LABEL ?? ROOT;

class Sink extends EventEmitter {
	isTTY = true;
	columns = COLUMNS;
	rows = ROWS;
	widest = '';
	write(chunk: string): boolean {
		// The frame is by far the largest write; the rest are cursor moves.
		if (chunk.length > this.widest.length) this.widest = chunk;
		return true;
	}
	cursorTo() {}
	clearLine() {}
}

class Keys extends PassThrough {
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

type Span = { text: string; color?: string; bold?: boolean; inverse?: boolean };

/**
 * Turns one line of ANSI into styled spans.
 *
 * Only the codes this program emits are handled — 24-bit colour, bold, inverse and their resets — because
 * everything is an explicit value by design. Anything unrecognised resets to default rather than being guessed
 * at, so an unhandled code shows as plain text instead of silently inheriting the wrong colour.
 */
function parse(line: string): Span[] {
	const spans: Span[] = [];
	let color: string | undefined;
	let bold = false;
	let inverse = false;
	let text = '';

	const flush = () => {
		if (text) spans.push({ text, color, bold, inverse });
		text = '';
	};

	for (let i = 0; i < line.length; i++) {
		if (line[i] !== ESC || line[i + 1] !== '[') {
			text += line[i];
			continue;
		}
		let j = i + 2;
		while (j < line.length && line[j] !== 'm' && !/[@-~]/.test(line[j] ?? '')) j++;
		const codes = line.slice(i + 2, j).split(';');
		i = j;

		flush();
		for (let k = 0; k < codes.length; k++) {
			const code = codes[k];
			if (code === '38' && codes[k + 1] === '2') {
				const [r, g, b] = [codes[k + 2], codes[k + 3], codes[k + 4]];
				color = `#${[r, g, b].map((n) => Number(n).toString(16).padStart(2, '0')).join('')}`;
				k += 4;
			} else if (code === '1') bold = true;
			else if (code === '7') inverse = true;
			else if (code === '22') bold = false;
			else if (code === '27') inverse = false;
			else if (code === '39') color = undefined;
			else if (code === '0' || code === '') {
				color = undefined;
				bold = false;
				inverse = false;
			}
		}
	}
	flush();
	return spans;
}

const escapeXml = (text: string) =>
	text.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c] ?? c);

/** Matches the terminal the palette was measured against: a dark background, default foreground near-white. */
const BACKGROUND = '#12141a';
const FOREGROUND = '#dfe3ea';
const CELL_W = 8.4;
const CELL_H = 19;
const PAD = 18;

function toSvg(lines: string[]): string {
	const width = Math.round(COLUMNS * CELL_W + PAD * 2);
	const height = Math.round(lines.length * CELL_H + PAD * 2);

	const rows = lines.map((line, row) => {
		const y = PAD + row * CELL_H + CELL_H * 0.75;
		let column = 0;
		const parts: string[] = [];
		const rects: string[] = [];

		for (const span of parse(line)) {
			const x = PAD + column * CELL_W;
			const cells = [...span.text].length;
			// Inverse is the cursor row: drawn as a filled block with the background colour as the text.
			if (span.inverse) {
				rects.push(
					`<rect x="${x.toFixed(1)}" y="${(PAD + row * CELL_H).toFixed(1)}" width="${(cells * CELL_W).toFixed(1)}" height="${CELL_H}" fill="${span.color ?? FOREGROUND}"/>`
				);
			}
			const fill = span.inverse ? BACKGROUND : (span.color ?? FOREGROUND);
			parts.push(
				`<tspan x="${x.toFixed(1)}" y="${y.toFixed(1)}" fill="${fill}"${span.bold ? ' font-weight="700"' : ''}>${escapeXml(span.text)}</tspan>`
			);
			column += cells;
		}
		return rects.join('') + `<text>${parts.join('')}</text>`;
	});

	return [
		`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" font-size="14">`,
		`<rect width="${width}" height="${height}" rx="10" fill="${BACKGROUND}"/>`,
		`<g xml:space="preserve">`,
		...rows,
		`</g>`,
		`</svg>`,
		''
	].join('\n');
}

const engine = new Engine(label(discover(ROOT), ROOT), { limit: 40 });
engine.start();

const sink = new Sink();
const app = render(<App engine={engine} root={ROOT_LABEL} />, {
	stdout: sink as never,
	stdin: new Keys() as never,
	patchConsole: false,
	exitOnCtrlC: false
});

await new Promise((resolve) => setTimeout(resolve, Number(process.env.SHOT_WAIT ?? 9000)));
app.unmount();
engine.stop();

const lines = sink.widest.replace(/\n+$/, '').split('\n');
if (lines.length < 5) {
	console.error(`  captured only ${lines.length} line(s) — nothing worth writing`);
	process.exit(1);
}

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, toSvg(lines));
console.log(`  wrote ${OUT.slice(PROJECT_ROOT.length + 1)} — ${lines.length} lines, ${COLUMNS} columns`);
