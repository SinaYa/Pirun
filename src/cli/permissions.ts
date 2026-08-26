/**
 * Harness permission levels: stored per preset as intent (like --effort) and
 * mapped to each harness's own mechanism at spawn time.
 *
 *   read  the agent can only look — no edits, no commands
 *   ask   every risky action needs an interactive human grant
 *   edit  file edits are pre-approved; riskier actions follow harness policy
 *   all   everything is pre-approved
 *
 * ENFORCED: every harness in HARNESS_PROVIDERS must declare an entry in
 * HARNESS_PERMISSIONS — a default level (one above ask-everything, per the
 * standing decision) and, for each level it cannot honor, an explicit reason.
 * A harness without a declaration fails at import time and in tests.
 *
 * When a harness denies an action instead of asking (headless harnesses
 * cannot prompt), the denial IS the permission ask: it is surfaced in the
 * digest exactly like response text, with the flag that would grant it.
 *
 * Investigated 2026-08-27:
 * - Antigravity (agy 1.1.21): headless print mode auto-denies tools that
 *   would prompt ("headless mode cannot prompt … auto-denied", stream event
 *   TOOL_ERROR "permission check failed"). Ladder: --mode plan < default
 *   (deny) < --mode accept-edits < --dangerously-skip-permissions.
 * - Pi (0.52.x): no permission prompts exist; scope is enforced with tool
 *   allowlists (--tools read,grep,find,ls …).
 */

import { PIRUN_HARNESSES } from '../pirun-config.ts';

export const PERMISSION_LEVELS = ['read', 'ask', 'edit', 'all'] as const;
export type PermissionLevel = (typeof PERMISSION_LEVELS)[number];

export function parsePermissionLevel(raw: string): PermissionLevel {
	const value = raw.trim().toLowerCase();
	if ((PERMISSION_LEVELS as readonly string[]).includes(value)) return value as PermissionLevel;
	throw new Error(`--permissions must be ${PERMISSION_LEVELS.join(', ')} (got "${raw}").`);
}

export interface HarnessPermissions {
	/** The level a fresh preset gets; must sit above "ask", never at it. */
	default: PermissionLevel;
	/** Levels this harness cannot honor, each with the reason why. */
	unsupported: Partial<Record<PermissionLevel, string>>;
}

export const HARNESS_PERMISSIONS: Record<string, HarnessPermissions> = {
	antigravity: {
		default: 'edit',
		unsupported: {
			ask: 'headless agy cannot prompt — it auto-denies instead (verified live); ' +
				'use edit or all, or run agy interactively outside pirun'
		}
	},
	pi: {
		default: 'edit',
		unsupported: {
			ask: 'Pi has no interactive permission prompts; scope is enforced with tool ' +
				'allowlists — use read, edit, or all'
		}
	}
};

/** Every harness must decide its permission story before it can ship. */
export function assertPermissionCoverage(harnesses: readonly string[] = PIRUN_HARNESSES) {
	for (const name of harnesses) {
		const spec = HARNESS_PERMISSIONS[name];
		if (!spec) {
			throw new Error(
				`harness "${name}" declares no permission levels. Add HARNESS_PERMISSIONS["${name}"] in ` +
					`src/cli/permissions.ts: a default level and, for each of ${PERMISSION_LEVELS.join('/')} ` +
					`it cannot honor, the reason why.`
			);
		}
		if (spec.default === 'ask' || spec.unsupported[spec.default]) {
			throw new Error(
				`harness "${name}" must default to a supported level above "ask" (one higher than ` +
					`ask-for-everything); got "${spec.default}".`
			);
		}
	}
}

assertPermissionCoverage();

/** Resolve a preset's stored level for a harness, or explain what would work. */
export function resolvePermissionLevel(harness: string, stored: string | undefined): PermissionLevel {
	const spec = HARNESS_PERMISSIONS[harness];
	if (!spec) throw new Error(`harness "${harness}" declares no permission levels.`);
	if (!stored) return spec.default;
	const level = parsePermissionLevel(stored);
	const reason = spec.unsupported[level];
	if (reason) {
		const supported = PERMISSION_LEVELS.filter((name) => !spec.unsupported[name]);
		throw new Error(
			`--permissions ${level} is not available on the ${harness} harness: ${reason}.\n` +
				`supported: ${supported.join(', ')}`
		);
	}
	return level;
}

/** Pi levels are tool scopes; "all" leaves Pi's default toolset untouched. */
export function piPermissionTools(level: PermissionLevel): string[] | null {
	if (level === 'read') return ['read', 'grep', 'find', 'ls'];
	if (level === 'edit') return ['read', 'grep', 'find', 'ls', 'edit', 'write'];
	return null;
}

/** Antigravity levels are mode flags; default mode auto-denies risky tools. */
export function antigravityPermissionArgs(level: PermissionLevel): string[] {
	if (level === 'read') return ['--mode', 'plan'];
	if (level === 'edit') return ['--mode', 'accept-edits'];
	if (level === 'all') return ['--dangerously-skip-permissions'];
	return [];
}
