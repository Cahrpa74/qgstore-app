export interface Lead {
  name: string;
  role: string;
  email_placeholder: string;
  email_type?: 'VERIFIED' | 'PATTERN' | 'UNAVAILABLE';
  sourceUrl: string;
  linkedinUrl?: string;
  verifiedOnLinkedIn?: boolean;
}

export interface GroundingSource {
  title: string;
  url: string;
}

export type VerificationStage =
  | 'SITE_AND_LINKEDIN_VERIFIED'
  | 'SITE_VERIFIED_ROLES_MISSING'
  | 'UNVERIFIED';

export interface CompanyIntel {
  websiteUrl?: string;
  brandName?: string;
  redirectedDomain?: string;
  industry?: string;
  linkedinCompanyUrl?: string;
  verificationStage?: VerificationStage;
  rolesMissing?: string[];
  secondPassExecuted?: boolean;
  emails: string[];
  phones: string[];
  location?: string;
  socialLinks: string[];
  groundingSources: GroundingSource[];
}

export interface LeadGenResult {
  companyName: string;
  domain: string;
  leads: Lead[];
  companyIntel?: CompanyIntel;
  statusDetail?: string;
}

export type AppMode = 'LEAD_GEN' | 'HISTORY';

export type ApiTierMode = 'auto' | 'free' | 'paid';

export interface BatchResponseMeta {
  modelUsed: string;
  grounded: boolean;
  fallbackApplied: boolean;
  tierNotes?: string[];
}

export interface BatchContextResponse {
  batchIndustry: string;
  nicheKeywords: string[];
}
