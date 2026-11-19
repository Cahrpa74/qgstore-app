import 'dotenv/config';
import { config as dotenvConfig } from 'dotenv';
import express from 'express';

// Load environment variables with correct precedence:
//   process.env (platform secrets) > .env.local (local dev) > .env
// dotenv does not override already-set variables by default, so secrets
// configured in AI Studio Settings > Secrets always take precedence.
dotenvConfig({ path: '.env.local' });
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';
import mysql from 'mysql2/promise';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT) || 3000;

type ApiTierMode = 'auto' | 'free' | 'paid';

interface ExecutionCandidate {
  model: 'gemini-4-hydrogen' | 'gemini-3.1-flash-lite';
  useSearchGrounding: boolean;
}

interface LeadItem {
  name: string;
  role: string;
  email_placeholder: string;
  email_type: 'VERIFIED' | 'PATTERN' | 'UNAVAILABLE';
  sourceUrl: string;
  linkedinUrl?: string;
  verifiedOnLinkedIn?: boolean;
}

interface GroundingSource {
  title: string;
  url: string;
}

type VerificationStage =
  | 'SITE_AND_LINKEDIN_VERIFIED'
  | 'SITE_VERIFIED_ROLES_MISSING'
  | 'UNVERIFIED';

interface CompanyIntel {
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

interface LeadGenResult {
  companyName: string;
  domain: string;
  leads: LeadItem[];
  companyIntel: CompanyIntel;
  statusDetail?: string;
}

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

const AGGREGATOR_DOMAINS = new Set([
  'linkedin.com',
  'facebook.com',
  'instagram.com',
  'twitter.com',
  'x.com',
  'youtube.com',
  'wikipedia.org',
  'bloomberg.com',
  'zoominfo.com',
  'dnb.com',
  'crunchbase.com',
  'apollo.io',
  'rocketreach.co',
  'pitchbook.com',
  'glassdoor.com',
  'indeed.com',
  'yelp.com',
  'bbb.org',
  'mapquest.com',
  'manta.com',
  'company.com',
  'example.com',
  'domain.com',
]);

const PLACEHOLDER_DOMAINS = new Set([
  'company.com',
  'example.com',
  'domain.com',
  'yourdomain.com',
  'yourbrand.com',
  'yoursite.com',
  'email.com',
  'placeholder.com',
  'test.com',
  'n/a',
  'na',
  'none',
  'unknown',
]);

const DEFAULT_GEMINI_KEYS = [
  'AQ.Ab8RN6LhYaPfcl7wU0qA8trnfRyDL-JJNaPMIP4oK3RBOcj61w',
  'AQ.Ab8RN6Lq9oX4TIXl47mGKPcOd-2uNVrhoVELXSBomyv2W1_JUg',
  'AQ.Ab8RN6I2B1Ml0L4C7uo8FyDYioaULs4XvIQK4XdVniSHq8cixg',
  'AQ.Ab8RN6J7WQUwr_pLDE1NyoOvqJTEI6glyysz3ifUIgf6Bcs9Iw',
  'AQ.Ab8RN6INi5X_hTWXlI5qXHzhMJ9Yyo40v_Kz5CgWT00ZlPITnw'
];

class GeminiKeyPool {
  private keys: Array<{
    key: string;
    cooldownUntil: number;
    failures: number;
    successes: number;
  }> = [];
  private currentIndex = 0;

  constructor() {
    this.refreshKeys();
  }

  refreshKeys() {
    const raw = process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || '';
    const splitKeys = raw
      .split(/[,;\n]+/)
      .map((k) => k.trim())
      .filter((k) => k.length > 5);

    const activeList = splitKeys.length > 0 ? splitKeys : DEFAULT_GEMINI_KEYS;

    const existingMap = new Map(this.keys.map((k) => [k.key, k]));
    this.keys = activeList.map((key) => {
      return (
        existingMap.get(key) || {
          key,
          cooldownUntil: 0,
          failures: 0,
          successes: 0,
        }
      );
    });
  }

  getKeyCount(): number {
    return this.keys.length;
  }

  getNextKey(): { key: string; index: number } | null {
    if (this.keys.length === 0) {
      this.refreshKeys();
      if (this.keys.length === 0) return null;
    }

    const now = Date.now();
    for (let i = 0; i < this.keys.length; i++) {
      const idx = (this.currentIndex + i) % this.keys.length;
      if (this.keys[idx].cooldownUntil <= now) {
        this.currentIndex = (idx + 1) % this.keys.length;
        return { key: this.keys[idx].key, index: idx };
      }
    }

    // All cooling down, pick earliest
    let earliestIdx = 0;
    let minTime = Infinity;
    for (let i = 0; i < this.keys.length; i++) {
      if (this.keys[i].cooldownUntil < minTime) {
        minTime = this.keys[i].cooldownUntil;
        earliestIdx = i;
      }
    }
    return { key: this.keys[earliestIdx].key, index: earliestIdx };
  }

  markCooldown(key: string, seconds = 65) {
    const item = this.keys.find((k) => k.key === key);
    if (item) {
      item.cooldownUntil = Date.now() + seconds * 1000;
      item.failures++;
      console.warn(`[KeyPool] Gemini key ending in ...${key.slice(-4)} reached quota/rate limit. Cooling down for ${seconds}s.`);
    }
  }

  markDepleted(key: string) {
    const item = this.keys.find((k) => k.key === key);
    if (item) {
      item.cooldownUntil = Date.now() + 24 * 3600 * 1000; // 24 hours
      item.failures++;
      console.warn(`[KeyPool] Gemini key ending in ...${key.slice(-4)} has depleted prepayment credits (402). Inactive for 24h.`);
    }
  }

  markSuccess(key: string) {
    const item = this.keys.find((k) => k.key === key);
    if (item) {
      item.successes++;
      item.cooldownUntil = 0;
    }
  }

