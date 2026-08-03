/**
 * Dumps the escape codes the real UI actually emits, so the palette is verified at the wire rather than in the
 * source.
 *
 *   npm run colors
 *
 * The reason this is worth a script: the theme can name `#9aa2ad` and the terminal can still receive ANSI slot
 * 8, because chalk decides what to emit from what it believes the terminal supports. Reading the source tells
 * you the intent; this tells you what was sent. `FORCE_COLOR=3` is set here because the harness renders into a
 * stream that is not a terminal, which chalk would otherwise treat as "no color at all".
 */
import { render } from 'ink';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { App } from '../src/components/App.tsx';
import { discover, label } from '../src/discover.ts';
import { Engine } from '../src/engine.ts';

const ESC = String.fromCharCode(27);

class Sink extends EventEmitter {
	isTTY = true;
	columns = 110;
	rows = 30;
	/**
	 * The largest chunk written, which is the frame.
	 *
	 * Keeping "the last non-empty chunk" instead does not work: the final write before unmount is a six-byte
	 * cursor-show sequence, and it is not empty once trimmed — so the capture came back as those six bytes and
	 * the check reported no colors at all.
	 */
	last = '';
	write(chunk: string): boolean {
		if (chunk.length > this.last.length) this.last = chunk;
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

/** The same default as the app: the directory this project sits in, not anyone's home path. */
const ROOT =
	process.env.PRESSROOM_ROOT ?? dirname(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
const engine = new Engine(label(discover(ROOT), ROOT), { limit: 40 });
engine.start();

const sink = new Sink();
const app = render(<App engine={engine} root={ROOT} />, {
	stdout: sink as never,
	stdin: new Keys() as never,
	patchConsole: false,
	exitOnCtrlC: false
});

await new Promise((resolve) => setTimeout(resolve, Number(process.env.WAIT ?? 6000)));
app.unmount();
engine.stop();

const counts = new Map<string, number>();
const pattern = new RegExp(`${ESC}\\[([0-9;]+)m`, 'g');
for (const match of sink.last.matchAll(pattern)) {
	const code = match[1] ?? '';
	counts.set(code, (counts.get(code) ?? 0) + 1);
}

/** `38;2;R;G;B` is a true 24-bit color; anything else is a palette slot or an attribute. */
function describe(code: string): string {
	const parts = code.split(';');
	if (parts[0] === '38' && parts[1] === '2') {
		const hex = [parts[2], parts[3], parts[4]]
			.map((n) => Number(n).toString(16).padStart(2, '0'))
			.join('');
		return `24-bit  #${hex}`;
	}
	if (code === '90')
		return 'PALETTE SLOT 8 — theme-dependent bright black, the color this palette exists to avoid';
	if (code === '1') return 'bold';
	if (code === '7') return 'inverse';
	if (code === '0' || code === '22' || code === '39' || code === '27') return 'reset';
	return `palette slot / attribute ${code}`;
}

console.log(`\n  captured ${sink.last.length} bytes, ${counts.size} distinct codes`);
console.log('\n  escape codes in one real frame, most frequent first\n');
for (const [code, n] of [...counts].sort((a, b) => b[1] - a[1]).slice(0, 16)) {
	console.log(`  ${String(n).padStart(4)}x  ${code.padEnd(18)} ${describe(code)}`);
}

if (!counts.size) {
	// Measuring nothing is not a pass. Without this the check reports success on an empty capture, which is
	// exactly the sort of green tick that hides a broken test.
	console.error('\n  FAIL: no escape codes captured at all — nothing was measured\n');
	process.exit(1);
}

const slot8 = counts.get('90') ?? 0;
console.log(
	slot8
		? `\n  FAIL: bright black still emitted ${slot8} time(s)\n`
		: '\n  ok: no theme-dependent grays; every color is an explicit value\n'
);
process.exit(slot8 ? 1 : 0);
