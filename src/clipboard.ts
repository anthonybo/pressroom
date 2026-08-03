/**
 * Copying a sha out.
 *
 * The reason this exists is that a sha read off a dashboard has to be retyped into a terminal, and seven
 * hex characters is exactly long enough to get wrong. `pbcopy` is macOS; elsewhere the key reports that it
 * cannot rather than appearing to work.
 */
import { execFile } from 'node:child_process';

export function copy(text: string): Promise<void> {
	return new Promise((resolve, reject) => {
		if (process.platform !== 'darwin') {
			reject(new Error('clipboard is macOS only'));
			return;
		}
		const child = execFile('pbcopy', (error) => (error ? reject(error) : resolve()));
		child.stdin?.end(text);
	});
}
