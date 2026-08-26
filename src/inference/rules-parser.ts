/** Pure parsers for routing rules, model groups, and scoring preferences. */

import type {
	InferenceModelScores,
	ModelCondition,
	ModelGroupMap,
	ModelRef,
	OverrideRule,
	RouteTargetExpression,
	ScoreDimension,
	ScoringPreference
} from './types.ts';

export function stripOverrideComment(line: string) {
	const index = line.indexOf('#');
	return index === -1 ? line : line.slice(0, index);
}

export function normalizePreference(
	rawWeights: Map<string, number>,
	source: string,
	dimensions: Map<string, ScoreDimension>
) {
	let total = 0;
	for (const [dimension, weight] of rawWeights) {
		if (!dimensions.has(dimension)) {
			throw new Error(`${source}: unknown scoring dimension "${dimension}".`);
		}
		if (!Number.isFinite(weight) || weight <= 0) {
			throw new Error(`${source}: scoring weight for "${dimension}" must be greater than 0.`);
		}
		total += weight;
	}
	if (total <= 0) throw new Error(`${source}: scoring preference must include at least one dimension.`);

	const normalized: ScoringPreference = new Map();
	for (const [dimension, weight] of rawWeights) {
		normalized.set(dimension, (weight / total) * 100);
	}
	return normalized;
}

function parsePreferenceText(text: string, source: string, scores: InferenceModelScores) {
	const raw = text.trim();
	if (!raw) return new Map(scores.defaultPreference);

	const parts = raw
		.split(',')
		.map((part) => part.trim())
		.filter(Boolean);
	if (!parts.length) throw new Error(`${source}: "prefer" must name at least one scoring dimension.`);

	const weightedEntries = parts.filter((part) => part.includes(':'));
	if (weightedEntries.length > 0 && weightedEntries.length !== parts.length) {
		throw new Error(`${source}: do not mix weighted and unweighted scoring dimensions in one "prefer" clause.`);
	}

	const rawWeights: ScoringPreference = new Map();
	for (const part of parts) {
		if (part.includes(':')) {
			const [dimensionPart, weightPart] = part.split(':', 2);
			const dimension = dimensionPart.trim();
			const weight = Number(weightPart.trim());
			rawWeights.set(dimension, weight);
			continue;
		}
		rawWeights.set(part, 1);
	}
	return normalizePreference(rawWeights, source, scores.dimensions);
}

function isFullWildcard(raw: string) {
	const compact = raw.replace(/\s+/g, '');
	return compact === '*' || compact === '**' || compact === '*>*';
}

export function parseOverrideRef(rawInput: string, lineNumber: number, side: 'selector' | 'override'): ModelRef {
	const raw = rawInput.trim().replace(/\s+/g, '');
	if (!raw) throw new Error(`Provider override line ${lineNumber}: empty ${side}.`);
	if (isFullWildcard(raw)) {
		return {
			providerId: '',
			modelId: '',
			variantId: '',
			providerWildcard: true,
			modelWildcard: true,
			variantWildcard: true,
			variantSpecified: false,
			raw: rawInput.trim()
		};
	}

	let providerPart = '';
	let modelAndVariantPart = raw;
	const providerSeparatorIndex = raw.indexOf('>');
	if (providerSeparatorIndex !== -1) {
		providerPart = raw.slice(0, providerSeparatorIndex);
		modelAndVariantPart = raw.slice(providerSeparatorIndex + 1);
	} else if (raw.startsWith('*') && raw.length > 1) {
		providerPart = '*';
		modelAndVariantPart = raw.slice(1);
	} else if (side === 'override') {
		throw new Error(
			`Provider override line ${lineNumber}: override "${rawInput.trim()}" must include a provider or provider wildcard.`
		);
	} else {
		providerPart = '*';
	}

	let modelPart = modelAndVariantPart;
	let variantPart = '';
	let variantSpecified = false;
	const atIndex = modelAndVariantPart.indexOf('@');
	if (atIndex !== -1) {
		modelPart = modelAndVariantPart.slice(0, atIndex);
		variantPart = modelAndVariantPart.slice(atIndex + 1);
		variantSpecified = true;
	} else {
		const variantSeparatorIndex = modelAndVariantPart.indexOf('>');
		if (variantSeparatorIndex !== -1) {
			modelPart = modelAndVariantPart.slice(0, variantSeparatorIndex);
			variantPart = modelAndVariantPart.slice(variantSeparatorIndex + 1);
			variantSpecified = true;
		}
	}

	const providerWildcard = !providerPart || providerPart === '*';
	const modelWildcard = !modelPart || modelPart === '*';
	const variantWildcard = !variantPart || variantPart === '*';
	if (variantSpecified && !variantWildcard && (providerWildcard || modelWildcard)) {
		throw new Error(
			`Provider override line ${lineNumber}: ${side} "${rawInput.trim()}" specifies a variant, so provider and model must both be concrete names.`
		);
	}

	return {
		providerId: providerWildcard ? '' : providerPart,
		modelId: modelWildcard ? '' : modelPart,
		variantId: variantWildcard ? '' : variantPart,
		providerWildcard,
		modelWildcard,
		variantWildcard,
		variantSpecified,
		raw: rawInput.trim()
	};
}

