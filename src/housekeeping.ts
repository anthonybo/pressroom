/**
 * The chore that keeps a long-running session from filling memory with its own instrumentation.
 *
 * React's **development** build reports to the User Timing API on every render, and Node buffers those
 * entries for the life of the process with nothing evicting them. Measured at roughly 350 `PerformanceMeasure`
 * objects a second — about fifteen megabytes a minute — which reached V8's heap limit and killed the process
 * after about three hours of watching.
 *
 * The primary fix is selecting React's production build before it is imported, which emits none of this. This
 * is the second line of defence, so that running under `NODE_ENV=development` costs a little wasted work
 * rather than crashing.
 *
 * In its own file, away from anything that imports React, so it can be tested without loading a UI.
 */

/** How often to empty the timeline. Frequent enough that nothing accumulates, rare enough to be free. */
export const HOUSEKEEPING_MS = 30_000;

/** Empties the User Timing buffers. Nothing in this program reads them, so nothing is lost. */
export function clearPerformanceTimeline(): void {
	performance.clearMarks();
	performance.clearMeasures();
}

/** Runs {@link clearPerformanceTimeline} forever, without holding the process open by itself. */
export function keepPerformanceTimelineEmpty(intervalMs = HOUSEKEEPING_MS): NodeJS.Timeout {
	const timer = setInterval(clearPerformanceTimeline, intervalMs);
	timer.unref?.();
	return timer;
}
