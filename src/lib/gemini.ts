import { ApiTierMode, BatchContextResponse, BatchResponseMeta, LeadGenResult } from "../types";

export class LeadGenApiError extends Error {
  status: number;
  code?: string;
  isQuotaExhausted?: boolean;
  retryAfterSeconds?: number;

  constructor(
    message: string,
    status: number,
    code?: string,
    isQuotaExhausted?: boolean,
    retryAfterSeconds?: number
  ) {
    super(message);
    this.name = "LeadGenApiError";
    this.status = status;
    this.code = code;
    this.isQuotaExhausted = isQuotaExhausted;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export interface TargetInput {
  company: string;
  domain: string;
}

export interface BatchLeadGenResponse {
  results: LeadGenResult[];
  meta?: BatchResponseMeta;
}

export const leadGenService = {
  async analyzeBatchContext(
    sampleTargets: string[],
    roles: string[],
    mode: ApiTierMode = "auto"
  ): Promise<BatchContextResponse> {
    try {
      const response = await fetch("/api/leads/batch-context", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ sampleTargets, roles, mode }),
      });
      if (!response.ok) {
        return { batchIndustry: "", nicheKeywords: [] };
      }
      const data = await response.json().catch(() => ({}));
      return {
        batchIndustry: typeof data?.batchIndustry === "string" ? data.batchIndustry : "",
        nicheKeywords: Array.isArray(data?.nicheKeywords) ? data.nicheKeywords : [],
      };
    } catch {
      return { batchIndustry: "", nicheKeywords: [] };
    }
  },

  async findLeads(
    company: string,
    domain: string,
    roles: string[],
    mode: ApiTierMode = "auto",
    batchIndustry = ""
  ): Promise<LeadGenResult> {
    const response = await fetch("/api/leads", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ company, domain, roles, mode, batchIndustry }),
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      const message =
        typeof data?.error === "string" && data.error
          ? data.error
          : `Request failed with status ${response.status}`;
      throw new LeadGenApiError(
        message,
        response.status,
        data?.code,
        Boolean(data?.isQuotaExhausted),
        typeof data?.retryAfterSeconds === "number" ? data.retryAfterSeconds : undefined
      );
    }

    return data as LeadGenResult;
  },

  async findLeadsBatch(
    targets: TargetInput[],
    roles: string[],
    mode: ApiTierMode = "auto",
    batchIndustry = ""
  ): Promise<BatchLeadGenResponse> {
    const response = await fetch("/api/leads/batch", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ targets, roles, mode, batchIndustry }),
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      const message =
        typeof data?.error === "string" && data.error
          ? data.error
          : `Request failed with status ${response.status}`;
      throw new LeadGenApiError(
        message,
        response.status,
        data?.code,
        Boolean(data?.isQuotaExhausted),
        typeof data?.retryAfterSeconds === "number" ? data.retryAfterSeconds : undefined
      );
    }

    return {
      results: Array.isArray(data?.results) ? (data.results as LeadGenResult[]) : [],
      meta: data?.meta as BatchResponseMeta | undefined,
    };
  },
};