export function parseRouteTargetExpression(rawInput: string, lineNumber: number, side: 'selector' | 'override'): RouteTargetExpression {
	const raw = rawInput.trim();
	const compact = raw.replace(/\s+/g, '');
	if (isFullWildcard(compact)) {
		return {
			raw,
			provider: '',
			providerWildcard: true,
			condition: { kind: 'any' },
			direct: parseOverrideRef(raw, lineNumber, side)
		};
	}

	const groupOrConditionLike = /[$()&|!]/.test(compact);
	if (!groupOrConditionLike) {
		const direct = parseOverrideRef(raw, lineNumber, side);
		return {
			raw,
			provider: direct.providerId,
			providerWildcard: direct.providerWildcard,
			condition: direct.modelWildcard ? { kind: 'any' } : { kind: 'ref', ref: direct },
			direct
		};
	}

	let providerPart = '*';
	let conditionPart = compact;
	const providerSeparatorIndex = compact.indexOf('>');
	if (providerSeparatorIndex !== -1) {
		providerPart = compact.slice(0, providerSeparatorIndex) || '*';
		conditionPart = compact.slice(providerSeparatorIndex + 1);
	}

	if (conditionPart.startsWith('(') && conditionPart.endsWith(')')) {
		conditionPart = conditionPart.slice(1, -1);
	}

	const providerWildcard = providerPart === '*';
	return {
		raw,
		provider: providerWildcard ? '' : providerPart,
		providerWildcard,
		condition: new ModelConditionParser(conditionPart, lineNumber).parse()
	};
}

class ModelConditionParser {
	index = 0;
	input: string;
	lineNumber: number;

	constructor(input: string, lineNumber: number) {
		this.input = input;
		this.lineNumber = lineNumber;
	}

	parse(): ModelCondition {
		const value = this.parseOr();
		if (this.peek()) {
			throw new Error(`Provider override line ${this.lineNumber}: unexpected token near "${this.input.slice(this.index)}".`);
		}
		return value;
	}

	parseOr(): ModelCondition {
		let left = this.parseAnd();
		while (this.consume('|')) {
			left = { kind: 'or', left, right: this.parseAnd() };
		}
		return left;
	}

	parseAnd(): ModelCondition {
		let left = this.parseUnary();
		while (this.consume('&')) {
			left = { kind: 'and', left, right: this.parseUnary() };
		}
		return left;
	}

	parseUnary(): ModelCondition {
		if (this.consume('!')) return { kind: 'not', value: this.parseUnary() };
		if (this.consume('(')) {
			const value = this.parseOr();
			if (!this.consume(')')) throw new Error(`Provider override line ${this.lineNumber}: missing closing ")".`);
			return value;
		}
		return this.parseAtom();
	}

	parseAtom(): ModelCondition {
		const start = this.index;
		while (this.index < this.input.length && !'&|()'.includes(this.input[this.index])) {
			this.index += 1;
		}
		const token = this.input.slice(start, this.index).trim();
		if (!token) throw new Error(`Provider override line ${this.lineNumber}: expected condition token.`);
		if (token === '_same') return { kind: 'same', scope: 'exact' };
		if (token === '*>*@_same') return { kind: 'same', scope: 'exact' };
		if (token === '_same>*' || token === '_same>*@*') return { kind: 'same', scope: 'provider' };
		if (token === '*>_same') return { kind: 'same', scope: 'model' };
		if (token.startsWith('$')) return { kind: 'group', name: token.slice(1) };
		return { kind: 'ref', ref: parseOverrideRef(token, this.lineNumber, 'selector') };
	}

	peek() {
		return this.input[this.index] ?? '';
	}

	consume(value: string) {
		if (this.input[this.index] !== value) return false;
		this.index += 1;
		return true;
	}
}

export function parseModelGroups(text: string): ModelGroupMap {
	const groups: ModelGroupMap = new Map();
	let activeGroup = '';
	for (const [index, rawLine] of text.split(/\r?\n/).entries()) {
		const lineNumber = index + 1;
		const line = stripOverrideComment(rawLine).trim();
		if (!line) continue;
		if (line.endsWith(':')) {
			activeGroup = line.slice(0, -1).trim();
			if (!activeGroup) throw new Error(`Model group line ${lineNumber}: empty group name.`);
			if (!groups.has(activeGroup)) groups.set(activeGroup, []);
			continue;
		}
		if (!activeGroup) throw new Error(`Model group line ${lineNumber}: selector appears before a group header.`);
		groups.get(activeGroup)?.push(parseOverrideRef(line, lineNumber, 'selector'));
	}
	return groups;
}

export function parseProviderOverrideRules(text: string, scores: InferenceModelScores) {
	const rules: OverrideRule[] = [];
	for (const [index, rawLine] of text.split(/\r?\n/).entries()) {
		const lineNumber = index + 1;
		const line = stripOverrideComment(rawLine).trim();
		if (!line) continue;
		const separatorIndex = line.indexOf('=');
		if (separatorIndex === -1) {
			throw new Error(`Provider override line ${lineNumber}: expected "selector = override".`);
		}
		const selectorText = line.slice(0, separatorIndex).trim();
		const rawOverrideText = line.slice(separatorIndex + 1).trim();
		const preferMatch = rawOverrideText.match(/\s+prefer\s+/i);
		const overrideText = preferMatch ? rawOverrideText.slice(0, preferMatch.index).trim() : rawOverrideText;
		const preferenceText = preferMatch
			? rawOverrideText.slice((preferMatch.index ?? 0) + preferMatch[0].length).trim()
			: '';
		if (!overrideText) throw new Error(`Provider override line ${lineNumber}: empty override.`);
		rules.push({
			lineNumber,
			selectorText,
			overrideText,
			preferenceText,
			preference: parsePreferenceText(preferenceText, `Provider override line ${lineNumber}`, scores),
			selector: parseRouteTargetExpression(selectorText, lineNumber, 'selector'),
			override: parseRouteTargetExpression(overrideText, lineNumber, 'override')
		});
	}
	return rules;
}
