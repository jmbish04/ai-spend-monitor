import { GroupByOption, ProviderName, SpendRow } from './types';

export interface SpendAggregation {
	key: string;
	provider?: ProviderName | 'global';
	model?: string;
	day?: string;
	cost_usd: number;
	input_tokens?: number;
	output_tokens?: number;
	currency: 'USD';
	rows: SpendRow[];
}

const RETENTION_DAYS = 9000;

export const formatUtcDate = (date: Date): string => {
	const year = date.getUTCFullYear();
	const month = `${date.getUTCMonth() + 1}`.padStart(2, '0');
	const day = `${date.getUTCDate()}`.padStart(2, '0');
	return `${year}-${month}-${day}`;
};

export const makeRowKey = (row: SpendRow): string =>
	`${row.provider}|${row.day}|${row.model ?? ''}`;

export const pruneRows = (rows: SpendRow[], now: Date, retentionDays = RETENTION_DAYS): SpendRow[] => {
	const cutoff = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
	cutoff.setUTCDate(cutoff.getUTCDate() - retentionDays);
	const cutoffStr = formatUtcDate(cutoff);
	return rows.filter((row) => row.day >= cutoffStr);
};

export const upsertRows = (existing: SpendRow[], incoming: SpendRow[], now: Date): SpendRow[] => {
	const merged = new Map<string, SpendRow>();
	for (const row of existing) {
		merged.set(makeRowKey(row), row);
	}
	for (const row of incoming) {
		merged.set(makeRowKey(row), row);
	}
	return pruneRows(Array.from(merged.values()), now).sort((a, b) => a.day.localeCompare(b.day));
};

export const filterRowsByRange = (rows: SpendRow[], from?: string, to?: string): SpendRow[] => {
	return rows.filter((row) => {
		if (from && row.day < from) return false;
		if (to && row.day > to) return false;
		return true;
	});
};

const accumulate = (target: SpendAggregation, row: SpendRow): void => {
	target.cost_usd += row.cost_usd;
	if (row.input_tokens) {
		target.input_tokens = (target.input_tokens ?? 0) + row.input_tokens;
	}
	if (row.output_tokens) {
		target.output_tokens = (target.output_tokens ?? 0) + row.output_tokens;
	}
	target.rows.push(row);
};

export const aggregateRows = (rows: SpendRow[], groupBy?: GroupByOption): SpendAggregation[] => {
	if (!groupBy) {
		return rows.map((row) => ({
			key: makeRowKey(row),
			provider: row.provider,
			model: row.model,
			day: row.day,
			cost_usd: row.cost_usd,
			input_tokens: row.input_tokens,
			output_tokens: row.output_tokens,
			currency: row.currency,
			rows: [row],
		}));
	}

	const aggregates = new Map<string, SpendAggregation>();

	for (const row of rows) {
		let key: string;
		const template: Partial<SpendAggregation> = {};

		switch (groupBy) {
			case 'provider':
				key = row.provider;
				template.provider = row.provider;
				break;
			case 'day':
				key = row.day;
				template.day = row.day;
				template.provider = 'global';
				break;
			case 'model':
				key = `${row.provider}:${row.model ?? 'unknown'}`;
				template.provider = row.provider;
				template.model = row.model;
				break;
			default:
				key = makeRowKey(row);
				template.provider = row.provider;
				template.model = row.model;
				template.day = row.day;
		}

		const existing = aggregates.get(key);
		if (!existing) {
			aggregates.set(key, {
				key,
				cost_usd: 0,
				currency: 'USD',
				rows: [],
				...(template.provider ? { provider: template.provider } : {}),
				...(template.model ? { model: template.model } : {}),
				...(template.day ? { day: template.day } : {}),
			});
		}
		accumulate(aggregates.get(key)!, row);
	}

	return Array.from(aggregates.values()).sort((a, b) => a.key.localeCompare(b.key));
};

export const monthToDateRows = (rows: SpendRow[], now: Date): SpendRow[] => {
	const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
	const startStr = formatUtcDate(start);
	const todayStr = formatUtcDate(now);
	return filterRowsByRange(rows, startStr, todayStr);
};
