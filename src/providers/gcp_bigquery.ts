import { formatUtcDate } from '../core/rollups';
import { fetchWithRetry, parseJsonResponse } from '../core/http';
import type { ProviderFetchOptions, ProviderRawPage, ProviderResult, SpendRow } from '../core/types';
import { mintAccessToken } from './google_auth';

interface BigQueryConfig {
  serviceAccountJson: string;
  projectId: string;
  dataset: string;
  table: string;
  projectFilter?: string[];
  labelFilters?: Record<string, string>;
}

interface BigQueryRowField {
  v: string | null;
}

interface BigQueryRow {
  f: BigQueryRowField[];
}

interface BigQueryResponse {
  jobComplete: boolean;
  rows?: BigQueryRow[];
  totalRows?: string;
}

const BIGQUERY_SCOPE = 'https://www.googleapis.com/auth/bigquery';

const buildQuery = (config: BigQueryConfig, options: ProviderFetchOptions): { query: string; parameters: any[] } => {
  const filters: string[] = ["LOWER(sku.description) LIKE 'vertex ai%'"];
  const parameters: any[] = [
    { name: 'from', parameterType: { type: 'STRING' }, parameterValue: { value: options.from } },
    { name: 'to', parameterType: { type: 'STRING' }, parameterValue: { value: options.to } },
  ];

  if (config.projectFilter && config.projectFilter.length > 0) {
    filters.push('project.id IN UNNEST(@projectIds)');
    parameters.push({
      name: 'projectIds',
      parameterType: { type: 'ARRAY', arrayType: { type: 'STRING' } },
      parameterValue: { arrayValues: config.projectFilter.map((value) => ({ value })) },
    });
  }

  if (config.labelFilters) {
    let index = 0;
    for (const [key, value] of Object.entries(config.labelFilters)) {
      index += 1;
      const keyName = `labelKey${index}`;
      const valueName = `labelValue${index}`;
      filters.push(
        `EXISTS (SELECT 1 FROM UNNEST(labels) AS label${index} WHERE label${index}.key = @${keyName} AND label${index}.value = @${valueName})`,
      );
      parameters.push(
        { name: keyName, parameterType: { type: 'STRING' }, parameterValue: { value: key } },
        { name: valueName, parameterType: { type: 'STRING' }, parameterValue: { value } },
      );
    }
  }

  const filterClause = filters.length > 0 ? `AND ${filters.join(' AND ')}` : '';
  const tableRef = `\`${config.dataset}.${config.table}\``;
  const query = `
    SELECT
      FORMAT_DATE('%Y-%m-%d', DATE(usage_start_time)) AS day,
      SUM(cost) AS cost_usd,
      ANY_VALUE(currency) AS currency
    FROM ${tableRef}
    WHERE DATE(usage_start_time) BETWEEN @from AND @to
      ${filterClause}
    GROUP BY day
    ORDER BY day
  `;

  return { query, parameters };
};

const toRows = (rows: BigQueryRow[] | undefined): SpendRow[] => {
  if (!rows) return [];
  return rows.map((row) => {
    const [dayField, costField, currencyField] = row.f;
    return {
      provider: 'vertex',
      day: (dayField?.v as string) ?? formatUtcDate(new Date()),
      cost_usd: Number(costField?.v ?? 0),
      currency: ((currencyField?.v as string) ?? 'USD') as 'USD',
      source: 'bq_export',
    } satisfies SpendRow;
  });
};

export const fetchVertexSpendViaBigQuery = async (
  config: BigQueryConfig,
  options: ProviderFetchOptions,
): Promise<ProviderResult<BigQueryResponse>> => {
  const token = await mintAccessToken(config.serviceAccountJson, [BIGQUERY_SCOPE], options.fetchImpl);
  const { query, parameters } = buildQuery(config, options);
  const response = await fetchWithRetry({
    request: `https://bigquery.googleapis.com/bigquery/v2/projects/${config.projectId}/queries`,
    init: {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token.access_token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        useLegacySql: false,
        query,
        parameterMode: 'NAMED',
        queryParameters: parameters,
      }),
    },
    fetchImpl: options.fetchImpl,
  });

  const result = await parseJsonResponse<BigQueryResponse>(response);
  return {
    rows: toRows(result.rows),
    rawPages: [
      {
        id: crypto.randomUUID(),
        provider: 'vertex',
        fetchedAt: new Date().toISOString(),
        window: { from: options.from, to: options.to },
        payload: result,
        meta: { endpoint: 'bigquery' },
      },
    ],
  };
};

export const vertexBigQueryRowsFromRaw = (pages: ProviderRawPage<any>[]): SpendRow[] => {
  return pages
    .filter((page) => page.meta?.endpoint === 'bigquery' || !page.meta)
    .flatMap((page) => toRows((page.payload as BigQueryResponse).rows));
};