  getStatus() {
    const now = Date.now();
    return {
      totalKeys: this.keys.length,
      keys: this.keys.map((k) => ({
        hint: `...${k.key.slice(-4)}`,
        active: k.cooldownUntil <= now,
        cooldownRemainingSeconds: Math.max(0, Math.round((k.cooldownUntil - now) / 1000)),
        successes: k.successes,
        failures: k.failures,
      })),
    };
  }
}

const keyPool = new GeminiKeyPool();

function createGeminiClient(specificKey?: string): GoogleGenAI | null {
  const keyInfo = specificKey ? { key: specificKey } : keyPool.getNextKey();
  if (!keyInfo?.key) {
    return null;
  }
  return new GoogleGenAI({
    apiKey: keyInfo.key,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

let dbPool: mysql.Pool | null = null;

function initDatabase() {
  const dbUrl = process.env.DATABASE_URL;
  const dbHost = process.env.DB_HOST || 'localhost';
  const dbUser = process.env.DB_USER;
  const dbPassword = process.env.DB_PASSWORD;
  const dbName = process.env.DB_NAME;

  try {
    if (dbUrl) {
      dbPool = mysql.createPool(dbUrl);
    } else if (dbName && dbUser) {
      dbPool = mysql.createPool({
        host: dbHost,
        user: dbUser,
        password: dbPassword,
        database: dbName,
        waitForConnections: true,
        connectionLimit: 10,
        queueLimit: 0,
      });
    }

    if (dbPool) {
      dbPool.query(`
        CREATE TABLE IF NOT EXISTS leads_history (
          id INT AUTO_INCREMENT PRIMARY KEY,
          company_name VARCHAR(255),
          domain VARCHAR(255),
          industry VARCHAR(255),
          total_leads INT DEFAULT 0,
          leads_json LONGTEXT,
          company_intel_json LONGTEXT,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `).then(() => {
        console.log('[Database] MySQL leads_history table ready.');
      }).catch((err: any) => {
        console.warn('[Database] Table init notice:', err.message);
      });
    }
  } catch (err: any) {
    console.warn('[Database] Connection init notice:', err.message);
  }
}

async function saveLeadsToDatabase(result: LeadGenResult, industry?: string) {
  if (!dbPool) return;
  try {
    const leadsJson = JSON.stringify(result.leads || []);
    const intelJson = JSON.stringify(result.companyIntel || {});
    await dbPool.query(
      `INSERT INTO leads_history (company_name, domain, industry, total_leads, leads_json, company_intel_json)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        result.companyName || '',
        result.domain || '',
        industry || result.companyIntel?.industry || '',
        result.leads?.length || 0,
        leadsJson,
        intelJson
      ]
    );
    console.log(`[Database] Persisted ${result.leads?.length || 0} leads for ${result.companyName || result.domain}`);
  } catch (err: any) {
    console.warn('[Database] Save leads warning:', err.message);
  }
}

async function runWithKeyRotation<T>(fn: (ai: GoogleGenAI, key: string) => Promise<T>): Promise<T> {
  const maxAttempts = Math.max(3, keyPool.getKeyCount());
  let lastErr: any = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const keyInfo = keyPool.getNextKey();
    if (!keyInfo) {
      throw {
        message: 'GEMINI_API_KEY is not configured on the server. Please provide one or more API keys.',
        status: 500,
        code: 'MISSING_API_KEY',
        isQuotaExhausted: false,
      };
    }

    const ai = new GoogleGenAI({
      apiKey: keyInfo.key,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });

    try {
      const res = await fn(ai, keyInfo.key);
      keyPool.markSuccess(keyInfo.key);
      return res;
    } catch (err: any) {
      lastErr = err;
      const parsed = (err as ParsedApiError)?.status ? (err as ParsedApiError) : parseGeminiError(err);
      if (parsed.status === 402) {
        keyPool.markDepleted(keyInfo.key);
        if (keyPool.getKeyCount() > 1 && attempt < maxAttempts - 1) {
          console.warn(`[KeyRotation] 402 Prepayment depleted on key ...${keyInfo.key.slice(-4)}. Skipping to next key...`);
          continue;
        }
      }
      if (parsed.status === 429 || parsed.isQuotaExhausted || parsed.code === 'RESOURCE_EXHAUSTED') {
        const cd = parsed.retryAfterSeconds || 65;
        keyPool.markCooldown(keyInfo.key, cd);
        if (keyPool.getKeyCount() > 1 && attempt < maxAttempts - 1) {
          console.warn(`[KeyRotation] 429 Quota reached on key ...${keyInfo.key.slice(-4)}. Rotating to next key (attempt ${attempt + 1}/${maxAttempts})...`);
          continue;
        }
      }
      throw err;
    }
  }

  throw lastErr;
}

function tryParseJson(rawText: string | undefined, expected: 'object' | 'array'): unknown | null {
  if (!rawText) return null;
  const cleaned = rawText
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    const openChar = expected === 'array' ? '[' : '{';
    const closeChar = expected === 'array' ? ']' : '}';
    const start = cleaned.indexOf(openChar);
    const end = cleaned.lastIndexOf(closeChar);
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

interface ParsedApiError {
  message: string;
  status: number;
  code?: string;
  isQuotaExhausted: boolean;
  retryAfterSeconds?: number;
}

function parseGeminiError(error: unknown): ParsedApiError {
  const errObj = error as {
    status?: unknown;
    code?: unknown;
    message?: unknown;
    error?: { status?: unknown; code?: unknown; message?: unknown };
  };

  let rawMessage =
    (typeof errObj?.message === 'string' && errObj.message) ||
    (typeof errObj?.error?.message === 'string' && errObj.error.message) ||
    'Lead extraction failed';
  let statusCode = typeof errObj?.status === 'number' ? errObj.status : 0;
  let code = typeof errObj?.code === 'string' ? errObj.code : undefined;
  let retryAfterSeconds: number | undefined;

  const jsonStart = rawMessage.indexOf('{');
  if (jsonStart !== -1) {
    try {
      const parsed = JSON.parse(rawMessage.slice(jsonStart));
      const inner = parsed?.error ?? parsed;
      if (typeof inner?.message === 'string' && inner.message) {
        rawMessage = inner.message.trim();
      }
      if (typeof inner?.code === 'number') {
        statusCode = inner.code;
      }
      if (typeof inner?.status === 'string') {
        code = inner.status;
      }
      if (Array.isArray(inner?.details)) {
        for (const detail of inner.details) {
          if (typeof detail?.retryDelay === 'string') {
            const match = detail.retryDelay.match(/(\d+)/);
            if (match) {
              retryAfterSeconds = Number(match[1]);
            }
          }
        }
      }
    } catch {
      // Keep rawMessage
    }
  }

  if (statusCode < 400 || statusCode >= 600) {
    if (rawMessage.includes('429') || code === 'RESOURCE_EXHAUSTED' || rawMessage.includes('RESOURCE_EXHAUSTED')) {
      statusCode = 429;
    } else if (rawMessage.includes('403') || code === 'PERMISSION_DENIED' || rawMessage.includes('PERMISSION_DENIED')) {
      statusCode = 403;
    } else if (rawMessage.includes('404') || code === 'NOT_FOUND' || rawMessage.includes('NOT_FOUND')) {
      statusCode = 404;
    } else if (rawMessage.includes('400') || code === 'INVALID_ARGUMENT') {
      statusCode = 400;
    } else {
      statusCode = 500;
    }
  }

  const lower = rawMessage.toLowerCase();
  const isQuotaExhausted =
    statusCode === 429 &&
    (lower.includes('exceeded your current quota') ||
      lower.includes('billing') ||
      lower.includes('plan') ||
      lower.includes('limit: 0'));

  return {
    message: rawMessage,
    status: statusCode,
    code,
    isQuotaExhausted,
    retryAfterSeconds,
  };
}

function normalizeDomain(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  let d = raw.trim().toLowerCase();
  if (!d) return '';
  d = d.replace(/^https?:\/\//, '').replace(/^www\./, '');
  d = d.split('/')[0].split('?')[0].split('#')[0].trim();
  if (!d || !d.includes('.') || d.includes(' ')) return '';
  if (PLACEHOLDER_DOMAINS.has(d)) return '';
  return d;
}

function extractDomainFromUrl(rawUrl: string): string {
  try {
    const u = new URL(/^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`);
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    if (!host || !host.includes('.')) return '';
    for (const agg of AGGREGATOR_DOMAINS) {
      if (host === agg || host.endsWith(`.${agg}`)) return '';
    }
    return host;
  } catch {
    return '';
  }
}

function normalizeEntityTokens(str: string): string[] {
  const stop = new Set(['inc', 'llc', 'ltd', 'corp', 'corporation', 'co', 'company', 'lp', 'llp', 'group', 'gmbh', 'plc', 'the', 'and', 'of']);
  return str
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 2 && !stop.has(w));
}

function isPlaceholderName(
  name: string,
  role: string,
  companyName = '',
  brandName = '',
  domain = ''
): boolean {
  const n = name.trim().toLowerCase();
  if (!n || n.length < 3) return true;

  const bannedPhrases = [
    'unverified',
    'placeholder',
    'without live search',
    'see statusdetail',
    'not found',
    'unavailable',
    'unknown',
    'role-based',
    'not publicly',
    'n/a',
    'none',
    'no verified',
    'generic',
    'team member',
    'contact person',
    'decision maker',
    'leadership',
    'executive',
    'customer service',
    'support team',
    'sales team',
  ];
  if (bannedPhrases.some((p) => n.includes(p))) return true;

  // Reject corporate legal suffixes indicating an organization rather than a person
  if (/\b(inc\.?|llc\.?|ltd\.?|corp\.?|corporation|gmbh|plc|limited)\b/i.test(n)) {
    return true;
  }

  // Reject if lead name is essentially the company name, brand name, or domain slug (e.g. "Simpli Boards" for simpliboards.com)
  const spacelessName = n.replace(/[^a-z0-9]/g, '');
  const domSlug = domain ? domain.split('.')[0].toLowerCase().replace(/[^a-z0-9]/g, '') : '';
  if (domSlug && domSlug.length >= 4 && spacelessName === domSlug) {
    return true;
  }

  for (const entity of [companyName, brandName]) {
    if (!entity) continue;
    const spacelessEntity = entity.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (spacelessEntity.length >= 3 && spacelessName === spacelessEntity) {
      return true;
    }
    const entityTokens = normalizeEntityTokens(entity);
    const nameTokens = normalizeEntityTokens(name);
    if (
      entityTokens.length >= 2 &&
      nameTokens.length >= 2 &&
      entityTokens.every((t) => nameTokens.includes(t)) &&
      nameTokens.every((t) => entityTokens.includes(t))
    ) {
      return true;
    }
  }

  const normalizedRole = role.trim().toLowerCase();
  if (normalizedRole && (n === normalizedRole || n.startsWith(`${normalizedRole} (`))) {
    return true;
  }

  const roleOnlyNames = new Set([
    'ceo',
    'owner',
    'founder',
    'president',
    'director',
    'manager',
    'sales manager',
    'marketing manager',
    'general manager',
    'vp sales',
    'vp marketing',
    'info',
    'sales',
    'marketing',
    'contact',
    'support',
    'admin',
  ]);
  if (roleOnlyNames.has(n)) return true;

  return false;
}

function classifyAndSanitizeEmail(
  rawEmail: unknown,
  verifiedDomain: string,
  siteEmails: string[],
  personName: string
): { email: string; type: 'VERIFIED' | 'PATTERN' | 'UNAVAILABLE' } {
  const rawStr = typeof rawEmail === 'string' ? rawEmail : '';
  const firstCandidate = rawStr.split(/[;,|\n]/)[0]?.trim() || '';
  const candidate = firstCandidate;
  const lower = candidate.toLowerCase();

  const isInvalid =
    !candidate ||
    lower === 'n/a' ||
    isIgnoredEmail(lower) ||
    !candidate.includes('@');

  if (!isInvalid) {
    if (siteEmails.some((e) => e.toLowerCase() === lower)) {
      return { email: candidate, type: 'VERIFIED' };
    }
    const domainPart = lower.split('@')[1] || '';
    if (verifiedDomain && (domainPart === verifiedDomain || domainPart.endsWith(`.${verifiedDomain}`))) {
      return { email: candidate, type: 'PATTERN' };
    }
    if (!PLACEHOLDER_DOMAINS.has(domainPart)) {
      return { email: candidate, type: 'PATTERN' };
    }
  }

  if (verifiedDomain && personName) {
    const parts = personName
      .toLowerCase()
      .replace(/[^a-z\s]/g, '')
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    if (parts.length >= 2) {
      return { email: `${parts[0]}.${parts[parts.length - 1]}@${verifiedDomain}`, type: 'PATTERN' };
    }
  }

  return { email: 'Not publicly listed', type: 'UNAVAILABLE' };
}

function sanitizeSourceUrl(rawUrl: unknown, verifiedDomain: string): string {
  if (typeof rawUrl === 'string') {
    const trimmed = rawUrl.trim();
    if (trimmed && trimmed.toUpperCase() !== 'N/A') {
      const candidate = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
      try {
        const parsed = new URL(candidate);
        const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
        if ((parsed.protocol === 'http:' || parsed.protocol === 'https:') && !PLACEHOLDER_DOMAINS.has(host)) {
          return parsed.toString();
        }
      } catch {
        // Ignore invalid URL
      }
    }
  }
  return verifiedDomain ? `https://${verifiedDomain}` : '';
}

interface WebsiteIntel {
  domain: string;
  redirectedDomain?: string;
  websiteUrl?: string;
  brandName?: string;
  siteSummary?: string;
  linkedinCompanyUrl?: string;
  emails: string[];
  phones: string[];
  location?: string;
  socialLinks: string[];
  jsonLdPeople: Array<{ name: string; role: string; email?: string; url: string; linkedinUrl?: string }>;
  snippets: string[];
  sourceUrls: string[];
  newsItems: Array<{ title: string; url: string }>;
}

function generateDeterministicDomainCandidates(companyName: string): string[] {
  const stopWords = new Set([
    'inc',
    'llc',
    'ltd',
    'corp',
    'corporation',
    'co',
    'company',
    'lp',
    'llp',
    'group',
    'holdings',
    'enterprises',
    'services',
    'consultants',
    'consulting',
    'solutions',
    'products',
    'industries',
    'industrial',
    'mfg',
    'manufacturing',
    'international',
    'intl',
    'usa',
    'of',
    'the',
    'and',
  ]);

  const rawWords = companyName
    .toLowerCase()
    .replace(/&/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  const nonLegalWords = rawWords.filter(
    (w) => !['inc', 'llc', 'ltd', 'corp', 'corporation', 'lp', 'llp', 'co'].includes(w)
  );
  const coreWords = rawWords.filter((w) => !stopWords.has(w));

  const candidates = new Set<string>();
  const addVariants = (slug: string) => {
    if (slug.length < 3) return;
    candidates.add(`${slug}.com`);
    candidates.add(`${slug}.ca`);
    candidates.add(`${slug}.net`);
    candidates.add(`${slug}.org`);
  };

  if (nonLegalWords.length >= 1) {
    addVariants(nonLegalWords.join(''));
    if (nonLegalWords.length >= 2) {
      candidates.add(`${nonLegalWords.join('-')}.com`);
    }
  }

  if (coreWords.length >= 1) {
    addVariants(coreWords.join(''));
    if (coreWords.length >= 2) {
      // Last 2 words (e.g. "Prairie Grain Analyzers" -> "grainanalyzers.ca")
      const lastTwo = coreWords.slice(-2).join('');
      addVariants(lastTwo);
      // First 2 words (e.g. "Worthington Tractor Parts" -> "worthingtontractor.com")
      const firstTwo = coreWords.slice(0, 2).join('');
      addVariants(firstTwo);
      // Initials + co/inc (e.g. "Worthington Tractor Parts" -> "wtpinc.com")
      if (rawWords.length >= 3) {
        const initials = rawWords
          .slice(0, 3)
          .map((w) => w[0])
          .join('');
        candidates.add(`${initials}inc.com`);
        candidates.add(`${initials}.com`);
      }
    }
    candidates.add(`${coreWords[0]}co.com`);
    candidates.add(`${coreWords[0]}inc.com`);
  }

  return Array.from(candidates).slice(0, 14);
}

async function resolveDnsHost(domain: string): Promise<boolean> {
  try {
    const res = await fetch(`https://dns.google/resolve?name=${encodeURIComponent(domain)}&type=A`, {
      signal: AbortSignal.timeout(2500),
    });
    if (!res.ok) return false;
    const data = (await res.json()) as { Status?: number; Answer?: Array<{ data?: string }> };
    return data.Status === 0 && Array.isArray(data.Answer) && data.Answer.length > 0;
  } catch {
    return false;
  }
}

function normalizePhoneKey(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) {
    return digits.slice(1);
  }
  return digits;
}

function dedupePhones(phoneList: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of phoneList) {
    const trimmed = raw.trim();
    const key = normalizePhoneKey(trimmed);
    if (key.length < 7 || seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

function decodeHtmlContactEntities(html: string): string {
  return html
    .replace(/&#0*64;|&#x0*40;/gi, '@')
    .replace(/&#0*46;|&#x0*2e;/gi, '.');
}

function isIgnoredEmail(email: string): boolean {
  const lower = email.trim().toLowerCase();
  if (!lower || !lower.includes('@')) return true;
  if (/\.(png|jpg|jpeg|gif|svg|webp|css|js|woff|ttf)$/i.test(lower)) return true;
  const [localPart = '', dom = ''] = lower.split('@');
  if (!localPart || !dom || PLACEHOLDER_DOMAINS.has(dom)) return true;

  // Reject system, technical, GDPR/compliance & non-lead mailboxes
  const junkPrefixes = [
    'noreply',
    'no-reply',
    'no_reply',
    'donotreply',
    'do-not-reply',
    'do_not_reply',
    'mailer-daemon',
    'postmaster',
    'webmaster',
    'hostmaster',
    'abuse',
    'dmca',
    'unsubscribe',
    'bounce',
    'dataprotection',
    'data-protection',
    'data_protection',
    'dpo',
    'gdpr',
    'privacy',
    'cookies',
    'cookie',
    'accessibility',
    'supplieronboarding',
    'hrhelp',
    'hr-help',
    'hr_help',
    'compliance',
    'security',
  ];
  if (junkPrefixes.some((p) => localPart === p || localPart.startsWith(`${p}.`) || localPart.startsWith(`${p}+`))) {
    return true;
  }

  return (
    lower.includes('example.com') ||
    lower.includes('business.com') ||
    lower.includes('sentry.io') ||
    lower.includes('wixpress') ||
    lower.includes('wordpress') ||
    lower.includes('shopify.com') ||
    lower.includes('cloudflare') ||
    lower.includes('schema.org') ||
    lower.includes('w3.org') ||
    dom === 'google.com' ||
    dom === 'facebook.com' ||
    dom === 'instagram.com' ||
    dom === 'linkedin.com' ||
    dom === 'twitter.com' ||
    dom === 'x.com'
  );
}

function isEmailRelevantToCompany(
  email: string,
  domain: string,
  redirectedDomain = '',
  companyName = '',
  brandName = ''
): boolean {
  const lower = email.trim().toLowerCase();
  if (isIgnoredEmail(lower)) return false;
  if (!domain && !redirectedDomain) return true;

  const [localPart = '', emailDom = ''] = lower.split('@');
  if (!emailDom) return false;

  if (domain && (emailDom === domain || emailDom.endsWith(`.${domain}`))) return true;
  if (redirectedDomain && (emailDom === redirectedDomain || emailDom.endsWith(`.${redirectedDomain}`))) return true;

  const primarySlug = domain ? domain.split('.')[0].toLowerCase() : '';
  const redirSlug = redirectedDomain ? redirectedDomain.split('.')[0].toLowerCase() : '';
  const brandSlug = brandName ? brandName.toLowerCase().replace(/[^a-z0-9]/g, '') : '';
  const compSlug = companyName ? companyName.toLowerCase().replace(/[^a-z0-9]/g, '') : '';

  for (const slug of [primarySlug, redirSlug, brandSlug, compSlug]) {
    if (slug.length >= 4 && (localPart.includes(slug) || emailDom.includes(slug))) {
      return true;
    }
  }
  return false;
}

const GENERIC_FUNCTIONAL_PREFIXES = new Set([
  'info',
  'contact',
  'contactus',
  'hello',
  'hi',
  'hey',
  'office',
  'admin',
  'team',
  'inquiries',
  'inquiry',
  'enquiries',
  'general',
  'mail',
  'support',
  'customerservice',
  'customer-service',
  'service',
  'help',
  'helps',
  'care',
  'sales',
  'marketing',
  'growth',
  'bd',
  'business',
  'partnerships',
  'wholesale',
  'commercial',
  'export',
  'ceo',
  'owner',
  'founder',
  'founders',
  'president',
  'director',
  'exec',
  'executive',
  'leadership',
  'press',
  'media',
  'pr',
  'news',
  'events',
  'legal',
  'dp',
  'investors',
  'investor',
  'hr',
  'careers',
  'jobs',
  'recruiting',
  'billing',
  'accounting',
  'invoices',
  'finance',
  'orders',
  'order',
  'maintprog',
  'special_markets',
]);

function scoreEmailPriority(email: string): number {
  const lower = email.trim().toLowerCase();
  const [localPart = ''] = lower.split('@');
  const baseToken = localPart.split(/[+.]/)[0];

  if (['ceo', 'owner', 'founder', 'founders', 'president', 'director', 'exec', 'executive', 'partner'].includes(localPart)) {
    return 90;
  }
  if (['sales', 'marketing', 'growth', 'bd', 'business', 'partnerships', 'wholesale', 'commercial', 'export'].includes(localPart)) {
    return 80;
  }
  if (['info', 'contact', 'contactus', 'hello', 'hi', 'office', 'admin', 'team', 'inquiries', 'enquiries', 'general', 'mail'].includes(localPart)) {
    return 65;
  }
  if (['support', 'customerservice', 'customer-service', 'service', 'help', 'helps', 'care', 'orders', 'order'].includes(localPart)) {
    return 40;
  }
  if (['press', 'media', 'pr', 'news', 'events', 'legal', 'dp', 'investors', 'investor', 'hr', 'careers', 'jobs', 'billing', 'accounting', 'invoices', 'finance', 'maintprog', 'special_markets'].includes(localPart)) {
    return 15;
  }
  if (GENERIC_FUNCTIONAL_PREFIXES.has(localPart) || GENERIC_FUNCTIONAL_PREFIXES.has(baseToken)) {
    return 50;
  }
  // Named/personal business email (e.g. rcampos@, jparker@, shubhang@, katy@)
  return localPart.includes('.') || localPart.includes('_') ? 105 : 100;
}

function sortAndDedupeEmails(emailList: string[]): string[] {
  const seen = new Map<string, string>();
  for (const raw of emailList) {
    const clean = raw.trim().toLowerCase();
    if (!clean || !clean.includes('@') || isIgnoredEmail(clean)) continue;
    if (!seen.has(clean)) seen.set(clean, clean);
  }
  return Array.from(seen.values()).sort((a, b) => {
    const diff = scoreEmailPriority(b) - scoreEmailPriority(a);
    return diff !== 0 ? diff : a.localeCompare(b);
  });
}

function extractStructuredSignals(html: string, pageUrl: string, domain: string, redirectedDomain = '') {
  const decodedHtml = decodeHtmlContactEntities(html);
  const title = (decodedHtml.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&ndash;|&mdash;/gi, '-')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();

  const ogSiteName = (
    decodedHtml.match(/<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)["']/i)?.[1] ||
    decodedHtml.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:site_name["']/i)?.[1] ||
    ''
  )
    .replace(/&amp;/gi, '&')
    .trim();

  const metaDescription = (
    decodedHtml.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i)?.[1] ||
    decodedHtml.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["']/i)?.[1] ||
    ''
  )
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();

  const mailtoMatches = [...decodedHtml.matchAll(/mailto:([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/gi)].map((m) =>
    m[1].trim().toLowerCase()
  );
  const emailMatches = decodedHtml.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || [];

  const candidateEmails = [...mailtoMatches, ...emailMatches.map((e) => e.trim().toLowerCase())];
  const emails = sortAndDedupeEmails(
    candidateEmails.filter((e) => isEmailRelevantToCompany(e, domain, redirectedDomain, ogSiteName, title))
  );

  const phoneMatches =
    decodedHtml.match(/(?:\+?\d{1,3}[-.\s]?)?(?:\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}|\+\d{10,13})/g) || [];
  const phones = dedupePhones(phoneMatches).slice(0, 5);

  const socialMatches =
    decodedHtml.match(/https?:\/\/(?:www\.)?(?:linkedin\.com|facebook\.com|x\.com|twitter\.com|instagram\.com)\/[^\s"'<>]+/gi) ||
    [];
  const socialLinks = Array.from(
    new Set(
      socialMatches
        .map((u) => u.replace(/[),.;]+$/, ''))
        .filter((u) => !u.includes('/share') && !u.includes('/sharer') && !u.includes('intent/tweet'))
    )
  ).slice(0, 8);

  const linkedinCompanyUrl = socialLinks.find((u) => /linkedin\.com\/company\//i.test(u));

  const jsonLdPeople: Array<{ name: string; role: string; email?: string; url: string; linkedinUrl?: string }> = [];
  let jsonLdLocation: string | undefined;
  let jsonLdOrgName: string | undefined;
  const ldBlocks = decodedHtml.match(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi) || [];
  for (const block of ldBlocks) {
    const inner = block.replace(/<script[^>]*>|<\/script>/gi, '').trim();
    try {
      const parsed = JSON.parse(inner);
      const visit = (node: unknown) => {
        if (!node || typeof node !== 'object') return;
        if (Array.isArray(node)) {
          node.forEach(visit);
          return;
        }
        const obj = node as Record<string, unknown>;
        if (
          (obj['@type'] === 'Organization' || obj['@type'] === 'LocalBusiness' || obj['@type'] === 'Store') &&
          typeof obj.name === 'string' &&
          !jsonLdOrgName
        ) {
          jsonLdOrgName = obj.name.trim();
        }
        if (obj['@type'] === 'Person' && typeof obj.name === 'string') {
          const personName = obj.name.trim();
          const jobTitle = typeof obj.jobTitle === 'string' ? obj.jobTitle.trim() : '';
          if (jobTitle && !isPlaceholderName(personName, jobTitle, jsonLdOrgName || '', ogSiteName || '', domain)) {
            const sameAsArr = Array.isArray(obj.sameAs) ? obj.sameAs : typeof obj.sameAs === 'string' ? [obj.sameAs] : [];
            const personLi = sameAsArr.find(
              (s): s is string => typeof s === 'string' && s.toLowerCase().includes('linkedin.com/in/')
            );
            jsonLdPeople.push({
              name: personName,
              role: jobTitle,
              email: typeof obj.email === 'string' ? obj.email.replace(/^mailto:/i, '').trim() : undefined,
              url: typeof obj.url === 'string' ? obj.url : pageUrl,
              linkedinUrl: personLi,
            });
          }
        }
        if (obj['@type'] === 'PostalAddress' && !jsonLdLocation) {
          const parts = [
            obj.streetAddress,
            obj.addressLocality,
            obj.addressRegion,
            obj.postalCode,
            obj.addressCountry,
          ].filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
          if (parts.length >= 2) {
            jsonLdLocation = parts.join(', ');
          }
        }
        if (obj.address) visit(obj.address);
        if (obj.founder) visit(obj.founder);
        if (obj.employee) visit(obj.employee);
        if (obj['@graph']) visit(obj['@graph']);
      };
      visit(parsed);
    } catch {
      // Ignore malformed JSON-LD
    }
  }

  const strippedText = decodedHtml
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<header[\s\S]*?<\/header>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 2600);

  const brandName = ogSiteName || jsonLdOrgName || (title.split(/[|\-–—:]/)[0] || '').trim() || undefined;

  return {
    title,
    brandName,
    siteSummary: metaDescription || undefined,
    text: strippedText,
    emails,
    phones,
    location: jsonLdLocation,
    socialLinks,
    linkedinCompanyUrl,
    jsonLdPeople,
  };
}

function scoreCompanySiteMatch(title: string, text: string, companyName: string, domain: string): number {
  const stopWords = new Set(['inc', 'llc', 'ltd', 'co', 'corp', 'company', 'the', 'and', 'of', 'for']);
  const tokens = companyName
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !stopWords.has(w));
  if (tokens.length === 0) return 0;

  const lowerTitle = title.trim().toLowerCase();
  const cleanDom = domain.toLowerCase().replace(/^www\./, '');
  if (!lowerTitle || (text.length < 120 && (lowerTitle === cleanDom || lowerTitle === cleanDom.split('.')[0]))) {
    return 0;
  }

  const haystack = `${title} ${text.slice(0, 1400)}`.toLowerCase();
  if (
    haystack.includes('domain for sale') ||
    haystack.includes('buy this domain') ||
    haystack.includes('parked free') ||
    haystack.includes('godaddy') ||
    haystack.includes('hugedomains') ||
    haystack.includes('sedoparking') ||
    haystack.includes('this domain is parked')
  ) {
    return 0;
  }

  const spacelessHaystack = haystack.replace(/[^a-z0-9]/g, '');
  const spacelessTitle = lowerTitle.replace(/[^a-z0-9]/g, '');
  const titleHits = tokens.filter((t) => lowerTitle.includes(t) || spacelessTitle.includes(t)).length;
  const bodyHits = tokens.filter((t) => haystack.includes(t) || spacelessHaystack.includes(t)).length;
  const minRequired = Math.min(2, tokens.length);
  if (bodyHits < minRequired) return 0;

  return titleHits * 35 + bodyHits * 20 + (bodyHits === tokens.length ? 40 : 0);
}

function titleMatchesCompany(title: string, text: string, companyName: string, domain = ''): boolean {
  return scoreCompanySiteMatch(title, text, companyName, domain) > 0;
}

async function verifyLiveDomain(
  domain: string,
  companyName: string,
  isUserProvidedDomain = false
): Promise<{ domain: string; redirectedDomain?: string; html: string; url: string } | null> {
  const clean = normalizeDomain(domain);
  if (!clean) return null;

  const hasDns = await resolveDnsHost(clean);
  if (!hasDns) return null;

  const tryUrls = [
    `https://${clean}`,
    `https://www.${clean}`,
    ...(isUserProvidedDomain ? [`http://${clean}`] : []),
  ];

  for (const targetUrl of tryUrls) {
    try {
      const res = await fetch(targetUrl, {
        headers: { 'User-Agent': BROWSER_UA },
        signal: AbortSignal.timeout(4000),
      });
      const html = await res.text();
      const { title, text } = extractStructuredSignals(html, res.url, clean);
      const isChallenge =
        (res.status === 403 || res.status === 503) && title.toLowerCase().includes('just a moment');

      const finalHost = extractDomainFromUrl(res.url) || clean;
      const redirectedDomain = finalHost !== clean ? finalHost : undefined;

      if (isUserProvidedDomain) {
        if (!res.ok && !isChallenge) continue;
        const lowerHay = `${title} ${text.slice(0, 600)}`.toLowerCase();
        const isParked =
          lowerHay.includes('domain for sale') ||
          lowerHay.includes('buy this domain') ||
          lowerHay.includes('sedoparking') ||
          lowerHay.includes('hugedomains');
        if (isParked) continue;
        // ALWAYS preserve the user's explicit input domain as canonical `domain`
        return {
          domain: clean,
          redirectedDomain,
          html: isChallenge ? '' : html,
          url: res.url || targetUrl,
        };
      }

      if (!res.ok && !isChallenge) continue;
      if (isChallenge || titleMatchesCompany(title, text, companyName, clean)) {
        return {
          domain: finalHost,
          html: isChallenge ? '' : html,
          url: res.url || targetUrl,
        };
      }
    } catch {
      // Try next host variant
    }
  }
  return null;
}

async function fetchGoogleNewsSignals(companyName: string): Promise<Array<{ title: string; url: string }>> {
  if (!companyName || companyName.length < 3) return [];
  const legalStopWords = new Set(['inc', 'llc', 'ltd', 'corp', 'corporation', 'co', 'company', 'lp', 'llp', 'the', 'of', 'and']);
  const meaningfulTokens = companyName
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 2 && !legalStopWords.has(w));
  if (meaningfulTokens.length === 0) return [];

  const exactPhrase = meaningfulTokens.join(' ');
  try {
    const q = `"${exactPhrase}"`;
    const res = await fetch(
      `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`,
      { headers: { 'User-Agent': BROWSER_UA }, signal: AbortSignal.timeout(3500) }
    );
    if (!res.ok) return [];
    const xml = await res.text();
    const matches = [...xml.matchAll(/<item>[\s\S]*?<title>([\s\S]*?)<\/title>[\s\S]*?<link>([\s\S]*?)<\/link>[\s\S]*?<\/item>/g)];
    return matches
      .map((m) => ({
        title: m[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim(),
        url: m[2].trim(),
      }))
      .filter((item) => {
        const lowerTitle = item.title.toLowerCase();
        if (lowerTitle.includes(exactPhrase)) return true;
        return meaningfulTokens.length >= 2 && meaningfulTokens.every((t) => lowerTitle.includes(t));
      })
      .slice(0, 4);
  } catch {
    return [];
  }
}

async function fetchClearbitDomainCandidates(companyName: string): Promise<Array<{ domain: string; score: number }>> {
  if (!companyName || companyName.trim().length < 2) return [];
  const legalWords = new Set(['inc', 'llc', 'ltd', 'corp', 'corporation', 'co', 'company', 'lp', 'llp', 'group']);
  const words = companyName
    .replace(/[.,]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((w) => w && !legalWords.has(w.toLowerCase()));
  if (words.length === 0) return [];

  const targetNormalized = words.join(' ').toLowerCase();
  const queries = Array.from(
    new Set([
      words.join(' '),
      words.length >= 2 ? words.slice(0, 2).join(' ') : words[0],
    ])
  );

  const requiredTokens = words.map((w) => w.toLowerCase()).filter((w) => w.length >= 3);
  const scoredDomains = new Map<string, number>();

  await Promise.allSettled(
    queries.map(async (q) => {
      const res = await fetch(
        `https://autocomplete.clearbit.com/v1/companies/suggest?query=${encodeURIComponent(q)}`,
        { headers: { 'User-Agent': BROWSER_UA }, signal: AbortSignal.timeout(2500) }
      );
      if (!res.ok) return;
      const items = (await res.json()) as Array<{ name?: string; domain?: string }>;
      if (!Array.isArray(items)) return;
      for (const item of items) {
        const cleanDom = normalizeDomain(item?.domain);
        const itemNameClean = (item?.name || '')
          .toLowerCase()
          .replace(/[.,]/g, ' ')
          .split(/\s+/)
          .filter((w) => w && !legalWords.has(w))
          .join(' ');
        if (!cleanDom) continue;

        const hits = requiredTokens.filter((t) => itemNameClean.includes(t) || cleanDom.includes(t)).length;
        const minRequired = Math.min(2, Math.max(1, requiredTokens.length));
        if (hits < minRequired) continue;

        let score = hits * 20;
        if (itemNameClean === targetNormalized) {
          score += 100;
        } else if (hits === requiredTokens.length) {
          score += 50;
        }
        if (cleanDom.endsWith('.com')) score += 5;

        const prev = scoredDomains.get(cleanDom) ?? 0;
        if (score > prev) scoredDomains.set(cleanDom, score);
      }
    })
  );

  return Array.from(scoredDomains.entries())
    .map(([domain, score]) => ({ domain, score }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 6);
}

async function suggestCandidateDomainsWithAI(
  ai: GoogleGenAI,
  targets: Array<{ company: string; domain: string }>,
  batchIndustry = ''
): Promise<string[][]> {
  try {
    const list = targets
      .map((t, i) => `${i + 1}. ${t.company || t.domain}${t.domain ? ` (hint: ${t.domain})` : ''}`)
      .join('\n');

    const industryHint = batchIndustry ? `Context: These companies operate in the "${batchIndustry}" sector.\n` : '';
    const res = await ai.models.generateContent({
      model: 'gemini-3.1-flash-lite',
      contents: `${industryHint}For each company below, list up to 5 likely real official website domains (e.g. ["grainanalyzers.ca", "yetterco.com", "wtpinc.com"]). Return ONLY a JSON array of string arrays matching the exact company order.\n\n${list}`,
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.ARRAY,
          items: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
          },
        },
      },
    });
    const parsed = tryParseJson(res.text, 'array');
    return Array.isArray(parsed)
      ? parsed.map((arr) => (Array.isArray(arr) ? arr.filter((d): d is string => typeof d === 'string') : []))
      : targets.map(() => []);
  } catch {
    return targets.map(() => []);
  }
}

async function discoverInternalLeadPages(
  homepageHtml: string,
  baseUrl: string,
  domain: string,
  redirectedDomain?: string
): Promise<string[]> {
  const urls = new Set<string>();
  const activeHost = redirectedDomain || domain;
  const linkMatches = homepageHtml.matchAll(/href=["']([^"'#]+)["']/gi);
  for (const m of linkMatches) {
    const href = m[1];
    if (!/about|team|leadership|staff|people|management|executive|founder|contact|company|who-we-are|story|policy|policies/i.test(href)) {
      continue;
    }
    try {
      const resolved = new URL(href, baseUrl);
      const host = resolved.hostname.toLowerCase().replace(/^www\./, '');
      if (
        host === domain ||
        host.endsWith(`.${domain}`) ||
        (redirectedDomain && (host === redirectedDomain || host.endsWith(`.${redirectedDomain}`)))
      ) {
        urls.add(resolved.toString());
      }
    } catch {
      // Ignore bad href
    }
  }

  for (const p of [
    '/pages/about-us',
    '/pages/about',
    '/pages/contact-us',
    '/pages/contact',
    '/pages/our-story',
    '/about',
    '/about-us',
    '/team',
    '/leadership',
    '/contact',
    '/contact-us',
    '/policies/contact-information',
    '/policies/privacy-policy',
  ]) {
    if (urls.size >= 8) break;
    urls.add(`https://${activeHost}${p}`);
  }

  if (urls.size < 6) {
    for (const smUrl of [`https://${activeHost}/sitemap.xml`, `https://${activeHost}/page-sitemap.xml`]) {
      try {
        const smRes = await fetch(smUrl, {
          headers: { 'User-Agent': BROWSER_UA },
          signal: AbortSignal.timeout(2500),
        });
        if (!smRes.ok) continue;
        const smXml = await smRes.text();
        const rawLocs = [...smXml.matchAll(/<loc>(?:<!\[CDATA\[)?(https?:\/\/[^\]<]+)(?:\]\]>)?<\/loc>/gi)].map(
          (m) => m[1].replace(/&amp;/g, '&').trim()
        );
        const pageSitemapUrl = rawLocs.find((l) => /sitemap_pages|page-sitemap/i.test(l));
        let finalLocs = rawLocs;
        if (pageSitemapUrl) {
          try {
            const subRes = await fetch(pageSitemapUrl, {
              headers: { 'User-Agent': BROWSER_UA },
              signal: AbortSignal.timeout(2500),
            });
            if (subRes.ok) {
              const subXml = await subRes.text();
              finalLocs = [
                ...subXml.matchAll(/<loc>(?:<!\[CDATA\[)?(https?:\/\/[^\]<]+)(?:\]\]>)?<\/loc>/gi),
              ].map((m) => m[1].replace(/&amp;/g, '&').trim());
            }
          } catch {
            // Optional sub-sitemap
          }
        }
        for (const loc of finalLocs) {
          if (/about|team|leadership|staff|people|contact|company|story|policy/i.test(loc)) {
            urls.add(loc);
          }
        }
        if (urls.size >= 8) break;
      } catch {
        // Optional
      }
    }
  }

  return Array.from(urls).slice(0, 8);
}

async function fetchWebsiteIntel(
  companyName: string,
  knownDomain: string,
  extraCandidates: string[] = [],
  includeNews = true
): Promise<WebsiteIntel> {
  const isUserProvidedDomain = Boolean(normalizeDomain(knownDomain));
  let verifiedDomain = normalizeDomain(knownDomain);
  let redirectedDomain: string | undefined;
  let homepageHtml = '';
  let homepageUrl = '';

  if (verifiedDomain) {
    const verified = await verifyLiveDomain(verifiedDomain, companyName, isUserProvidedDomain);
    if (verified) {
      verifiedDomain = verified.domain;
      redirectedDomain = verified.redirectedDomain;
      homepageHtml = verified.html;
      homepageUrl = verified.url;
    } else if (!isUserProvidedDomain) {
      verifiedDomain = '';
    }
  }

  if (!verifiedDomain && companyName) {
    const clearbitScored = await fetchClearbitDomainCandidates(companyName);
    const clearbitScoreMap = new Map(clearbitScored.map((c) => [c.domain, c.score]));

    const candidates = Array.from(
      new Set([
        ...clearbitScored.map((c) => c.domain),
        ...extraCandidates.map(normalizeDomain).filter(Boolean),
        ...generateDeterministicDomainCandidates(companyName),
      ])
    ).slice(0, 16);

    const dnsChecks = await Promise.all(
      candidates.map(async (c) => ({ domain: c, ok: await resolveDnsHost(c) }))
    );
    const liveCandidates = dnsChecks.filter((d) => d.ok).map((d) => d.domain).slice(0, 8);

    const probeResults = await Promise.allSettled(
      liveCandidates.map(async (candidate) => {
        const cbScore = clearbitScoreMap.get(candidate) ?? 0;
        const res = await fetch(`https://${candidate}`, {
          headers: { 'User-Agent': BROWSER_UA },
          signal: AbortSignal.timeout(3000),
        });
        const html = await res.text();
        const { title, text } = extractStructuredSignals(html, res.url, candidate);
        const isChallenge =
          (res.status === 403 || res.status === 503) && title.toLowerCase().includes('just a moment');

        if (isChallenge && cbScore >= 100) {
          return {
            domain: extractDomainFromUrl(res.url) || candidate,
            html: '',
            url: res.url || `https://${candidate}`,
            score: cbScore + 30,
          };
        }
        if (!res.ok) return null;

        const siteScore = scoreCompanySiteMatch(title, text, companyName, candidate);
        if (siteScore <= 0) return null;

        const resolvedDom = extractDomainFromUrl(res.url) || candidate;
        const tldBonus = resolvedDom.endsWith('.com') ? 8 : 0;
        return {
          domain: resolvedDom,
          html,
          url: res.url,
          score: siteScore + cbScore + tldBonus,
        };
      })
    );

    const ranked = probeResults
      .filter(
        (r): r is PromiseFulfilledResult<{ domain: string; html: string; url: string; score: number }> =>
          r.status === 'fulfilled' && Boolean(r.value)
      )
      .map((r) => r.value)
      .sort((a, b) => b.score - a.score);

    if (ranked.length > 0) {
      verifiedDomain = ranked[0].domain;
      homepageHtml = ranked[0].html;
      homepageUrl = ranked[0].url;
    }
  }

  if (!verifiedDomain) {
    const newsItems = includeNews ? await fetchGoogleNewsSignals(companyName) : [];
    return {
      domain: '',
      emails: [],
      phones: [],
      socialLinks: [],
      jsonLdPeople: [],
      snippets: [],
      sourceUrls: [],
      newsItems,
    };
  }

  const emails = new Set<string>();
  const phonesList: string[] = [];
  let detectedLocation: string | undefined;
  let detectedBrandName: string | undefined;
  let detectedSiteSummary: string | undefined;
  let detectedLinkedinCompany: string | undefined;
  const socialLinks = new Set<string>();
  const jsonLdPeople: Array<{ name: string; role: string; email?: string; url: string; linkedinUrl?: string }> = [];
  const snippets: string[] = [];
  const sourceUrls: string[] = [];

  if (homepageHtml) {
    const homeSignals = extractStructuredSignals(homepageHtml, homepageUrl, verifiedDomain, redirectedDomain || '');
    homeSignals.emails.forEach((e) => emails.add(e));
    phonesList.push(...homeSignals.phones);
    if (!detectedLocation && homeSignals.location) detectedLocation = homeSignals.location;
    if (!detectedBrandName && homeSignals.brandName) detectedBrandName = homeSignals.brandName;
    if (!detectedSiteSummary && homeSignals.siteSummary) detectedSiteSummary = homeSignals.siteSummary;
    if (!detectedLinkedinCompany && homeSignals.linkedinCompanyUrl) detectedLinkedinCompany = homeSignals.linkedinCompanyUrl;
    homeSignals.socialLinks.forEach((s) => socialLinks.add(s));
    jsonLdPeople.push(...homeSignals.jsonLdPeople);
    if (homeSignals.text && !homeSignals.text.toLowerCase().includes('just a moment')) {
      sourceUrls.push(homepageUrl);
      snippets.push(`[${homepageUrl}] (${homeSignals.title}): ${homeSignals.text.slice(0, 1000)}`);
    }
  }

  const internalUrls = await discoverInternalLeadPages(
    homepageHtml,
    homepageUrl || `https://${redirectedDomain || verifiedDomain}`,
    verifiedDomain,
    redirectedDomain
  );
  const pageFetches = await Promise.allSettled(
    internalUrls.map(async (targetUrl) => {
      const res = await fetch(targetUrl, {
        headers: { 'User-Agent': BROWSER_UA },
        signal: AbortSignal.timeout(3500),
      });
      if (!res.ok) return null;
      const html = await res.text();
      const parsed = extractStructuredSignals(html, res.url || targetUrl, verifiedDomain, redirectedDomain || '');
      return { url: res.url || targetUrl, ...parsed };
    })
  );

  for (const res of pageFetches) {
    if (res.status === 'fulfilled' && res.value) {
      res.value.emails.forEach((e) => emails.add(e));
      phonesList.push(...res.value.phones);
      if (!detectedLocation && res.value.location) detectedLocation = res.value.location;
      if (!detectedBrandName && res.value.brandName) detectedBrandName = res.value.brandName;
      if (!detectedSiteSummary && res.value.siteSummary) detectedSiteSummary = res.value.siteSummary;
      if (!detectedLinkedinCompany && res.value.linkedinCompanyUrl) detectedLinkedinCompany = res.value.linkedinCompanyUrl;
      res.value.socialLinks.forEach((s) => socialLinks.add(s));
      jsonLdPeople.push(...res.value.jsonLdPeople);
      if (res.value.text && !res.value.text.toLowerCase().includes('just a moment')) {
        sourceUrls.push(res.value.url);
        snippets.push(`[${res.value.url}] (${res.value.title}): ${res.value.text.slice(0, 1200)}`);
      }
    }
  }

  const newsQueryName =
    detectedBrandName && detectedBrandName.length >= 3 ? detectedBrandName : companyName;
  const newsItems = includeNews ? await fetchGoogleNewsSignals(newsQueryName) : [];

  return {
    domain: verifiedDomain,
    redirectedDomain,
    websiteUrl: homepageUrl || `https://${redirectedDomain || verifiedDomain}`,
    brandName: detectedBrandName,
    siteSummary: detectedSiteSummary,
    linkedinCompanyUrl: detectedLinkedinCompany,
    emails: Array.from(emails).slice(0, 10),
    phones: dedupePhones(phonesList).slice(0, 5),
    location: detectedLocation,
    socialLinks: Array.from(socialLinks).slice(0, 8),
    jsonLdPeople,
    snippets: snippets.slice(0, 5),
    sourceUrls: Array.from(new Set(sourceUrls)).slice(0, 6),
    newsItems,
  };
}

function computeMissingRoles(targetRoles: string[], leads: LeadItem[]): string[] {
  if (targetRoles.length === 0) return [];
  const leadRolesLower = leads.map((l) => l.role.toLowerCase());
  const roleAliases: Record<string, string[]> = {
    owner: ['owner', 'founder', 'co-founder', 'cofounder', 'proprietor', 'managing partner', 'principal'],
    ceo: ['ceo', 'chief executive', 'president', 'managing director'],
    'marketing manager': ['marketing manager', 'head of marketing', 'marketing director', 'cmo', 'vp marketing'],
    'sales manager': ['sales manager', 'head of sales', 'sales director', 'vp sales', 'business development'],
  };
  return targetRoles.filter((reqRole) => {
    const reqLower = reqRole.toLowerCase().trim();
    const aliases = roleAliases[reqLower] || [];
    const tokens = reqLower.split(/\s+/).filter((t) => t.length >= 2);
    return !leadRolesLower.some(
      (lr) =>
        lr.includes(reqLower) ||
        aliases.some((alias) => lr.includes(alias)) ||
        (tokens.length > 0 && tokens.every((t) => lr.includes(t)))
    );
  });
}

function sanitizeLeadGenResult(
  rawItem: Record<string, unknown>,
  target: { company: string; domain: string },
  intel: WebsiteIntel | undefined,
  groundingChunks: Array<{ web?: { uri?: string; title?: string } }>,
  wasGrounded: boolean,
  targetRoles: string[] = [],
  batchIndustry = '',
  secondPassExecuted = false
): LeadGenResult {
  const rawLeads = Array.isArray(rawItem?.leads) ? rawItem.leads : [];
  const rawIntel = (rawItem?.companyIntel ?? {}) as Record<string, unknown>;
  const lockedUserDomain = normalizeDomain(target.domain);

  // CRITICAL: If user explicitly submitted a domain (e.g. abcjewelrymart.com), NEVER overwrite it!
  let domain = lockedUserDomain;
  if (!domain) {
    if (wasGrounded) {
      domain = normalizeDomain(rawItem?.domain) || intel?.domain || '';
      if (!domain) {
        for (const l of rawLeads) {
          const urlCandidate =
            typeof (l as { sourceUrl?: unknown })?.sourceUrl === 'string'
              ? (l as { sourceUrl: string }).sourceUrl
              : '';
          const fromUrl = extractDomainFromUrl(urlCandidate);
          if (fromUrl) {
            domain = fromUrl;
            break;
          }
        }
      }
    } else {
      domain = intel?.domain || '';
    }
  }

  const rawRedirected =
    normalizeDomain(rawIntel.redirectedDomain) ||
    (intel?.redirectedDomain && intel.redirectedDomain !== domain ? intel.redirectedDomain : undefined);

  const brandName =
    (typeof rawIntel.brandName === 'string' && rawIntel.brandName.trim()
      ? rawIntel.brandName.trim()
      : undefined) || intel?.brandName;

  const resolvedCompanyName =
    typeof rawItem?.companyName === 'string' && rawItem.companyName.trim()
      ? rawItem.companyName.trim()
      : brandName || target.company || target.domain;

  const siteEmails = sortAndDedupeEmails([
    ...(intel?.emails ?? []).filter((e) =>
      isEmailRelevantToCompany(e, domain, rawRedirected || '', resolvedCompanyName, brandName || '')
    ),
    ...(Array.isArray(rawIntel.emails)
      ? rawIntel.emails
          .filter((e): e is string => typeof e === 'string')
          .flatMap((e) => e.split(/[;,|\n]/).map((s) => s.trim()))
          .filter((e) => isEmailRelevantToCompany(e, domain, rawRedirected || '', resolvedCompanyName, brandName || ''))
      : []),
  ]).slice(0, 10);

  const phones = dedupePhones([
    ...(intel?.phones ?? []),
    ...(Array.isArray(rawIntel.phones)
      ? rawIntel.phones.filter((p): p is string => typeof p === 'string' && p.trim().length > 5)
      : []),
  ]).slice(0, 5);

  const socialLinks = Array.from(
    new Set([
      ...(intel?.socialLinks ?? []),
      ...(Array.isArray(rawIntel.socialLinks)
        ? rawIntel.socialLinks.filter((s): s is string => typeof s === 'string' && s.startsWith('http'))
        : []),
    ])
  ).slice(0, 8);

  const linkedinCompanyUrl =
    (typeof rawIntel.linkedinCompanyUrl === 'string' && rawIntel.linkedinCompanyUrl.includes('linkedin.com')
      ? rawIntel.linkedinCompanyUrl.trim()
      : undefined) ||
    intel?.linkedinCompanyUrl ||
    socialLinks.find((u) => /linkedin\.com\/company\//i.test(u));

  const groundingSources: GroundingSource[] = [];
  const seenGrounding = new Set<string>();
  for (const chunk of groundingChunks) {
    const uri = chunk?.web?.uri;
    const title = chunk?.web?.title;
    if (typeof uri === 'string' && uri.startsWith('http') && !seenGrounding.has(uri)) {
      seenGrounding.add(uri);
      groundingSources.push({
        title: typeof title === 'string' && title.trim() ? title.trim() : uri,
        url: uri,
      });
    }
  }
  for (const news of intel?.newsItems ?? []) {
    if (news.url && !seenGrounding.has(news.url)) {
      seenGrounding.add(news.url);
      groundingSources.push({ title: news.title, url: news.url });
    }
  }

  const leads: LeadItem[] = [];
  const seenNames = new Set<string>();

  const combinedRawLeads = [
    ...rawLeads,
    ...(intel?.jsonLdPeople.map((p) => ({
      name: p.name,
      role: p.role,
      email_placeholder: p.email || '',
      sourceUrl: p.url,
      linkedinUrl: p.linkedinUrl,
      verifiedOnLinkedIn: Boolean(p.linkedinUrl),
    })) ?? []),
  ];

  for (const rawLead of combinedRawLeads) {
    const l = rawLead as Record<string, unknown>;
    const name = typeof l?.name === 'string' ? l.name.trim() : '';
    const role = typeof l?.role === 'string' ? l.role.trim() : '';
    if (!name || !role || isPlaceholderName(name, role, resolvedCompanyName, brandName || '', domain)) {
      continue;
    }

    const dedupeKey = `${name.toLowerCase()}::${role.toLowerCase()}`;
    if (seenNames.has(dedupeKey)) continue;
    seenNames.add(dedupeKey);

    const sourceUrl = sanitizeSourceUrl(l?.sourceUrl, domain);
    if (!sourceUrl && !domain) continue;

    const rawLi = typeof l?.linkedinUrl === 'string' ? l.linkedinUrl.trim() : '';
    const linkedinUrl = rawLi.includes('linkedin.com/in/')
      ? rawLi
      : sourceUrl.includes('linkedin.com/in/')
        ? sourceUrl
        : undefined;
    const verifiedOnLinkedIn = Boolean(linkedinUrl) || Boolean(l?.verifiedOnLinkedIn);

    const emailInfo = classifyAndSanitizeEmail(l?.email_placeholder, domain, siteEmails, name);
    leads.push({
      name,
      role,
      email_placeholder: emailInfo.email,
      email_type: emailInfo.type,
      sourceUrl,
      linkedinUrl,
      verifiedOnLinkedIn,
    });
  }

  const location =
    (typeof rawIntel.location === 'string' && rawIntel.location.trim()
      ? rawIntel.location.trim()
      : undefined) || intel?.location;

  const industry =
    (typeof rawIntel.industry === 'string' && rawIntel.industry.trim()
      ? rawIntel.industry.trim()
      : undefined) ||
    batchIndustry ||
    undefined;

  const rolesMissing = computeMissingRoles(targetRoles, leads);

  const hasVerifiedSite = Boolean(domain || siteEmails.length > 0 || phones.length > 0);
  const verificationStage: VerificationStage =
    leads.length > 0
      ? 'SITE_AND_LINKEDIN_VERIFIED'
      : hasVerifiedSite
        ? 'SITE_VERIFIED_ROLES_MISSING'
        : 'UNVERIFIED';

  let statusDetail = typeof rawItem?.statusDetail === 'string' ? rawItem.statusDetail.trim() : '';
  if (leads.length === 0) {
    const redirectNote = rawRedirected ? ` (redirects to ${rawRedirected})` : '';
    if (siteEmails.length > 0 || phones.length > 0) {
      statusDetail = `Verified ${domain}${redirectNote}. Public contact channels extracted; requested roles (${rolesMissing.join(', ') || targetRoles.join(', ')}) were not publicly listed on site pages.`;
    } else if (domain) {
      statusDetail = `Verified ${domain}${redirectNote}, but individual executive profiles for requested roles were not publicly listed on indexed site pages.`;
    } else {
      statusDetail =
        'No live official website domain resolved via DNS/HTTPS. Add the domain directly or enable a billing-enabled API key for Google Search Grounding.';
    }
  } else if (rawRedirected && !statusDetail.includes(domain)) {
    statusDetail = `Verified ${domain} (redirects to ${rawRedirected}). ${statusDetail}`;
  }

  return {
    companyName:
      typeof rawItem?.companyName === 'string' && rawItem.companyName.trim()
        ? rawItem.companyName.trim()
        : brandName || target.company || target.domain,
    domain,
    leads,
    companyIntel: {
      websiteUrl: intel?.websiteUrl || (rawRedirected ? `https://${rawRedirected}` : domain ? `https://${domain}` : undefined),
      brandName,
      redirectedDomain: rawRedirected,
      industry,
      linkedinCompanyUrl,
      verificationStage,
      rolesMissing,
      secondPassExecuted,
      emails: siteEmails,
      phones,
      location,
      socialLinks,
      groundingSources: groundingSources.slice(0, 6),
    },
    statusDetail: statusDetail || undefined,
  };
}

function getExecutionCandidates(mode: ApiTierMode): ExecutionCandidate[] {
  if (mode === 'paid') {
    return [
      { model: 'gemini-4-hydrogen', useSearchGrounding: true },
      { model: 'gemini-3.1-flash-lite', useSearchGrounding: false },
    ];
  }

  return [
    { model: 'gemini-3.1-flash-lite', useSearchGrounding: false },
    { model: 'gemini-3.1-flash-lite', useSearchGrounding: true },
    { model: 'gemini-4-hydrogen', useSearchGrounding: false },
  ];
}

const LEAD_RESULT_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    companyName: { type: Type.STRING },
    domain: { type: Type.STRING },
    leads: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          name: { type: Type.STRING },
          role: { type: Type.STRING },
          email_placeholder: { type: Type.STRING },
          sourceUrl: { type: Type.STRING },
          linkedinUrl: { type: Type.STRING },
          verifiedOnLinkedIn: { type: Type.BOOLEAN },
        },
        required: ['name', 'role', 'email_placeholder', 'sourceUrl'],
      },
    },
    companyIntel: {
      type: Type.OBJECT,
      properties: {
        brandName: { type: Type.STRING },
        redirectedDomain: { type: Type.STRING },
        industry: { type: Type.STRING },
        linkedinCompanyUrl: { type: Type.STRING },
        emails: { type: Type.ARRAY, items: { type: Type.STRING } },
        phones: { type: Type.ARRAY, items: { type: Type.STRING } },
        location: { type: Type.STRING },
        socialLinks: { type: Type.ARRAY, items: { type: Type.STRING } },
      },
    },
    statusDetail: { type: Type.STRING },
  },
  required: ['companyName', 'domain', 'leads'],
};

async function formatUnstructuredToJson(
  ai: GoogleGenAI,
  rawText: string,
  expected: 'object' | 'array',
  schema: Record<string, unknown>
) {
  const response = await ai.models.generateContent({
    model: 'gemini-3.1-flash-lite',
    contents: `Extract the factual research data below into strictly valid JSON matching the schema. Do NOT invent any names, emails, or domains not present in the source text.\n\nSOURCE TEXT:\n${rawText}`,
    config: {
      responseMimeType: 'application/json',
      responseSchema: schema,
    },
  });
  return tryParseJson(response.text, expected);
}

async function executeWithFallback(
  ai: GoogleGenAI,
  mode: ApiTierMode,
  buildPrompt: (useSearchGrounding: boolean) => Promise<string> | string,
  expected: 'object' | 'array',
  responseSchema: Record<string, unknown>
) {
  let currentAi = ai;
  const candidates = getExecutionCandidates(mode);
  let lastError: ParsedApiError | null = null;
  const tierNotes: string[] = [];
  let keyRotationAttempts = 0;
  const maxKeyRotations = Math.max(3, keyPool.getKeyCount());

  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    try {
      const prompt = await buildPrompt(candidate.useSearchGrounding);

      const config = candidate.useSearchGrounding
        ? {
            tools: [{ googleSearch: {} }],
            ...(candidate.model === 'gemini-4-hydrogen'
              ? { thinkingConfig: { thinkingLevel: ThinkingLevel.HIGH } }
              : {}),
          }
        : {
            responseMimeType: 'application/json',
            responseSchema,
            ...(candidate.model === 'gemini-4-hydrogen'
              ? { thinkingConfig: { thinkingLevel: ThinkingLevel.HIGH } }
              : {}),
          };

      const response = await currentAi.models.generateContent({
        model: candidate.model,
        contents: prompt,
        config,
      });

      const groundingChunks =
        (response.candidates?.[0]?.groundingMetadata?.groundingChunks as
          | Array<{ web?: { uri?: string; title?: string } }>
          | undefined) ?? [];

      let parsedData = tryParseJson(response.text, expected);
      if (!parsedData && response.text) {
        try {
          parsedData = await formatUnstructuredToJson(currentAi, response.text, expected, responseSchema);
        } catch {
          parsedData = expected === 'array' ? [] : {};
        }
      }

      return {
        parsedData: parsedData ?? (expected === 'array' ? [] : {}),
        modelUsed: candidate.model,
        grounded: candidate.useSearchGrounding,
        fallbackApplied: i > 0 || keyRotationAttempts > 0,
        groundingChunks,
        tierNotes,
      };
    } catch (error: unknown) {
      const parsedErr = parseGeminiError(error);
      lastError = parsedErr;
      tierNotes.push(`${candidate.model}(search=${candidate.useSearchGrounding}):${parsedErr.status}`);

      if (parsedErr.status === 402 && keyPool.getKeyCount() > 1 && keyRotationAttempts < maxKeyRotations) {
        keyRotationAttempts++;
        const nextKey = keyPool.getNextKey();
        if (nextKey) {
          keyPool.markDepleted(nextKey.key);
          console.warn(`[KeyRotation] 402 Prepayment depleted. Rotating to next key (...${nextKey.key.slice(-4)}) and retrying ${candidate.model}...`);
          const newAi = createGeminiClient(nextKey.key);
          if (newAi) {
            currentAi = newAi;
            i--;
            continue;
          }
        }
      }

      if ((parsedErr.status === 429 || parsedErr.isQuotaExhausted) && keyPool.getKeyCount() > 1 && keyRotationAttempts < maxKeyRotations) {
        keyRotationAttempts++;
        const nextKey = keyPool.getNextKey();
        if (nextKey) {
          keyPool.markCooldown(nextKey.key, parsedErr.retryAfterSeconds || 65);
          console.warn(`[KeyRotation] 429 Quota reached. Rotating to next key (...${nextKey.key.slice(-4)}) and retrying ${candidate.model}...`);
          const newAi = createGeminiClient(nextKey.key);
          if (newAi) {
            currentAi = newAi;
            i--;
            continue;
          }
        }
      }

      const canFallback =
        i < candidates.length - 1 &&
        (parsedErr.status === 429 ||
          parsedErr.status === 402 ||
          parsedErr.status === 403 ||
          parsedErr.status === 404 ||
          parsedErr.status === 503 ||
          parsedErr.status === 500);

      if (canFallback) {
        console.warn(
          `Tier fallback (${candidate.model}, grounding=${candidate.useSearchGrounding}) -> status ${parsedErr.status}: ${parsedErr.message}`
        );
        continue;
      }

      throw parsedErr;
    }
  }

  throw lastError ?? { message: 'Lead extraction failed', status: 500, isQuotaExhausted: false };
}

function normalizeMode(rawMode: unknown): ApiTierMode {
  if (rawMode === 'free' || rawMode === 'paid' || rawMode === 'auto') {
    return rawMode;
  }
  return 'auto';
}

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  initDatabase();

  app.get('/api/keys/status', (_req, res) => {
    res.json(keyPool.getStatus());
  });

  app.get('/api/leads/history', async (_req, res) => {
    if (!dbPool) {
      res.json({ saved: false, results: [], message: 'Database not connected yet.' });
      return;
    }
    try {
      const [rows] = await dbPool.query(
        `SELECT id, company_name, domain, industry, total_leads, leads_json, company_intel_json, created_at
         FROM leads_history ORDER BY id DESC LIMIT 100`
      );
      const parsedRows = (rows as any[]).map((row) => ({
        ...row,
        leads: tryParseJson(row.leads_json, 'array') || [],
        companyIntel: tryParseJson(row.company_intel_json, 'object') || {},
      }));
      res.json({ saved: true, results: parsedRows });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/leads/batch-context', async (req, res) => {
    const ai = createGeminiClient();
    if (!ai) {
      res.json({ batchIndustry: '', nicheKeywords: [] });
      return;
    }

    const rawSamples = Array.isArray(req.body?.sampleTargets) ? req.body.sampleTargets : [];
    const samples: string[] = rawSamples
      .filter((s: unknown): s is string => typeof s === 'string' && s.trim().length > 0)
      .map((s: string) => s.trim())
      .slice(0, 12);

    if (samples.length === 0) {
      res.json({ batchIndustry: '', nicheKeywords: [] });
      return;
    }

    // Lightly sample up to 6 domain homepages to read real titles & meta descriptions
    const domainSamples = samples.filter((s) => s.includes('.') && !s.includes(' ')).slice(0, 6);
    const siteSummaries = await Promise.all(
      domainSamples.map(async (rawDom) => {
        const clean = normalizeDomain(rawDom);
        if (!clean) return rawDom;
        try {
          const r = await fetch(`https://${clean}`, {
            headers: { 'User-Agent': BROWSER_UA },
            signal: AbortSignal.timeout(2500),
          });
          if (!r.ok) return clean;
          const html = await r.text();
          const sig = extractStructuredSignals(html, r.url, clean);
          return `${clean}: ${sig.brandName || ''} - ${sig.title} ${sig.siteSummary ? `(${sig.siteSummary.slice(0, 120)})` : ''}`.trim();
        } catch {
          return clean;
        }
      })
    );

    const combinedHints = Array.from(new Set([...siteSummaries, ...samples])).slice(0, 12);

    try {
      const response = await ai.models.generateContent({
        model: 'gemini-3.1-flash-lite',
        contents: `Analyze this bulk list of target companies/domains and identify their primary shared industry vertical and up to 5 industry search keywords (used to disambiguate LinkedIn & web searches).\n\nTargets:\n${combinedHints.map((h, i) => `${i + 1}. ${h}`).join('\n')}`,
        config: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              batchIndustry: { type: Type.STRING },
              nicheKeywords: { type: Type.ARRAY, items: { type: Type.STRING } },
            },
            required: ['batchIndustry', 'nicheKeywords'],
          },
        },
      });
      const parsed = tryParseJson(response.text, 'object') as {
        batchIndustry?: string;
        nicheKeywords?: string[];
      } | null;

      res.json({
        batchIndustry: typeof parsed?.batchIndustry === 'string' ? parsed.batchIndustry.trim() : '',
        nicheKeywords: Array.isArray(parsed?.nicheKeywords)
          ? parsed.nicheKeywords.filter((k): k is string => typeof k === 'string').slice(0, 5)
          : [],
      });
    } catch {
      res.json({ batchIndustry: '', nicheKeywords: [] });
    }
  });

  app.post('/api/leads', async (req, res) => {
    const ai = createGeminiClient();
    if (!ai) {
      res.status(500).json({
        error: 'GEMINI_API_KEY is not configured on the server. Check Settings > Secrets.',
        code: 'MISSING_API_KEY',
      });
      return;
    }

    const company = typeof req.body?.company === 'string' ? req.body.company.trim() : '';
    const domain = typeof req.body?.domain === 'string' ? req.body.domain.trim() : '';
    const batchIndustry = typeof req.body?.batchIndustry === 'string' ? req.body.batchIndustry.trim() : '';
    const mode = normalizeMode(req.body?.mode);
    const roles: string[] = Array.isArray(req.body?.roles)
      ? req.body.roles.filter((r: unknown): r is string => typeof r === 'string' && r.trim().length > 0)
      : [];

    if (!company && !domain) {
      res.status(400).json({
        error: 'A company name or domain is required.',
        code: 'INVALID_REQUEST',
      });
      return;
    }

    const targetRoles = roles.length > 0 ? roles : ['CEO', 'Owner', 'Marketing Manager'];
    const lockedUserDomain = normalizeDomain(domain);
    let websiteIntel: WebsiteIntel | undefined = lockedUserDomain
      ? await fetchWebsiteIntel(company || domain, lockedUserDomain).catch(() => undefined)
      : undefined;

    const buildPrompt = async (useSearchGrounding: boolean) => {
      if (!useSearchGrounding && !websiteIntel) {
        const [aiSuggestions] = await suggestCandidateDomainsWithAI(
          ai,
          [{ company: company || domain, domain }],
          batchIndustry
        );
        websiteIntel = await fetchWebsiteIntel(company || domain, domain, aiSuggestions);
      }

      const siteContext = websiteIntel
        ? `\nVerified Live Discovery Intel:
- Input/Locked Domain: ${lockedUserDomain || websiteIntel.domain || 'None resolved'}
- Redirected Website Host: ${websiteIntel.redirectedDomain || 'None'}
- Discovered Brand/Legal Name: ${websiteIntel.brandName || 'Unknown'}
- Site Description: ${websiteIntel.siteSummary || 'None'}
- LinkedIn Company URL: ${websiteIntel.linkedinCompanyUrl || 'Not on homepage'}
- Public Emails: ${websiteIntel.emails.join(', ') || 'None'}
- Phones: ${websiteIntel.phones.join(', ') || 'None'}
- Socials: ${websiteIntel.socialLinks.join(', ') || 'None'}
- News Headlines: ${websiteIntel.newsItems.map((n) => n.title).join(' | ') || 'None'}
- Site Content:\n${websiteIntel.snippets.join('\n') || 'None'}`
        : '';

      const industryNote = batchIndustry ? `\nBatch Industry Context: "${batchIndustry}"` : '';

      return `
Research the company "${company || domain}"${lockedUserDomain ? ` (LOCKED official domain: ${lockedUserDomain})` : ''}.${industryNote}
Follow this step-by-step verification process:
1. Domain Integrity: ${lockedUserDomain ? `KEEP "domain" strictly equal to "${lockedUserDomain}". If it redirects (e.g. to ${websiteIntel?.redirectedDomain || 'another storefront'}), place the redirect domain in "companyIntel.redirectedDomain" and NEVER replace "${lockedUserDomain}".` : 'Verify the real official website domain.'}
2. Industry & Brand Check: Identify the real brand name (${websiteIntel?.brandName || company || domain}) and its exact industry${batchIndustry ? ` (compare against "${batchIndustry}")` : ''}.
3. Role Audit: Check whether the requested positions (${targetRoles.join(', ')}) exist on the company website or public profiles.
4. LinkedIn & Web Verification: ${useSearchGrounding ? `Use Google Search with "<Brand Name>" + "<Industry>" + role titles and "site:linkedin.com/in" / "site:linkedin.com/company" to verify real decision-makers belonging specifically to this company in this industry, capturing linkedinUrl.` : 'Use ONLY the verified live discovery intel below. Do NOT invent unverified names or guess unverified domains.'}
${siteContext}

STRICT ACCURACY RULES:
- Return ONLY a valid JSON object matching: { "companyName": string, "domain": string, "leads": [{ "name": string, "role": string, "email_placeholder": string, "sourceUrl": string, "linkedinUrl": string, "verifiedOnLinkedIn": boolean }], "companyIntel": { "brandName": string, "redirectedDomain": string, "industry": string, "linkedinCompanyUrl": string, "emails": string[], "phones": string[], "location": string, "socialLinks": string[] }, "statusDetail": string }.
- NEVER invent fake people or placeholder labels. If no real person's name is verified, return "leads": [].
- NEVER output fake emails like "ceo@company.com". Only output a verified public email OR a realistic pattern using the REAL verified domain.
      `.trim();
    };

    try {
      const { parsedData, grounded, groundingChunks } = await executeWithFallback(
        ai,
        mode,
        buildPrompt,
        'object',
        LEAD_RESULT_SCHEMA
      );

      let item = (parsedData && typeof parsedData === 'object' && !Array.isArray(parsedData)
        ? parsedData
        : {}) as Record<string, unknown>;

      const discoveredDomain = lockedUserDomain || normalizeDomain(item.domain);
      if (!websiteIntel && discoveredDomain) {
        websiteIntel = await fetchWebsiteIntel(company || domain, discoveredDomain, [], false).catch(() => undefined);
      }

      let sanitized = sanitizeLeadGenResult(
        item,
        { company: company || domain, domain },
        websiteIntel,
        groundingChunks,
        grounded,
        targetRoles,
        batchIndustry,
        false
      );

      // Pass 2: If grounded search is active and requested roles are missing, re-run targeted LinkedIn + Industry verification
      if (
        grounded &&
        (sanitized.leads.length === 0 || (sanitized.companyIntel?.rolesMissing?.length ?? 0) > 0) &&
        (sanitized.domain || sanitized.companyIntel?.brandName)
      ) {
        try {
          const brandHint = sanitized.companyIntel?.brandName || sanitized.companyName;
          const indHint = sanitized.companyIntel?.industry || batchIndustry || 'company';
          const missing = sanitized.companyIntel?.rolesMissing?.length
            ? sanitized.companyIntel.rolesMissing
            : targetRoles;
          const contactClue = sanitized.companyIntel?.emails?.join(', ') || '';

          const pass2Res = await executeWithFallback(
            ai,
            mode,
            () => `
Second-Pass LinkedIn & Industry Re-Verification for:
- Company / Brand: "${brandHint}"
- Locked Domain: "${sanitized.domain}"${sanitized.companyIntel?.redirectedDomain ? ` (Live site: ${sanitized.companyIntel.redirectedDomain})` : ''}
- Industry: "${indHint}"
- Missing Target Roles: ${missing.join(', ')}
- Known Site Email Clues: ${contactClue || 'None'}

Search specifically on LinkedIn ("${brandHint}" "${indHint}" site:linkedin.com) and "${sanitized.domain}" / "${sanitized.companyIntel?.redirectedDomain || ''}" to verify decision-makers for the missing roles.
Return ONLY valid JSON matching the object schema, keeping "domain" equal to "${sanitized.domain}". Do NOT fabricate names if none are verified.
            `.trim(),
            'object',
            LEAD_RESULT_SCHEMA
          );

          const p2Item = (pass2Res.parsedData && typeof pass2Res.parsedData === 'object' && !Array.isArray(pass2Res.parsedData)
            ? pass2Res.parsedData
            : {}) as Record<string, unknown>;
          const mergedRawLeads = [
            ...(Array.isArray(item.leads) ? item.leads : []),
            ...(Array.isArray(p2Item.leads) ? p2Item.leads : []),
          ];
          item = {
            ...item,
            leads: mergedRawLeads,
            companyIntel: {
              ...((item.companyIntel as Record<string, unknown>) || {}),
              ...((p2Item.companyIntel as Record<string, unknown>) || {}),
            },
          };
          sanitized = sanitizeLeadGenResult(
            item,
            { company: company || domain, domain },
            websiteIntel,
            [...groundingChunks, ...pass2Res.groundingChunks],
            pass2Res.grounded,
            targetRoles,
            batchIndustry,
            true
          );
        } catch {
          // Keep Pass 1 result if Pass 2 fails or hits quota
        }
      }

      await saveLeadsToDatabase(sanitized, batchIndustry);

      res.json(sanitized);
    } catch (err: unknown) {
      const parsedErr = (err as ParsedApiError)?.status ? (err as ParsedApiError) : parseGeminiError(err);
      if (parsedErr.status === 429) {
        console.warn(`Lead Gen rate/quota limit (429): ${parsedErr.message}`);
      } else {
        console.error('Lead Gen API Error:', parsedErr.message);
      }
      res.status(parsedErr.status).json({
        error: parsedErr.message,
        status: parsedErr.status,
        code: parsedErr.code,
        isQuotaExhausted: parsedErr.isQuotaExhausted,
        retryAfterSeconds: parsedErr.retryAfterSeconds,
      });
    }
  });

  app.post('/api/leads/batch', async (req, res) => {
    const ai = createGeminiClient();
    if (!ai) {
      res.status(500).json({
        error: 'GEMINI_API_KEY is not configured on the server. Check Settings > Secrets.',
        code: 'MISSING_API_KEY',
      });
      return;
    }

    const mode = normalizeMode(req.body?.mode);
    const batchIndustry = typeof req.body?.batchIndustry === 'string' ? req.body.batchIndustry.trim() : '';
    const rawTargets = Array.isArray(req.body?.targets) ? req.body.targets : [];
    const targets: Array<{ company: string; domain: string }> = rawTargets
      .slice(0, 4)
      .map((t: { company?: unknown; domain?: unknown }) => ({
        company: typeof t?.company === 'string' ? t.company.trim() : '',
        domain: typeof t?.domain === 'string' ? t.domain.trim() : '',
      }))
      .filter((t: { company: string; domain: string }) => t.company || t.domain);

    const roles: string[] = Array.isArray(req.body?.roles)
      ? req.body.roles.filter((r: unknown): r is string => typeof r === 'string' && r.trim().length > 0)
      : [];

    if (targets.length === 0) {
      res.status(400).json({
        error: 'At least one company target is required.',
        code: 'INVALID_REQUEST',
      });
      return;
    }

    const targetRoles = roles.length > 0 ? roles : ['CEO', 'Owner', 'Marketing Manager'];

    // Stage 1: Always inspect user-provided domains immediately so locked domains, redirects, and brand names are accurate BEFORE Pass 1!
    let intelList: WebsiteIntel[] | undefined = targets.some((t) => normalizeDomain(t.domain))
      ? await Promise.all(
          targets.map((t) =>
            normalizeDomain(t.domain)
              ? fetchWebsiteIntel(t.company || t.domain, normalizeDomain(t.domain)).catch(() => ({
                  domain: normalizeDomain(t.domain),
                  emails: [],
                  phones: [],
                  socialLinks: [],
                  jsonLdPeople: [],
                  snippets: [],
                  sourceUrls: [],
                  newsItems: [],
                }))
              : Promise.resolve({
                  domain: '',
                  emails: [],
                  phones: [],
                  socialLinks: [],
                  jsonLdPeople: [],
                  snippets: [],
                  sourceUrls: [],
                  newsItems: [],
                })
          )
        )
      : undefined;

    const buildPrompt = async (useSearchGrounding: boolean) => {
      if (!useSearchGrounding) {
        const missingIndices = targets
          .map((t, idx) => (!intelList?.[idx]?.domain ? idx : -1))
          .filter((idx) => idx !== -1);

        if (!intelList || missingIndices.length > 0) {
          const toResolve = missingIndices.length > 0 ? missingIndices.map((i) => targets[i]) : targets;
          const aiDomainSuggestions = await suggestCandidateDomainsWithAI(ai, toResolve, batchIndustry);
          const fetched = await Promise.all(
            toResolve.map((t, i) =>
              fetchWebsiteIntel(t.company || t.domain, t.domain, aiDomainSuggestions[i] ?? [])
            )
          );
          if (!intelList) {
            intelList = fetched;
          } else {
            missingIndices.forEach((origIdx, i) => {
              intelList![origIdx] = fetched[i];
            });
          }
        }
      }

      const targetList = targets
        .map((t, idx) => {
          const intel = intelList?.[idx];
          const locked = normalizeDomain(t.domain);
          const base = `${idx + 1}. ${t.company || t.domain}${locked ? ` (LOCKED input domain: ${locked})` : ''}`;
          if (!intel || (!intel.domain && !intel.snippets.length && !intel.emails.length)) return base;
          return `${base}
   - Locked/Verified Domain: ${locked || intel.domain || 'None verified'}
   - Redirected Storefront Host: ${intel.redirectedDomain || 'None'}
   - Discovered Brand Name: ${intel.brandName || 'Unknown'}
   - Site Summary: ${intel.siteSummary || 'None'}
   - LinkedIn Company Link: ${intel.linkedinCompanyUrl || 'Not listed on site'}
   - Public Emails: ${intel.emails.join(', ') || 'None'}
   - Phones: ${intel.phones.join(', ') || 'None'}
   - Socials: ${intel.socialLinks.join(', ') || 'None'}
   - News Headlines: ${intel.newsItems.map((n) => n.title).join(' | ') || 'None'}
   - Site Snippets: ${intel.snippets.join(' | ') || 'None'}`;
        })
        .join('\n');

      const industryLine = batchIndustry
        ? `Bulk Batch Industry Context: "${batchIndustry}" (use this industry context when searching and disambiguating companies & LinkedIn profiles).`
        : 'Infer each company industry from its site summary or company name when searching.';

      return `
Research each of the following ${targets.length} companies:
${targetList}

${industryLine}
Target roles to find & verify: ${targetRoles.join(', ')}.

THINKING & VERIFICATION PROTOCOL FOR EACH COMPANY:
1. Domain Lock: If a "(LOCKED input domain: ...)" is shown, ALWAYS return that exact domain in "domain". If the site redirects to another domain (e.g. a rebrand), record that redirect in "companyIntel.redirectedDomain" — NEVER replace the user's input domain.
2. Company + Industry Audit: Identify the real brandName and industry from the live site/batch context, and check whether the requested target roles appear in the site snippets or public profiles.
3. ${
  useSearchGrounding
    ? 'LinkedIn & Web Verification: For any roles not directly listed on the site, use Google Search with "<Brand Name>" + "<Industry>" + role titles and site:linkedin.com/in or site:linkedin.com/company to verify decision-makers belonging strictly to THIS company and industry. Include linkedinUrl and verifiedOnLinkedIn: true when verified.'
    : 'Site-Verified Mode: Use ONLY the verified live discovery intel above. If Verified Domain is "None verified", return domain: "" — DO NOT guess unverified domains.'
}
4. NEVER invent placeholder names (no "Unknown", no "CEO (unverified)", no role-only names). If no real person's name is verified, return "leads": [].
5. NEVER use fake domains ("company.com", "example.com") or fake emails ("ceo@company.com"). Only output a verified public email or a realistic pattern using the REAL domain.
6. Output ONLY a valid JSON array of exactly ${targets.length} objects in the exact order listed, matching:
{ "companyName": string, "domain": string, "leads": [{ "name": string, "role": string, "email_placeholder": string, "sourceUrl": string, "linkedinUrl": string, "verifiedOnLinkedIn": boolean }], "companyIntel": { "brandName": string, "redirectedDomain": string, "industry": string, "linkedinCompanyUrl": string, "emails": string[], "phones": string[], "location": string, "socialLinks": string[] }, "statusDetail": string }
      `.trim();
    };

    try {
      const { parsedData, modelUsed, grounded, fallbackApplied, groundingChunks, tierNotes } =
        await executeWithFallback(
          ai,
          mode,
          buildPrompt,
          'array',
          {
            type: Type.ARRAY,
            items: LEAD_RESULT_SCHEMA,
          }
        );

      const items = Array.isArray(parsedData) ? parsedData : [];

      const enrichedIntel = await Promise.all(
        targets.map((target, idx) => {
          const existing = intelList?.[idx];
          if (existing && (existing.domain || existing.snippets.length > 0)) {
            return Promise.resolve(existing);
          }
          const item = (items[idx] ?? {}) as Record<string, unknown>;
          const foundDomain = normalizeDomain(target.domain) || normalizeDomain(item.domain);
          return foundDomain
            ? fetchWebsiteIntel(target.company || target.domain, foundDomain, [], false).catch(() => existing)
            : Promise.resolve(existing);
        })
      );

      const results = targets.map((target, idx) => {
        const item = (items[idx] ?? {}) as Record<string, unknown>;
        return sanitizeLeadGenResult(
          item,
          target,
          enrichedIntel[idx],
          groundingChunks,
          grounded,
          targetRoles,
          batchIndustry,
          false
        );
      });

      // Pass 2: Smart Re-Verification when grounded search is active and targets have missing roles or rebranded names
      const incompleteIndices = grounded
        ? results
            .map((r, idx) =>
              (r.leads.length === 0 || (r.companyIntel?.rolesMissing?.length ?? 0) > 0) &&
              (r.domain || r.companyIntel?.brandName)
                ? idx
                : -1
            )
            .filter((idx) => idx !== -1)
        : [];

      if (incompleteIndices.length > 0) {
        try {
          const pass2TargetsPrompt = incompleteIndices
            .map((origIdx, i) => {
              const r = results[origIdx];
              const brand = r.companyIntel?.brandName || r.companyName;
              const ind = r.companyIntel?.industry || batchIndustry || 'company';
              const missing = r.companyIntel?.rolesMissing?.length ? r.companyIntel.rolesMissing : targetRoles;
              const emailClues = r.companyIntel?.emails?.join(', ') || 'None';
              return `${i + 1}. Brand: "${brand}" | Locked Domain: "${r.domain}"${r.companyIntel?.redirectedDomain ? ` | Redirect Host: "${r.companyIntel.redirectedDomain}"` : ''} | Industry: "${ind}" | Missing Roles: [${missing.join(', ')}] | Email Clues: ${emailClues}`;
            })
            .join('\n');

          const pass2Res = await executeWithFallback(
            ai,
            mode,
            () => `
Second-Pass LinkedIn & Industry Re-Verification for ${incompleteIndices.length} companies whose target roles were incomplete:
${pass2TargetsPrompt}

For EACH company:
1. Search LinkedIn ("<Brand>" "<Industry>" site:linkedin.com/in OR site:linkedin.com/company) and verify any email clue (e.g. first name in shubhang@...) against the real brand and industry.
2. Return ONLY a JSON array of exactly ${incompleteIndices.length} objects in the exact order listed, preserving each company's Locked Domain in "domain".
3. NEVER invent unverified names or fake emails.
            `.trim(),
            'array',
            {
              type: Type.ARRAY,
              items: LEAD_RESULT_SCHEMA,
            }
          );

          const p2Items = Array.isArray(pass2Res.parsedData) ? pass2Res.parsedData : [];
          incompleteIndices.forEach((origIdx, i) => {
            const p1Item = (items[origIdx] ?? {}) as Record<string, unknown>;
            const p2Item = (p2Items[i] ?? {}) as Record<string, unknown>;
            const mergedItem: Record<string, unknown> = {
              ...p1Item,
              leads: [
                ...(Array.isArray(p1Item.leads) ? p1Item.leads : []),
                ...(Array.isArray(p2Item.leads) ? p2Item.leads : []),
              ],
              companyIntel: {
                ...((p1Item.companyIntel as Record<string, unknown>) || {}),
                ...((p2Item.companyIntel as Record<string, unknown>) || {}),
              },
              statusDetail:
                (typeof p2Item.statusDetail === 'string' && p2Item.statusDetail) || p1Item.statusDetail,
            };
            results[origIdx] = sanitizeLeadGenResult(
              mergedItem,
              targets[origIdx],
              enrichedIntel[origIdx],
              [...groundingChunks, ...pass2Res.groundingChunks],
              pass2Res.grounded,
              targetRoles,
              batchIndustry,
              true
            );
          });
        } catch {
          // Preserve Pass 1 verified results if Pass 2 hits rate/quota limits
        }
      }

      for (const r of results) {
        await saveLeadsToDatabase(r, batchIndustry);
      }

      res.json({
        results,
        meta: {
          modelUsed,
          grounded,
          fallbackApplied,
          tierNotes,
        },
      });
    } catch (err: unknown) {
      const parsedErr = (err as ParsedApiError)?.status ? (err as ParsedApiError) : parseGeminiError(err);
      if (parsedErr.status === 429) {
        console.warn(`Lead Gen batch rate/quota limit (429): ${parsedErr.message}`);
      } else {
        console.error('Lead Gen Batch API Error:', parsedErr.message);
      }
      res.status(parsedErr.status).json({
        error: parsedErr.message,
        status: parsedErr.status,
        code: parsedErr.code,
        isQuotaExhausted: parsedErr.isQuotaExhausted,
        retryAfterSeconds: parsedErr.retryAfterSeconds,
      });
    }
  });

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
