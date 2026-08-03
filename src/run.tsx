/**
 * Starting the UI. Imported dynamically, and only after `NODE_ENV` has been set — which is the whole reason
 * this is a separate file from the entry point. See the comment in `index.ts`.
 */
import { render } from 'ink';
import { App } from './components/App.tsx';
import { Engine } from './engine.ts';
import { keepPerformanceTimelineEmpty } from './housekeeping.ts';
import type { Repo, Scope } from './types.ts';

export function start(
	repos: Repo[],
	root: string,
	options: { limit: number; scope: Scope; rediscover?: () => Repo[]; local?: boolean }
): void {
	const engine = new Engine(repos, {
		limit: options.limit,
		scope: options.scope,
		rediscover: options.rediscover,
		local: options.local
	});
	engine.start();

	const housekeeping = keepPerformanceTimelineEmpty();
	const app = render(<App engine={engine} root={root} />);

	app.waitUntilExit().then(() => {
		clearInterval(housekeeping);
		engine.stop();
	});
}
