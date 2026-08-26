/**
 * Every agent-starting command must state its own timers as one `--time` value:
 * `<return-after>/<timeout>`, e.g. `10m/2h`. There are deliberately no default
 * timers: an orchestrating AI should never inherit a lifetime it did not
 * choose. Both parts must be positive — an attached caller always gets its
 * progress checkpoint back; true fire-and-forget is done by backgrounding the
 * pirun invocation itself.
 */

export const TIME_FLAG_HELP = 'example: --time 10m/2h (caller checkpoint after 10m, hard stop at 2h)';

const DURATION_PATTERN = /^(\d+(?:\.\d+)?)(s|m|h)?$/;

/** "90", "90s", "10m", "1.5h" → seconds. Bare numbers are seconds. */
export function parseDurationSeconds(raw: string, flag: string): number {
	const match = DURATION_PATTERN.exec(raw.trim().toLowerCase());
	if (!match) {
		throw new Error(`${flag} needs a duration like 45s, 10m, or 2h (got "${raw}").`);
	}
	const value = Number(match[1]);
	const unit = match[2] ?? 's';
	const seconds = unit === 'h' ? value * 3600 : unit === 'm' ? value * 60 : value;
	if (!Number.isFinite(seconds) || seconds <= 0) {
		throw new Error(`${flag} must be a positive duration (got "${raw}").`);
	}
	return Math.round(seconds);
}

export interface TimeSpec {
	returnAfterSec: number;
	timeoutSec: number;
}

export function parseTimeSpec(raw: string | undefined): TimeSpec {
	if (!raw || !raw.trim()) {
		throw new Error(`--time <return-after>/<timeout> is required when starting an agent. ${TIME_FLAG_HELP}`);
	}
	const parts = raw.split('/');
	if (parts.length !== 2 || !parts[0].trim() || !parts[1].trim()) {
		throw new Error(`--time takes two parts separated by "/". ${TIME_FLAG_HELP}`);
	}
	if (/^0+(\.0+)?[smh]?$/.test(parts[0].trim())) {
		throw new Error(
			'--time return-after must be positive so the caller always gets its progress checkpoint. ' +
				'To run unattended, background the pirun command itself.'
		);
	}
	// A caller wait longer than the hard stop is allowed on purpose: it means
	// "stay attached until the run ends, even if that end is the timeout".
	const returnAfterSec = parseDurationSeconds(parts[0], '--time return-after');
	const timeoutSec = parseDurationSeconds(parts[1], '--time timeout');
	return { returnAfterSec, timeoutSec };
}

/** A single duration for `wait`/re-attach, where only the caller wait applies. */
export function parseWaitTime(raw: string | undefined, fallbackSec: number): number {
	if (!raw || !raw.trim()) return fallbackSec;
	const value = raw.includes('/') ? raw.split('/')[0] : raw;
	return parseDurationSeconds(value, '--time');
}

export interface TimeAdjust {
	mode: 'add' | 'set';
	seconds: number;
}

/**
 * `+30m` extends the current hard deadline by 30 minutes; `45m` sets the hard
 * deadline to 45 minutes from now. The two spellings exist so the reference
 * point is always explicit in the command itself.
 */
export function parseTimeAdjust(raw: string): TimeAdjust {
	const trimmed = raw.trim();
	const mode = trimmed.startsWith('+') ? 'add' : 'set';
	const seconds = parseDurationSeconds(mode === 'add' ? trimmed.slice(1) : trimmed, 'time');
	return { mode, seconds };
}

export function humanClock(at: number) {
	return new Date(at).toTimeString().slice(0, 8);
}
