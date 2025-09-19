import { z } from 'zod';
import type { CapConfig } from './core/types';

type KVNamespace = import('@cloudflare/workers-types').KVNamespace;
type DurableObjectNamespace = import('@cloudflare/workers-types').DurableObjectNamespace;
type D1Database = import('@cloudflare/workers-types').D1Database;

const booleanFlag = z
  .string()
  .optional()
  .transform((val): boolean => (val ?? '').toLowerCase() === 'true');

const numberFromString = z
  .string()
  .optional()
  .transform((val): number => {
    if (!val) return 0;
    const num = Number(val);
    if (Number.isNaN(num)) {
      throw new Error(`Invalid numeric env value: ${val}`);
    }
    return num;
  });

export const configSchema = z.object({
  ENABLE_OPENAI: booleanFlag,
  ENABLE_ANTHROPIC: booleanFlag,
  ENABLE_VERTEX_BILLING_API: booleanFlag,
  ENABLE_VERTEX_BQ: booleanFlag,
  CRON_LOOKBACK_HOURS: numberFromString.default('48'),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_ORG_ID: z.string().optional(),
  OPENAI_PROJECT_ID: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_ORG_ID: z.string().optional(),
  GCP_SA_JSON: z.string().optional(),
  GCP_BILLING_ACCOUNT_ID: z.string().optional(),
  GCP_BUDGET_NAME: z.string().optional(),
  GCP_BQ_PROJECT: z.string().optional(),
  GCP_BQ_DATASET: z.string().optional(),
  GCP_BQ_TABLE: z.string().optional(),
  ADMIN_TOKEN: z.string().optional(),
  SLACK_WEBHOOK_URL: z.string().optional(),
  ALERT_EMAIL_WEBHOOK: z.string().optional(),
  ON_HARDCAP_WEBHOOK: z.string().optional(),
  OPENAI_SOFT_CAP: numberFromString,
  OPENAI_HARD_CAP: numberFromString,
  ANTHROPIC_SOFT_CAP: numberFromString,
  ANTHROPIC_HARD_CAP: numberFromString,
  VERTEX_SOFT_CAP: numberFromString,
  VERTEX_HARD_CAP: numberFromString,
  GLOBAL_SOFT_CAP: numberFromString,
  GLOBAL_HARD_CAP: numberFromString,
});

export type FeatureFlags = {
  openai: boolean;
  anthropic: boolean;
  vertexBillingApi: boolean;
  vertexBigQuery: boolean;
};

export interface RuntimeBindings {
  RAW_PAGES: KVNamespace;
  ROLLUP_DO: DurableObjectNamespace;
  DB?: D1Database;
}

export interface RuntimeConfig {
  flags: FeatureFlags;
  cronLookbackHours: number;
  caps: CapConfig;
  slackWebhook?: string;
  emailWebhook?: string;
  hardCapWebhook?: string;
  adminToken?: string;
  openai: {
    apiKey?: string;
    orgId?: string;
    projectId?: string;
  };
  anthropic: {
    apiKey?: string;
    orgId?: string;
  };
  gcp: {
    serviceAccount?: string;
    billingAccountId?: string;
    budgetName?: string;
    bigQueryProject?: string;
    bigQueryDataset?: string;
    bigQueryTable?: string;
  };
}

export type LoadedEnv = RuntimeConfig & RuntimeBindings;

export const validateCaps = (caps: CapConfig): CapConfig => {
  const sanitized = { ...caps };
  Object.entries(sanitized).forEach(([key, value]) => {
    if (value < 0) {
      throw new Error(`Cap ${key} cannot be negative.`);
    }
  });
  return sanitized;
};

export const loadConfig = (env: Record<string, unknown> & Partial<RuntimeBindings>): LoadedEnv => {
  const parsed = configSchema.parse(env);

  const caps = validateCaps({
    openaiSoft: parsed.OPENAI_SOFT_CAP,
    openaiHard: parsed.OPENAI_HARD_CAP,
    anthropicSoft: parsed.ANTHROPIC_SOFT_CAP,
    anthropicHard: parsed.ANTHROPIC_HARD_CAP,
    vertexSoft: parsed.VERTEX_SOFT_CAP,
    vertexHard: parsed.VERTEX_HARD_CAP,
    globalSoft: parsed.GLOBAL_SOFT_CAP,
    globalHard: parsed.GLOBAL_HARD_CAP,
  });

  const flags: FeatureFlags = {
    openai: parsed.ENABLE_OPENAI,
    anthropic: parsed.ENABLE_ANTHROPIC,
    vertexBillingApi: parsed.ENABLE_VERTEX_BILLING_API,
    vertexBigQuery: parsed.ENABLE_VERTEX_BQ,
  };

  if ((flags.openai && !parsed.OPENAI_API_KEY) || (flags.anthropic && !parsed.ANTHROPIC_API_KEY)) {
    throw new Error('Provider enabled without corresponding API key.');
  }

  if ((flags.vertexBillingApi || flags.vertexBigQuery) && !parsed.GCP_SA_JSON) {
    throw new Error('Google provider requires GCP_SA_JSON secret.');
  }

  if (flags.vertexBillingApi && !parsed.GCP_BUDGET_NAME) {
    throw new Error('ENABLE_VERTEX_BILLING_API requires GCP_BUDGET_NAME.');
  }

  if (flags.vertexBigQuery && (!parsed.GCP_BQ_PROJECT || !parsed.GCP_BQ_DATASET || !parsed.GCP_BQ_TABLE)) {
    throw new Error('ENABLE_VERTEX_BQ requires GCP_BQ_PROJECT, GCP_BQ_DATASET, and GCP_BQ_TABLE.');
  }

  return {
    RAW_PAGES: (env as RuntimeBindings).RAW_PAGES,
    ROLLUP_DO: (env as RuntimeBindings).ROLLUP_DO,
    DB: (env as RuntimeBindings).DB,
    flags,
    cronLookbackHours: parsed.CRON_LOOKBACK_HOURS,
    caps,
    slackWebhook: parsed.SLACK_WEBHOOK_URL || undefined,
    emailWebhook: parsed.ALERT_EMAIL_WEBHOOK || undefined,
    hardCapWebhook: parsed.ON_HARDCAP_WEBHOOK || undefined,
    adminToken: parsed.ADMIN_TOKEN || undefined,
    openai: {
      apiKey: parsed.OPENAI_API_KEY || undefined,
      orgId: parsed.OPENAI_ORG_ID || undefined,
      projectId: parsed.OPENAI_PROJECT_ID || undefined,
    },
    anthropic: {
      apiKey: parsed.ANTHROPIC_API_KEY || undefined,
      orgId: parsed.ANTHROPIC_ORG_ID || undefined,
    },
    gcp: {
      serviceAccount: parsed.GCP_SA_JSON || undefined,
      billingAccountId: parsed.GCP_BILLING_ACCOUNT_ID || undefined,
      budgetName: parsed.GCP_BUDGET_NAME || undefined,
      bigQueryProject: parsed.GCP_BQ_PROJECT || undefined,
      bigQueryDataset: parsed.GCP_BQ_DATASET || undefined,
      bigQueryTable: parsed.GCP_BQ_TABLE || undefined,
    },
  };
};
