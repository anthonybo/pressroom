/**
 * Text going onto a terminal.
 *
 * `sanitize` is the one that matters. Every string here came out of a commit message, a branch name or a
 * filename, and all three are arbitrary bytes chosen by whoever made the commit. A subject containing an
 * escape sequence — `git commit -m $'\e[2J'` — would clear the screen when this program printed it, and a
 * stray carriage return is enough to make a row overwrite the one above it. So nothing reaches a component
 * before the control characters are gone.
 *
 * Widths are measured with `string-width` rather than `.length`, because a commit subject with an emoji in
 * it occupies two columns per emoji and `.length` says one. Getting that wrong shifts every column to the
 * right of it on exactly the rows that are hardest to notice.
 */
import stringWidth from 'string-width';

const ESC = 0x1b;
const BEL = 0x07;
const TAB = 0x09;
const NEWLINE = 0x0a;
const DEL = 0x7f;

/** Tabs become four columns so a width calculation can predict what the terminal will do with them. */
const TAB_WIDTH = 4;

/**
 * Removes escape sequences and every other control character, keeping newline — bodies and diffs are
 * multi-line and get split on it later.
 *
 * Written as a scan over character codes rather than as a regex, because the regex for this needs control
 * characters *inside the pattern*, where they sit invisibly in the source and the next person to edit the
 * line cannot see what it matches.
 */
export function sanitize(text: string): string {
	let out = '';
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		if (code === ESC) {
			i = endOfEscape(text, i);
			continue;
		}
		if (code === TAB) {
			out += ' '.repeat(TAB_WIDTH);
			continue;
		}
		if (code === NEWLINE) {
			out += '\n';
			continue;
		}
		if (code < 0x20 || code === DEL) continue;
		out += text[i];
	}
	return out;
}

/** Index of the final character of the escape sequence beginning at `start`. */
function endOfEscape(text: string, start: number): number {
	const next = text.charCodeAt(start + 1);

	// CSI — `ESC [`, parameters, then a final byte in the range @ to ~. This is the common case: colors,
	// cursor moves, and the screen-clearing ones.
	if (next === 0x5b) {
		for (let i = start + 2; i < text.length; i++) {
			const code = text.charCodeAt(i);
			if (code >= 0x40 && code <= 0x7e) return i;
		}
		return text.length;
	}

	// OSC — `ESC ]`, a payload, terminated by BEL or by `ESC \`. This is how a terminal is told to set its
	// title, and the payload is arbitrary text that must not be left behind.
	if (next === 0x5d) {
		for (let i = start + 2; i < text.length; i++) {
			const code = text.charCodeAt(i);
			if (code === BEL) return i;
			if (code === ESC && text.charCodeAt(i + 1) === 0x5c) return i + 1;
		}
		return text.length;
	}

	// Everything else is a two-character escape.
	return start + 1;
}

/** Display width in terminal columns. */
export function width(text: string): number {
	return stringWidth(text);
}

/** Cuts to `max` columns, with a `…` in the last one when anything was removed. */
export function truncate(text: string, max: number): string {
	if (max <= 0) return '';
	if (stringWidth(text) <= max) return text;
	if (max === 1) return '…';

	let out = '';
	let used = 0;
	// By code point, and by measured width, so a wide character is never cut in half.
	for (const char of text) {
		const w = stringWidth(char);
		if (used + w > max - 1) break;
		out += char;
		used += w;
	}
	return out + '…';
}

/** Pads on the right to exactly `size` columns. */
export function pad(text: string, size: number): string {
	const w = stringWidth(text);
	return w >= size ? text : text + ' '.repeat(size - w);
}

/** Pads on the left to exactly `size` columns. */
export function padStart(text: string, size: number): string {
	const w = stringWidth(text);
	return w >= size ? text : ' '.repeat(size - w) + text;
}

/** Truncate and pad — a fixed-width column, whatever the content. */
export function fit(text: string, size: number): string {
	return pad(truncate(text, size), size);
}

/**
 * Age in at most four columns: `now`, `45s`, `12m`, `5h`, `3d`, `2w`, `5mo`, `2y`.
 *
 * A feed wants "how long ago", not a timestamp — the question being asked of the top row is always
 * whether it just happened. The exact time is in the commit view, where there is room for it.
 */
export function age(nowMs: number, iso: string): string {
	const then = Date.parse(iso);
	if (Number.isNaN(then)) return '?';
	const seconds = Math.max(0, Math.round((nowMs - then) / 1000));

	if (seconds < 10) return 'now';
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h`;
	const days = Math.floor(hours / 24);
	if (days < 7) return `${days}d`;
	if (days < 60) return `${Math.floor(days / 7)}w`;
	const months = Math.floor(days / 30);
	if (months < 24) return `${months}mo`;
	return `${Math.floor(days / 365)}y`;
}

/** `15:56:12`, for the header clock. */
export function clock(date: Date): string {
	const p = (n: number) => String(n).padStart(2, '0');
	return `${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`;
}

/** `Tue Jul 29, 15:56` — the commit view's absolute time. */
export function stamp(iso: string): string {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return '?';
	const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
	const months = [
		'Jan',
		'Feb',
		'Mar',
		'Apr',
		'May',
		'Jun',
		'Jul',
		'Aug',
		'Sep',
		'Oct',
		'Nov',
		'Dec'
	];
	const p = (n: number) => String(n).padStart(2, '0');
	const time = `${p(date.getHours())}:${p(date.getMinutes())}`;
	return `${days[date.getDay()]} ${months[date.getMonth()]} ${date.getDate()}, ${time}`;
}

/** Strips the `refs/heads/` or `refs/remotes/` prefix git sometimes includes. */
export function shortenRef(ref: string): string {
	return ref.replace(/^refs\/(heads|remotes)\//, '');
}

/** `49s`, `1m 2s`, `12m` — a deploy's duration, in as few columns as stays readable. */
export function duration(ms: number): string {
	const seconds = Math.round(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const rest = seconds % 60;
	if (minutes < 10) return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
	return `${minutes}m`;
}
