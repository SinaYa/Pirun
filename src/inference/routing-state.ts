/** The live routing snapshot: cache, hot reload, and broken-edit recovery. */

import { appendFile, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { CONFIG_DIR } from '../paths.ts';
import { modelScores } from './catalog.ts';
import { parseModelGroups, parseProviderOverrideRules } from './rules-parser.ts';
import type {
	CascadedInferenceRoutingRefreshResult,
	CascadedInferenceRoutingSnapshot
} from './types.ts';

const ROUTING_FILE_PATH = resolve(CONFIG_DIR, 'cascaded-inference-routing.rules');
const ROUTING_RECOVERED_FILE_PATH = resolve(CONFIG_DIR, 'cascaded-inference-routing.recovered.rules');
const GROUP_FILE_PATH = resolve(CONFIG_DIR, 'inference-model-groups.rules');
const BUILTIN_ROUTING_TEXT = '';
const BUILTIN_GROUP_TEXT = '';

function createRoutingSnapshot(input: {
	text: string;
	groupText: string;
	sourcePath: string;
	groupSourcePath: string;
	version: string;
}): CascadedInferenceRoutingSnapshot {
	const groups = parseModelGroups(input.groupText);
	const rules = parseProviderOverrideRules(input.text, modelScores);
	return {
		version: input.version,
		sourcePath: input.sourcePath,
		groupSourcePath: input.groupSourcePath,
		ruleCount: rules.length,
		groupCount: groups.size,
		loadedAt: new Date().toISOString(),
		text: input.text,
		groupText: input.groupText,
		rules,
		groups,
		scores: modelScores
	};
}

let routingCache = createRoutingSnapshot({
	text: BUILTIN_ROUTING_TEXT,
	groupText: BUILTIN_GROUP_TEXT,
	sourcePath: 'builtin:cascaded-inference-routing.rules',
	groupSourcePath: 'builtin:inference-model-groups.rules',
	version: 'bundled'
});
let routingRefreshPromise: Promise<CascadedInferenceRoutingRefreshResult> | null = null;

/** The last good snapshot, for resolution calls that did not pass one. */
export function currentRoutingSnapshot() {
	return routingCache;
}

function cloneRoutingSnapshot(snapshot: CascadedInferenceRoutingSnapshot): CascadedInferenceRoutingSnapshot {
	return {
		...snapshot,
		rules: [...snapshot.rules],
		groups: new Map(snapshot.groups),
		scores: snapshot.scores
	};
}

function routingVersion(stats: { mtimeMs: number; size: number }) {
	return `${stats.mtimeMs}:${stats.size}`;
}

function isMissingFileError(error: unknown) {
	return Boolean(error && typeof error === 'object' && (error as { code?: unknown }).code === 'ENOENT');
}

function timestampForFilename(date = new Date()) {
	return date.toISOString().replace(/[:.]/g, '-');
}

function appendRecoveryNote(text: string, note: string) {
	const trimmed = text.endsWith('\n') ? text : `${text}\n`;
	return `${trimmed}\n${note.trim()}\n`;
}

function buildInvalidRecoveryNote(input: { at: string; error: string; recoveredPath: string }) {
	return [
		'# Recovery note:',
		`# This routing file failed to parse at ${input.at}.`,
		`# Error: ${input.error}`,
		`# The previous working routing rules were restored to ${basename(ROUTING_FILE_PATH)}`,
		`# and copied to ${basename(input.recoveredPath)}.`
	].join('\n');
}

function buildRecoveredNote(input: { at: string; error: string; invalidPath: string }) {
	return [
		'# Recovery note:',
		`# This file was restored from the last known-good routing rules at ${input.at}.`,
		`# A broken edit was moved to ${basename(input.invalidPath)}.`,
		`# Error: ${input.error}`
	].join('\n');
}

async function readRoutingCandidate() {
	const groupStats = await stat(GROUP_FILE_PATH).catch((error) => {
		if (!isMissingFileError(error)) throw error;
		return null;
	});
	try {
		const stats = await stat(ROUTING_FILE_PATH);
		return {
			path: ROUTING_FILE_PATH,
			stats,
			groupPath: GROUP_FILE_PATH,
			groupStats,
			recovered: false
		};
	} catch (error) {
		if (!isMissingFileError(error)) throw error;
	}

	try {
		const stats = await stat(ROUTING_RECOVERED_FILE_PATH);
		return {
			path: ROUTING_RECOVERED_FILE_PATH,
			stats,
			groupPath: GROUP_FILE_PATH,
			groupStats,
			recovered: true
		};
	} catch (error) {
		if (!isMissingFileError(error)) throw error;
	}

	return null;
}

async function recoverInvalidRoutingFile(input: {
	invalidText: string;
	groupText: string;
	error: string;
	candidatePath: string;
}) {
	const at = new Date().toISOString();
	const invalidPath = resolve(
		dirname(ROUTING_FILE_PATH),
		`cascaded-inference-routing.${timestampForFilename(new Date(at))}.invalid.rules`
	);
	const recoveredPath = ROUTING_RECOVERED_FILE_PATH;

	if (input.candidatePath === ROUTING_FILE_PATH) {
		await rename(input.candidatePath, invalidPath);
		await appendFile(
			invalidPath,
			`\n${buildInvalidRecoveryNote({ at, error: input.error, recoveredPath })}\n`,
			'utf8'
		);
	} else {
		await writeFile(
			invalidPath,
			appendRecoveryNote(
				input.invalidText,
				buildInvalidRecoveryNote({ at, error: input.error, recoveredPath })
			),
			'utf8'
		);
	}

	const recoveredText = appendRecoveryNote(
		routingCache.text,
		buildRecoveredNote({ at, error: input.error, invalidPath })
	);
	await writeFile(ROUTING_FILE_PATH, recoveredText, 'utf8');
	await writeFile(recoveredPath, recoveredText, 'utf8');
	const stats = await stat(ROUTING_FILE_PATH);
	routingCache = createRoutingSnapshot({
		text: recoveredText,
		groupText: input.groupText,
		sourcePath: ROUTING_FILE_PATH,
		groupSourcePath: GROUP_FILE_PATH,
		version: routingVersion(stats)
	});

	return {
		invalidPath,
		recoveredPath
	};
}

async function refreshCascadedInferenceRoutingInner(): Promise<CascadedInferenceRoutingRefreshResult> {
	const candidate = await readRoutingCandidate();
	if (!candidate) {
		return {
			snapshot: cloneRoutingSnapshot(routingCache),
			reloaded: false,
			recovered: false,
			error: 'No cascaded inference routing file or recovered routing file was found; using in-memory rules.'
		};
	}

	const groupText = candidate.groupStats ? await readFile(candidate.groupPath, 'utf8') : BUILTIN_GROUP_TEXT;
	const groupVersion = candidate.groupStats ? routingVersion(candidate.groupStats) : 'no-groups';
	const version = `${routingVersion(candidate.stats)}:${groupVersion}`;
	if (routingCache.sourcePath === candidate.path && routingCache.version === version) {
		return {
			snapshot: cloneRoutingSnapshot(routingCache),
			reloaded: false,
			recovered: false
		};
	}

	const text = await readFile(candidate.path, 'utf8');
	try {
		routingCache = createRoutingSnapshot({
			text,
			groupText,
			sourcePath: candidate.path,
			groupSourcePath: candidate.groupPath,
			version
		});
		return {
			snapshot: cloneRoutingSnapshot(routingCache),
			reloaded: true,
			recovered: candidate.recovered
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const recovery = await recoverInvalidRoutingFile({
			invalidText: text,
			groupText,
			error: message,
			candidatePath: candidate.path
		});
		return {
			snapshot: cloneRoutingSnapshot(routingCache),
			reloaded: true,
			recovered: true,
			error: message,
			invalidPath: recovery.invalidPath,
			recoveredPath: recovery.recoveredPath
		};
	}
}

export async function refreshCascadedInferenceRouting(): Promise<CascadedInferenceRoutingRefreshResult> {
	if (!routingRefreshPromise) {
		routingRefreshPromise = refreshCascadedInferenceRoutingInner().finally(() => {
			routingRefreshPromise = null;
		});
	}
	const result = await routingRefreshPromise;
	return {
		...result,
		snapshot: cloneRoutingSnapshot(result.snapshot)
	};
}
