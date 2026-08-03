/**
 * One file's patch.
 *
 * The `diff --git`, `index`, `---` and `+++` lines are kept rather than hidden. They are noise most of the
 * time, but they are the only place a mode change or a rename similarity score appears, and a diff viewer
 * that silently drops the line explaining why a file with no content change is in the commit is worse than
 * one with four dim lines at the top.
 */
import { Text } from 'ink';
import type { ReactNode } from 'react';
import { truncate } from '../format.ts';
import { UI } from '../theme.ts';
import { windowFor } from '../layout.ts';

export function DiffView({
	lines,
	state,
	offset,
	height,
	columns
}: {
	lines: string[];
	state: 'loading' | 'ready' | 'error';
	offset: number;
	height: number;
	columns: number;
}) {
	const rows: ReactNode[] = [];

	if (state === 'loading') {
		rows.push(
			<Text key="loading" color={UI.dim}>
				{'   reading the diff…'}
			</Text>
		);
	} else if (state === 'error') {
		rows.push(
			<Text key="error" color={UI.error}>
				{'   the diff could not be read'}
			</Text>
		);
	} else if (!lines.length) {
		// A commit can legitimately touch a file without changing its content: a mode change, or a rename
		// with no edits. Saying so is better than an empty pane.
		rows.push(
			<Text key="empty" color={UI.dim}>
				{'   no textual change — a mode change, a pure rename, or a binary file'}
			</Text>
		);
	} else {
		const start = windowFor(lines.length, height, offset, offset);
		for (const [index, line] of lines.slice(start, start + height).entries()) {
			rows.push(<DiffLine key={start + index} line={line} columns={columns} />);
		}
	}

	while (rows.length < height) rows.push(<Text key={`pad${rows.length}`}> </Text>);
	return <>{rows.slice(0, height)}</>;
}

/**
 * Color by the first character, which is what a unified diff encodes it in. The `+++`/`---` file headers
 * have to be tested before the `+`/`-` body lines, or they come out as one enormous addition and deletion.
 */
function DiffLine({ line, columns }: { line: string; columns: number }) {
	const text = ` ${truncate(line, Math.max(0, columns - 1))}`;

	if (
		/^(diff --git|index |--- |\+\+\+ |old mode|new mode|similarity index|rename (from|to)|new file mode|deleted file mode|Binary files)/.test(
			line
		)
	) {
		return (
			<Text color={UI.faint} wrap="truncate">
				{text}
			</Text>
		);
	}
	if (line.startsWith('@@')) {
		return (
			<Text color={UI.hunk} wrap="truncate">
				{text}
			</Text>
		);
	}
	if (line.startsWith('+')) {
		return (
			<Text color={UI.added} wrap="truncate">
				{text}
			</Text>
		);
	}
	if (line.startsWith('-')) {
		return (
			<Text color={UI.removed} wrap="truncate">
				{text}
			</Text>
		);
	}
	if (line.startsWith('\\')) {
		return (
			<Text color={UI.dim} wrap="truncate">
				{text}
			</Text>
		);
	}
	return <Text wrap="truncate">{text}</Text>;
}
