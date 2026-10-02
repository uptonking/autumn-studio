import { useCallback, useEffect, useRef } from "react";
import type { SettingsState } from "@getpaseo/plugin/client";
import type { ZodType } from "zod";

type ReadySettings<Schema extends ZodType> = Extract<
	SettingsState<Schema>,
	{ status: "ready" }
>;

/**
 * Debounced saver for settings inputs. The settings store is revision-based —
 * saving on every keystroke races concurrent revisions and produces conflicts.
 * Callers hand the full next values; the hook fires one save after `delayMs`
 * of idle time using the revision current at that moment, and flushes pending
 * saves on unmount.
 */
export function useDebouncedSave<Schema extends ZodType>(
	settings: ReadySettings<Schema>,
	delayMs = 500,
): (values: ReadySettings<Schema>["values"]) => void {
	// Latest ready snapshot, refreshed on every render.
	const latest = useRef(settings);
	latest.current = settings;

	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const pending = useRef<ReadySettings<Schema>["values"] | null>(null);

	const flush = useCallback(() => {
		if (timer.current !== null) {
			clearTimeout(timer.current);
			timer.current = null;
		}
		const values = pending.current;
		pending.current = null;
		if (values) void latest.current.save(values, latest.current.revision);
	}, []);

	useEffect(() => () => flush(), [flush]);

	return useCallback(
		(values) => {
			pending.current = values;
			if (timer.current !== null) clearTimeout(timer.current);
			timer.current = setTimeout(flush, delayMs);
		},
		[flush, delayMs],
	);
}
