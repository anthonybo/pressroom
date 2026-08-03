/**
 * The two things every view needs: how big the terminal is, and what time it is.
 *
 * Terminal size comes from the stream ink was handed rather than from `process.stdout`, so a harness that
 * renders into a fake stream of a chosen size measures the same layout the real thing would draw. That is
 * the only way to check column arithmetic without a terminal attached.
 */
import { useEffect, useState } from 'react';
import { useStdout } from 'ink';

export function useTerminalSize(): { columns: number; rows: number } {
	const { stdout } = useStdout();
	const read = () => ({ columns: stdout.columns || 80, rows: stdout.rows || 24 });
	const [size, setSize] = useState(read);

	useEffect(() => {
		const onResize = () => setSize(read());
		stdout.on('resize', onResize);
		return () => {
			stdout.off('resize', onResize);
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [stdout]);

	return size;
}

/**
 * A clock that ticks once a second.
 *
 * Ages are relative — `2m`, `5h` — so without this the feed would silently go stale, every row frozen at
 * whatever it said when the last commit landed. One state update a second is nothing next to that.
 */
export function useNow(intervalMs = 1000): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const timer = setInterval(() => setNow(Date.now()), intervalMs);
		return () => clearInterval(timer);
	}, [intervalMs]);
	return now;
}
