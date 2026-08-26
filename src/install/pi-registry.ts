/** Pi's model registry: generate our provider entry from the proxy's own config. */

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { CONFIG_DIR } from '../paths.ts';
import { heading, report } from './report.ts';

export const PI_PROVIDER = 'cladgpt-proxy';

export interface PiModel {
	id: string;
	name?: string;
	reasoning?: boolean;
	contextWindow?: number;
	maxTokens?: number;
	[key: string]: unknown;
}

export function piModelsPath() {
	const home = process.env.USERPROFILE || process.env.HOME || '';
	return home ? resolve(home, '.pi/agent/models.json') : '';
}

/**
 * Build the model list from this proxy's own provider config, so it cannot
 * drift from what the proxy will actually accept. Only default variants are
 * listed — the non-default ones are still reachable by typing the full
 * `provider>model@variant` id at the API.
 */
async function modelsFromProxyConfig(): Promise<PiModel[]> {
	const YAML = (await import('yaml')).default;
	const baseInterface = YAML.parse(
		readFileSync(resolve(CONFIG_DIR, 'base-ai-request-interface.yaml'), 'utf8')
	) as { model_defaults?: Record<string, Record<string, unknown>> };
	const config = YAML.parse(readFileSync(resolve(CONFIG_DIR, 'inference-providers.yaml'), 'utf8')) as {
		models?: Record<string, { label?: string; context_length?: number }>;
		providers?: Record<
			string,
			{
				label?: string;
				models?: Record<
					string,
					{
						default_variant: string;
						variants?: Record<string, Record<string, unknown>>;
					}
				>;
			}
		>;
	};

	const rows: PiModel[] = [];
	for (const [providerId, provider] of Object.entries(config.providers ?? {})) {
		for (const [modelId, model] of Object.entries(provider.models ?? {})) {
			const variant = model.variants?.[model.default_variant] ?? {};
			const canonical = config.models?.[modelId];
			const label = canonical?.label ?? modelId;
			const tuned = baseInterface.model_defaults?.[modelId];
			rows.push({
				// The `.` form: shell-safe, and Pi reads `:` as a thinking suffix.
				id: `${providerId}.${modelId}`,
				name: `${label} via ${provider.label ?? providerId}`,
				// A provider variant that states its own limit wins; otherwise the
				// canonical model's published window, and only then a safe floor.
				reasoning:
					variant.reasoning_effort === true ||
					variant.custom_reasoning === true ||
					Boolean(tuned?.reasoning_effort),
				contextWindow: Number(variant.context_length) || Number(canonical?.context_length) || 128_000,
				maxTokens:
					Number(variant.max_completion_tokens) || Number(tuned?.max_tokens) || 32_768
			});
		}
	}
	return rows.sort((a, b) => a.id.localeCompare(b.id));
}

export async function checkPiModels(port: number, refreshModels: boolean) {
	heading('Pi model registry');
	const path = piModelsPath();
	if (!path) {
		report('models.json', 'failed', 'no home directory to write into');
		return;
	}

	let document: { providers?: Record<string, Record<string, unknown>> } = {};
	if (existsSync(path)) {
		try {
			document = JSON.parse(readFileSync(path, 'utf8')) as typeof document;
		} catch {
			report('models.json', 'failed', `${path} is not valid JSON; fix or delete it and re-run`);
			return;
		}
	} else {
		mkdirSync(dirname(path), { recursive: true });
	}

	document.providers ??= {};
	const existing = document.providers[PI_PROVIDER] as { models?: PiModel[] } | undefined;
	const generated = await modelsFromProxyConfig();

	// Keep any hand-tuned numbers: an id already present wins over the generated
	// row. New ids get added; ids no longer in the proxy config get dropped.
	// `--refresh-models` throws that away and takes the config's word for it,
	// which is what you want after correcting a context window or a default.
	const previous = refreshModels
		? new Map<string, PiModel>()
		: new Map((existing?.models ?? []).map((model) => [model.id, model]));
	const merged = generated.map((model) => previous.get(model.id) ?? model);
	const added = merged.filter((model) => !previous.has(model.id)).length;
	const removed = [...previous.keys()].filter((id) => !generated.some((m) => m.id === id)).length;

	document.providers[PI_PROVIDER] = {
		baseUrl: `http://127.0.0.1:${port}/v1`,
		api: 'openai-completions',
		apiKey: 'local',
		authHeader: true,
		compat: { supportsDeveloperRole: false, supportsReasoningEffort: true },
		models: merged
	};

	const next = `${JSON.stringify(document, null, 2)}\n`;
	if (existsSync(path) && readFileSync(path, 'utf8') === next) {
		report(`provider "${PI_PROVIDER}"`, 'already', `${merged.length} models at port ${port}`);
		return;
	}
	if (existsSync(path)) {
		copyFileSync(path, `${path}.bak`);
		report('backup', 'done', `${path}.bak`);
	}
	writeFileSync(path, next);
	const others = Object.keys(document.providers).filter((key) => key !== PI_PROVIDER);
	report(
		`provider "${PI_PROVIDER}"`,
		added || removed ? 'done' : 'already',
		`${merged.length} models (+${added} −${removed}) at port ${port}` +
			(others.length ? `; left ${others.length} other provider(s) untouched` : '')
	);
}
