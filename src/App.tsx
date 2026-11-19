import React, { useState, useEffect, useMemo, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import * as XLSX from 'xlsx';
import { Search, ShieldCheck, Globe, Mail, Link2, Activity, Upload, Download, Clock, FileSpreadsheet, AlertTriangle, X, Square, Phone, MapPin, ExternalLink, RotateCcw, Briefcase, CheckCircle2 } from 'lucide-react';
import { cn } from './lib/utils';
import { AppMode, ApiTierMode, LeadGenResult, Lead } from './types';
import { leadGenService, TargetInput } from './lib/gemini';
import { persistenceService, supabase } from './lib/supabase';

// --- Components ---

const sanitizeExternalUrl = (rawUrl?: string): string | null => {
  if (!rawUrl) return null;
  const trimmed = rawUrl.trim();
  if (!trimmed || trimmed.toUpperCase() === 'N/A') return null;
  const candidate = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return parsed.toString();
    }
    return null;
  } catch {
    return null;
  }
};

const EXPORT_JUNK_PREFIXES = [
  'noreply', 'no-reply', 'no_reply', 'donotreply', 'do-not-reply', 'do_not_reply',
  'mailer-daemon', 'postmaster', 'webmaster', 'hostmaster', 'abuse', 'dmca',
  'unsubscribe', 'bounce', 'dataprotection', 'data-protection', 'data_protection',
  'dpo', 'gdpr', 'privacy', 'cookies', 'cookie', 'accessibility',
  'supplieronboarding', 'hrhelp', 'hr-help', 'hr_help', 'compliance', 'security',
];

const EXPORT_GENERIC_PREFIXES = new Set([
  'info', 'contact', 'contactus', 'hello', 'hi', 'hey', 'office', 'admin', 'team',
  'inquiries', 'inquiry', 'enquiries', 'general', 'mail', 'support', 'customerservice',
  'customer-service', 'service', 'help', 'helps', 'care', 'sales', 'marketing', 'growth',
  'bd', 'business', 'partnerships', 'wholesale', 'commercial', 'export', 'ceo', 'owner',
  'founder', 'founders', 'president', 'director', 'exec', 'executive', 'leadership',
  'press', 'media', 'pr', 'news', 'events', 'legal', 'dp', 'investors', 'investor',
  'hr', 'careers', 'jobs', 'recruiting', 'billing', 'accounting', 'invoices', 'finance',
  'orders', 'order', 'maintprog', 'special_markets',
]);

// ---------- Exhibitor Extractor: Bookmarklet ----------
// One-click bookmarklet for exhibition directories (MapYourShow, floorplan lists, etc.)
// Extracts company name + website domain as "Name | domain.com" and copies to clipboard.
const EXHIBITOR_BOOKMARKLET = `javascript:(function(){var results=[];document.querySelectorAll('a[href*="http"], .exhibitor-name, .company-name, .booth-name, [class*="exhibitor"], [class*="company"], [class*="booth"], .listing-item, .floorplan-item, .exhibitor-listing').forEach(function(el){var text=el.innerText||el.textContent||'';text=text.trim();var href=el.getAttribute('href');var domain='';if(href){var m=href.match(/https?:\\/\\/([^\\/]+)/);if(m){domain=m[1].replace(/^www\\./,'').replace(/:\\d+$/,'');}}var skip=['mapyourshow','expo','registration','login','map-your-show','showmanagement','exhibitor-login','attendee'];if(text&&domain&&!skip.some(function(s){return domain.toLowerCase().includes(s);})){results.push(text+' | '+domain);}});var seen={};var unique=results.filter(function(v){if(!seen[v]){seen[v]=true;return true;}return false;});navigator.clipboard.writeText(unique.join('\\n')).then(function(){alert('Extracted '+unique.length+' exhibitors (Name | domain.com) copied to clipboard!');});})();`;

const isExportJunkEmail = (email: string): boolean => {
  const lower = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(lower)) return true;
  if (lower.includes('not publicly listed')) return true;
  const [localPart = '', dom = ''] = lower.split('@');
  if (!localPart || !dom) return true;
  if (['company.com', 'example.com', 'domain.com', 'yourdomain.com', 'yourbrand.com', 'yoursite.com', 'placeholder.com'].includes(dom)) {
    return true;
  }
  return EXPORT_JUNK_PREFIXES.some(p => localPart === p || localPart.startsWith(`${p}.`) || localPart.startsWith(`${p}+`));
};

const scoreExportEmail = (email: string): number => {
  const lower = email.trim().toLowerCase();
  if (!lower || isExportJunkEmail(lower)) return -1;
  const [localPart = ''] = lower.split('@');
  const baseToken = localPart.split(/[+.]/)[0];

  if (['ceo', 'owner', 'founder', 'founders', 'president', 'director', 'exec', 'executive', 'partner'].includes(localPart)) return 90;
  if (['sales', 'marketing', 'growth', 'bd', 'business', 'partnerships', 'wholesale', 'commercial', 'export'].includes(localPart)) return 80;
  if (['info', 'contact', 'contactus', 'hello', 'hi', 'office', 'admin', 'team', 'inquiries', 'enquiries', 'general', 'mail'].includes(localPart)) return 65;
  if (['support', 'customerservice', 'customer-service', 'service', 'help', 'helps', 'care', 'orders', 'order'].includes(localPart)) return 40;
  if (['press', 'media', 'pr', 'news', 'events', 'legal', 'dp', 'investors', 'investor', 'hr', 'careers', 'jobs', 'billing', 'accounting', 'invoices', 'finance', 'maintprog', 'special_markets'].includes(localPart)) return 15;
  if (EXPORT_GENERIC_PREFIXES.has(localPart) || EXPORT_GENERIC_PREFIXES.has(baseToken)) return 50;
  return localPart.includes('.') || localPart.includes('_') ? 105 : 100;
};

const normalizeAndSortEmails = (rawList: string[]): string[] => {
  const seen = new Set<string>();
  const cleanList: string[] = [];
  for (const raw of rawList) {
    if (!raw) continue;
    for (const part of raw.split(/[;,|\n]+/)) {
      const candidate = part.trim().toLowerCase();
      if (!candidate || isExportJunkEmail(candidate) || seen.has(candidate)) continue;
      seen.add(candidate);
      cleanList.push(candidate);
    }
  }
  return cleanList.sort((a, b) => {
    const diff = scoreExportEmail(b) - scoreExportEmail(a);
    return diff !== 0 ? diff : a.localeCompare(b);
  });
};

const classifyEmailCategory = (email: string): string => {
  if (!email) return 'None';
  const score = scoreExportEmail(email);
  if (score >= 100) return 'Personal / Direct';
  if (score >= 90) return 'Executive Inbox';
  if (score >= 80) return 'Sales / Marketing';
  if (score >= 65) return 'General Contact';
  if (score >= 40) return 'Support';
  return 'Department';
};

const LeadCard: React.FC<{ lead: Lead }> = ({ lead }) => {
  const safeUrl = sanitizeExternalUrl(lead.sourceUrl);
  const safeLinkedinUrl = sanitizeExternalUrl(lead.linkedinUrl);
  const emailBadge =
    lead.email_type === 'VERIFIED'
      ? { label: 'VERIFIED', cls: 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10' }
      : lead.email_type === 'PATTERN'
        ? { label: 'PATTERN', cls: 'text-cyan-400 border-cyan-500/30 bg-cyan-500/10' }
        : { label: 'UNLISTED', cls: 'text-slate-500 border-slate-500/20 bg-slate-500/5' };

  return (
    <motion.div 
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className="glass-card p-5 group flex flex-col justify-between"
    >
      <div>
        <div className="flex justify-between items-start mb-3 gap-2">
          <div>
            <h4 className="font-medium text-white text-base">{lead.name}</h4>
            <div className="flex items-center gap-2 mt-0.5 flex-wrap">
               <span className="text-[10px] font-mono text-cyan-500/80 uppercase tracking-tighter">{lead.role}</span>
               {(lead.verifiedOnLinkedIn || safeLinkedinUrl) && (
                 <span className="text-[8px] font-mono px-1.5 py-0.5 rounded border border-sky-500/30 bg-sky-500/10 text-sky-300 uppercase tracking-wider">
                   LinkedIn
                 </span>
               )}
            </div>
          </div>
          <div
            className={cn(
              "h-5 w-5 rounded-full flex items-center justify-center shrink-0",
              safeUrl || safeLinkedinUrl ? "bg-cyan-500/10" : "bg-slate-800/60"
            )}
            title={safeLinkedinUrl ? "LinkedIn & Source Verified" : safeUrl ? "Verified External Source" : "No External Source"}
          >
             <ShieldCheck className={cn("w-3 h-3", safeUrl || safeLinkedinUrl ? "text-cyan-400" : "text-slate-600")} />
          </div>
        </div>
        <div className="space-y-2 mt-4 pt-4 border-t border-white/5">
          <div className="flex items-center justify-between gap-2 text-[11px] text-slate-400 font-mono">
            <div className="flex items-center gap-2 min-w-0">
              <Mail className="w-3 h-3 text-cyan-600 shrink-0" />
              <span className="truncate">{lead.email_placeholder}</span>
            </div>
            <span className={cn("text-[8px] px-1.5 py-0.5 rounded border uppercase tracking-wider shrink-0", emailBadge.cls)}>
              {emailBadge.label}
            </span>
          </div>
        </div>
      </div>
      
      <div className="mt-4 flex gap-2">
        {safeLinkedinUrl && (
          <a
            href={safeLinkedinUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex-1 flex items-center justify-center gap-1.5 py-2 bg-sky-500/10 border border-sky-500/20 rounded-lg text-[10px] text-sky-300 uppercase font-bold tracking-widest hover:bg-sky-500/20 hover:border-sky-400/40 transition-all"
          >
            <ExternalLink className="w-3 h-3" />
            LinkedIn
          </a>
        )}
        {safeUrl ? (
          <a 
            href={safeUrl} 
            target="_blank" 
            rel="noopener noreferrer"
            className="flex-1 flex items-center justify-center gap-2 py-2 bg-black/40 border border-white/5 rounded-lg text-[10px] text-slate-400 uppercase font-bold tracking-widest hover:text-cyan-400 hover:border-cyan-500/30 transition-all group/link"
          >
            <Link2 className="w-3 h-3 group-hover/link:animate-pulse" />
            Verified Source
          </a>
        ) : !safeLinkedinUrl ? (
          <div className="flex-1 flex items-center justify-center gap-2 py-2 bg-black/20 border border-white/5 rounded-lg text-[10px] text-slate-600 uppercase font-bold tracking-widest cursor-not-allowed">
            <Link2 className="w-3 h-3" />
            Source Unavailable
          </div>
        ) : null}
      </div>
    </motion.div>
  );
};

interface TargetStatus {
  name: string;
  status: 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED';
  error?: string;
}

interface ApiAlert {
  type: 'quota' | 'auth' | 'error';
  title: string;
  message: string;
}

const LeadFinder = () => {
  const [bulkInput, setBulkInput] = useState('');
  const [roles, setRoles] = useState('CEO, Owner, Marketing Manager');
  const [researcherEmail, setResearcherEmail] = useState('');
  const [emailError, setEmailError] = useState('');
  const [targetError, setTargetError] = useState('');
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<LeadGenResult[]>([]);
  const [currentIndex, setCurrentIndex] = useState(-1);
  const [statuses, setStatuses] = useState<TargetStatus[]>([]);
  const [roleFilter, setRoleFilter] = useState('ALL_PROTOCOLS');
  const [statusFilter, setStatusFilter] = useState<'ALL' | 'WITH_LEADS' | 'VERIFIED_CONTACTS' | 'UNVERIFIED'>('ALL');
  const [hasSubmitted, setHasSubmitted] = useState(false);
  const [apiMode, setApiMode] = useState<ApiTierMode>('auto');
  const [activeTierInfo, setActiveTierInfo] = useState<string | null>(null);
  const [batchIndustry, setBatchIndustry] = useState<string>('');
  const [analyzingIndustry, setAnalyzingIndustry] = useState(false);
  const [apiAlert, setApiAlert] = useState<ApiAlert | null>(null);
  const abortRef = useRef(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const exhibitorFileRef = useRef<HTMLInputElement | null>(null);

  // Exhibitor Extractor state
  const [showExhibitorExtractor, setShowExhibitorExtractor] = useState(false);
  const [exhibitorRawText, setExhibitorRawText] = useState('');
  const [exhibitorParsed, setExhibitorParsed] = useState<{ company: string; domain: string }[]>([]);
  const [exhibitorError, setExhibitorError] = useState('');

  const availableRoles = useMemo(() => {
    const rolesSet = new Set<string>();
    results.forEach(res => {
      if (res && res.leads) {
        res.leads.forEach(l => {
          if (l && l.role) rolesSet.add(l.role);
        });
      }
    });
    return Array.from(rolesSet).sort();
  }, [results]);

  const isValidEmail = (email: string) => {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  };

  const handleStopBatch = () => {
    abortRef.current = true;
  };

  const handleTargetFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const lower = file.name.toLowerCase();
      const extracted: string[] = [];
      if (lower.endsWith('.xlsx') || lower.endsWith('.xls')) {
        const buffer = await file.arrayBuffer();
        const workbook = XLSX.read(buffer, { type: 'array' });
        const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json<unknown[]>(firstSheet, { header: 1 });
        for (const row of rows) {
          if (!Array.isArray(row)) continue;
          const firstCell = typeof row[0] === 'string' || typeof row[0] === 'number' ? String(row[0]).trim() : '';
          if (firstCell && !/^(company|name|domain|target)$/i.test(firstCell)) {
            extracted.push(firstCell);
          }
        }
      } else {
        const text = await file.text();
        const lines = text.split(/\r?\n/);
        for (const line of lines) {
          const firstCol = line.split(',')[0]?.replace(/^["']|["']$/g, '').trim();
          if (firstCol && !/^(company|name|domain|target)$/i.test(firstCol)) {
            extracted.push(firstCol);
          }
        }
      }
      if (extracted.length > 0) {
        const merged = Array.from(
          new Set([
            ...bulkInput.split('\n').map(t => t.trim()).filter(Boolean),
            ...extracted,
          ])
        ).join('\n');
        setBulkInput(merged);
        setTargetError('');
      }
    } catch {
      setTargetError('INVALID_TARGET_FILE');
    }
  };

  // ---------- Exhibitor Extractor: Smart List Parser ----------

  const parseExhibitorPairs = (text: string): { company: string; domain: string }[] => {
    const pairs: { company: string; domain: string }[] = [];
    const seen = new Set<string>();

    text.split(/[\r\n]+/).forEach((rawLine) => {
      const line = rawLine.trim();
      if (!line) return;

      // Handle "Company | domain.com" pipe format
      if (line.includes('|')) {
        const [companyPart, domainPart] = line.split('|').map((s) => s.trim());
        if (companyPart && domainPart) {
          const key = `${companyPart.toLowerCase()}|${domainPart.toLowerCase()}`;
          if (!seen.has(key)) {
            seen.add(key);
            pairs.push({ company: companyPart, domain: domainPart });
          }
        }
      } else if (line.includes('.') && !line.includes(' ')) {
        // Bare domain: domain.com
        const key = `|${line.toLowerCase()}`;
        if (!seen.has(key)) {
          seen.add(key);
          pairs.push({ company: line.split('.')[0], domain: line });
        }
      } else {
        // Bare company name: Acme Corp
        const key = `${line.toLowerCase()}|`;
        if (!seen.has(key)) {
          seen.add(key);
          pairs.push({ company: line, domain: '' });
        }
      }
    });

    return pairs;
  };

  const handleExhibitorPaste = () => {
    if (!exhibitorRawText.trim()) {
      setExhibitorError('PASTE_TEXT_REQUIRED');
      return;
    }
    try {
      const pairs = parseExhibitorPairs(exhibitorRawText);
      if (pairs.length === 0) {
        setExhibitorError('NO_VALID_PAIRS_FOUND');
        return;
      }
      setExhibitorParsed(pairs);
      setExhibitorError('');
    } catch {
      setExhibitorError('PARSE_ERROR');
    }
  };

  const handleExhibitorFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const lower = file.name.toLowerCase();
      let text = '';

      if (lower.endsWith('.xlsx') || lower.endsWith('.xls')) {
        const buffer = await file.arrayBuffer();
        const workbook = XLSX.read(buffer, { type: 'array' });
        const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json<unknown[]>(firstSheet, { header: 1 });
        const lines: string[] = [];
        for (const row of rows) {
          if (!Array.isArray(row)) continue;
          lines.push(row.map((cell) => (cell == null ? '' : String(cell))).join(' | '));
        }
        text = lines.join('\n');
      } else {
        text = await file.text();
      }

      const pairs = parseExhibitorPairs(text);
      if (pairs.length === 0) {
        setExhibitorError('NO_VALID_PAIRS_FOUND');
        return;
      }
      setExhibitorParsed(pairs);
      setExhibitorRawText(text);
      setExhibitorError('');
    } catch {
      setExhibitorError('INVALID_EXHIBITOR_FILE');
    }
  };

  const copyToClipboard = (text: string, successMsg: string) => {
    navigator.clipboard
      .writeText(text)
      .then(() => {
        setExhibitorError(successMsg);
        setTimeout(() => setExhibitorError(''), 2000);
      })
      .catch(() => setExhibitorError('COPY_FAILED'));
  };

  const addParsedToBatch = () => {
    if (exhibitorParsed.length === 0) return;
    const newLines = exhibitorParsed.map((p) =>
      p.domain ? `${p.company} | ${p.domain}` : p.company
    );
    const merged = Array.from(
      new Set([
        ...bulkInput.split('\n').map((t) => t.trim()).filter(Boolean),
        ...newLines,
      ])
    ).join('\n');
    setBulkInput(merged);
    setShowExhibitorExtractor(false);
    setExhibitorParsed([]);
    setExhibitorRawText('');
  };

  const runBatchTargets = async (
    targets: string[],
    modeType: 'fresh' | 'retry_failed' | 'reverify_incomplete' = 'fresh'
  ) => {
    setLoading(true);
    setApiAlert(null);
    abortRef.current = false;
    const isFresh = modeType === 'fresh';

    if (isFresh) {
      setResults([]);
      setActiveTierInfo(null);
      setBatchIndustry('');
      setStatuses(targets.map(t => ({ name: t, status: 'PENDING' })));
    } else {
      const targetSet = new Set(targets.map(t => t.toLowerCase()));
      setStatuses(prev => {
        const existingKeys = new Set(prev.map(s => s.name.toLowerCase()));
        const updated = prev.map(s =>
          targetSet.has(s.name.toLowerCase()) ? { ...s, status: 'PENDING' as const, error: undefined } : s
        );
        const missing = targets
          .filter(t => !existingKeys.has(t.toLowerCase()))
          .map(t => ({ name: t, status: 'PENDING' as const }));
        return [...updated, ...missing];
      });
    }

    const rolesArray = roles.split(',').map(r => r.trim()).filter(r => r !== '');
    let detectedIndustry = isFresh ? '' : batchIndustry;

    if (targets.length > 0 && (isFresh || !detectedIndustry)) {
      setAnalyzingIndustry(true);
      try {
        const ctx = await leadGenService.analyzeBatchContext(targets.slice(0, 12), rolesArray, apiMode);
        if (ctx.batchIndustry) {
          detectedIndustry = ctx.batchIndustry;
          setBatchIndustry(ctx.batchIndustry);
        }
      } catch {
        // Non-blocking industry inference
      } finally {
        setAnalyzingIndustry(false);
      }
    }

    const currentResults: LeadGenResult[] = [];
    const CHUNK_SIZE = 3;

    const parseTargetInput = (target: string): TargetInput => {
      // Explicit domain format: "Company | domain.com" — lock domain 100%, never guess
      const pipeIdx = target.indexOf('|');
      if (pipeIdx !== -1) {
        return {
          company: target.slice(0, pipeIdx).trim(),
          domain: target.slice(pipeIdx + 1).trim(),
        };
      }
      const looksLikeDomain = target.includes('.') && !target.includes(' ');
      return {
        company: looksLikeDomain ? target.split('.')[0] : target,
        domain: looksLikeDomain ? target : '',
      };
    };

    const setChunkStatus = (chunkNames: string[], status: TargetStatus['status'], error?: string) => {
      const nameSet = new Set(chunkNames.map(n => n.toLowerCase()));
      setStatuses(prev =>
        prev.map(s => (nameSet.has(s.name.toLowerCase()) ? { ...s, status, error } : s))
      );
    };

    const sleepWithCountdown = async (seconds: number, chunkNames: string[], label: string) => {
      for (let remaining = seconds; remaining > 0; remaining--) {
        if (abortRef.current) return;
        setChunkStatus(chunkNames, 'PROCESSING', `${label} (${remaining}s)`);
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    };

    const fetchChunkWithRetry = async (
      chunkTargets: TargetInput[],
      chunkNames: string[],
      maxRetries = 3
    ) => {
      let attempts = 0;
      while (attempts <= maxRetries) {
        if (abortRef.current) {
          throw new Error('BATCH_ABORTED');
        }
        try {
          const response = await leadGenService.findLeadsBatch(chunkTargets, rolesArray, apiMode, detectedIndustry);
          if (response.meta) {
            setActiveTierInfo(
              response.meta.grounded
                ? `${response.meta.modelUsed} · Grounded`
                : `${response.meta.modelUsed} · Multi-Tool Verified`
            );
          }
          return response.results;
        } catch (err: any) {
          attempts++;
          const errMessage = typeof err?.message === 'string' ? err.message : '';
          const errStatus = err?.status;
          const isQuotaExhausted = Boolean(err?.isQuotaExhausted);
          const isRateLimit = errStatus === 429 || errMessage.includes('429') || errMessage.includes('RESOURCE_EXHAUSTED');
          const isTransient = errStatus === 500 || errStatus === 502 || errStatus === 503 || errStatus === 504;

          if (isQuotaExhausted && !err?.retryAfterSeconds && attempts > 1) {
            throw err;
          }

          if ((isRateLimit || isTransient) && attempts <= maxRetries && !abortRef.current) {
            const retrySec =
              typeof err?.retryAfterSeconds === 'number' && err.retryAfterSeconds > 0
                ? Math.min(err.retryAfterSeconds + 1, 45)
                : isRateLimit
                  ? 12 * attempts
                  : 4 * attempts;

            await sleepWithCountdown(retrySec, chunkNames, `Rate Cooldown ${attempts}/${maxRetries}`);
            continue;
          }
          throw err;
        }
      }
      return [];
    };

    let haltReason: 'quota' | 'auth' | 'aborted' | null = null;

    for (let start = 0; start < targets.length; start += CHUNK_SIZE) {
      if (abortRef.current) {
        haltReason = 'aborted';
        break;
      }

      const end = Math.min(start + CHUNK_SIZE, targets.length);
      const chunkRaw = targets.slice(start, end);
      const chunkInputs = chunkRaw.map(parseTargetInput);

      setCurrentIndex(start);
      setChunkStatus(chunkRaw, 'PROCESSING');

      try {
        const batchResults = await fetchChunkWithRetry(chunkInputs, chunkRaw);
        currentResults.push(...batchResults);
        setResults(prev => {
          if (modeType !== 'reverify_incomplete') {
            return [...prev, ...batchResults];
          }
          const updated = [...prev];
          for (const nextItem of batchResults) {
            const matchIdx = updated.findIndex(existing => {
              if (!existing) return false;
              if (nextItem.domain && existing.domain) {
                return existing.domain.toLowerCase() === nextItem.domain.toLowerCase();
              }
              return existing.companyName.toLowerCase() === nextItem.companyName.toLowerCase();
            });
            if (matchIdx !== -1) {
              updated[matchIdx] = nextItem;
            } else {
              updated.push(nextItem);
            }
          }
          return updated;
        });
        setChunkStatus(chunkRaw, 'COMPLETED');

        if (end < targets.length && !abortRef.current) {
          const paceMs = apiMode === 'free' ? 3000 : 2000;
          await new Promise(resolve => setTimeout(resolve, paceMs));
        }
      } catch (err: any) {
        const remainingTargets = targets.slice(start);
        if (err?.message === 'BATCH_ABORTED' || abortRef.current) {
          haltReason = 'aborted';
          setChunkStatus(remainingTargets, 'FAILED', 'Stopped by user');
          break;
        }

        const msg = typeof err?.message === 'string' && err.message ? err.message : 'Extraction Error';
        const isQuota = err?.status === 429 || msg.includes('429') || msg.includes('RESOURCE_EXHAUSTED');
        const isAuth =
          err?.status === 403 ||
          err?.code === 'MISSING_API_KEY' ||
          msg.includes('API_KEY') ||
          msg.includes('API key');

        if (isQuota) {
          haltReason = 'quota';
          setApiAlert({
            type: 'quota',
            title: 'Gemini API Quota Limit Reached (429)',
            message:
              'All available free & grounded tiers reached your current API key quota limit. Wait briefly before resuming, or select a billing-enabled API key in Settings > Secrets for higher limits.',
          });
          setChunkStatus(chunkRaw, 'FAILED', 'Quota Exceeded');
          setChunkStatus(targets.slice(end), 'FAILED', 'Halted (Quota Limit)');
          break;
        }

        if (isAuth) {
          haltReason = 'auth';
          setApiAlert({
            type: 'auth',
            title: 'API Key Configuration Required',
            message: 'Verify your Gemini API key in Settings > Secrets and try again.',
          });
          setChunkStatus(remainingTargets, 'FAILED', 'API Key Error');
          break;
        }

        setApiAlert({
          type: 'error',
          title: 'Batch Chunk Error',
          message: msg,
        });
        setChunkStatus(chunkRaw, 'FAILED', msg);
      }
    }

    if (haltReason === 'aborted') {
      setStatuses(prev =>
        prev.map(s => (s.status === 'PENDING' || s.status === 'PROCESSING' ? { ...s, status: 'FAILED', error: 'Stopped' } : s))
      );
    }

    if (currentResults.length > 0) {
      try {
        await persistenceService.saveLeadBatch(targets, currentResults);
      } catch {
        // Persistence optional when Supabase is unconfigured
      }
    }

    setLoading(false);
    setCurrentIndex(-1);
  };

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    setHasSubmitted(true);

    if (!isValidEmail(researcherEmail)) {
      setEmailError('VALID_EMAIL_REQUIRED');
      return;
    } else {
      setEmailError('');
    }

    const seen = new Set<string>();
    const targets = bulkInput
      .split('\n')
      .map(t => t.trim())
      .filter(t => {
        if (!t) return false;
        const key = t.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

    if (targets.length === 0) {
      setTargetError('AT_LEAST_ONE_TARGET_REQUIRED');
      return;
    } else {
      setTargetError('');
    }

    await runBatchTargets(targets, 'fresh');
  };

  const handleRetryFailed = async () => {
    const failedTargets = statuses.filter(s => s.status === 'FAILED').map(s => s.name);
    if (failedTargets.length === 0 || loading) return;
    await runBatchTargets(failedTargets, 'retry_failed');
  };

  const incompleteTargetsCount = useMemo(
    () =>
      results.filter(
        r => r && r.companyIntel?.verificationStage !== 'SITE_AND_LINKEDIN_VERIFIED'
      ).length,
    [results]
  );

  const handleReverifyIncomplete = async () => {
    if (loading) return;
    const targetsToReverify: string[] = Array.from(
      new Set<string>(
        results
          .filter(r => r && r.companyIntel?.verificationStage !== 'SITE_AND_LINKEDIN_VERIFIED')
          .map(r => (r.domain || r.companyName || '').trim())
          .filter((val): val is string => Boolean(val))
      )
    );
    if (targetsToReverify.length === 0) return;
    await runBatchTargets(targetsToReverify, 'reverify_incomplete');
  };

  const buildExportRows = (applyFilter: boolean) => {
    interface CompanyExportGroup {
      bestScore: number;
      hasValidEmail: boolean;
      companySortKey: string;
      rows: Array<{
        rowOrderScore: number;
        record: Record<string, string>;
      }>;
    }

    const groups: CompanyExportGroup[] = [];

    for (const res of results) {
      if (!res) continue;
      const cleanedCompanyEmails = normalizeAndSortEmails(res.companyIntel?.emails || []);
      const hasContacts = Boolean(
        res.domain ||
        cleanedCompanyEmails.length > 0 ||
        (res.companyIntel?.phones?.length || 0) > 0
      );
      if (applyFilter) {
        if (statusFilter === 'WITH_LEADS' && (res.leads?.length || 0) === 0) continue;
        if (statusFilter === 'VERIFIED_CONTACTS' && !hasContacts && (res.leads?.length || 0) === 0) continue;
        if (statusFilter === 'UNVERIFIED' && (hasContacts || (res.leads?.length || 0) > 0)) continue;
      }

      const brandName = res.companyIntel?.brandName || '';
      const redirectedSite = res.companyIntel?.redirectedDomain || '';
      const industry = res.companyIntel?.industry || batchIndustry || '';
      const linkedinCompany = res.companyIntel?.linkedinCompanyUrl || '';
      const verificationStage = res.companyIntel?.verificationStage || '';
      const missingRoles = res.companyIntel?.rolesMissing?.join(', ') || '';
      const phones = res.companyIntel?.phones?.join(' | ') || '';
      const location = res.companyIntel?.location || '';
      const socials = res.companyIntel?.socialLinks?.join(' | ') || '';

      const leads = res.leads || [];
      const selectedLeads =
        !applyFilter || roleFilter === 'ALL_PROTOCOLS'
          ? leads
          : leads.filter(l => l && l.role === roleFilter);

      const emittedEmails = new Set<string>();
      const companyRows: Array<{ rowOrderScore: number; record: Record<string, string> }> = [];

      // 1. Named decision-maker rows (each row carries strictly 1 single email)
      for (const lead of selectedLeads) {
        const singleLeadEmail = normalizeAndSortEmails([lead.email_placeholder || ''])[0] || '';
        if (singleLeadEmail) emittedEmails.add(singleLeadEmail.toLowerCase());
        const emailScore = singleLeadEmail ? scoreExportEmail(singleLeadEmail) : -1;

        companyRows.push({
          rowOrderScore: (lead.email_type === 'VERIFIED' ? 1000 : 500) + Math.max(0, emailScore),
          record: {
            'Company': res.companyName || 'N/A',
            'Brand Name': brandName,
            'Domain': res.domain || 'Not Verified',
            'Email': singleLeadEmail || 'N/A',
            'Email Category': singleLeadEmail ? classifyEmailCategory(singleLeadEmail) : 'Unavailable',
            'Email Type': singleLeadEmail ? (lead.email_type || 'VERIFIED') : 'UNAVAILABLE',
            'Lead Name': lead.name || '',
            'Role': lead.role || '',
            'Lead LinkedIn': lead.linkedinUrl || '',
            'Phones': phones,
            'Location': location,
            'Industry': industry,
            'Verification Stage': verificationStage,
            'Missing Roles': missingRoles,
            'Redirected Website': redirectedSite,
            'LinkedIn Company': linkedinCompany,
            'Source': lead.sourceUrl || (res.domain ? `https://${res.domain}` : ''),
            'Social Links': socials,
          },
        });
      }

      // 2. Company-level verified emails: put EACH email on its OWN separate row, ordered by priority
      if (!applyFilter || roleFilter === 'ALL_PROTOCOLS') {
        for (const singleEmail of cleanedCompanyEmails) {
          if (emittedEmails.has(singleEmail.toLowerCase())) continue;
          emittedEmails.add(singleEmail.toLowerCase());
          const emailScore = scoreExportEmail(singleEmail);

          companyRows.push({
            rowOrderScore: 700 + Math.max(0, emailScore),
            record: {
              'Company': res.companyName || 'N/A',
              'Brand Name': brandName,
              'Domain': res.domain || 'Not Verified',
              'Email': singleEmail,
              'Email Category': classifyEmailCategory(singleEmail),
              'Email Type': 'VERIFIED_PUBLIC',
              'Lead Name': '',
              'Role': '',
              'Lead LinkedIn': '',
              'Phones': phones,
              'Location': location,
              'Industry': industry,
              'Verification Stage': verificationStage,
              'Missing Roles': missingRoles,
              'Redirected Website': redirectedSite,
              'LinkedIn Company': linkedinCompany,
              'Source': res.domain ? `https://${res.domain}` : '',
              'Social Links': socials,
            },
          });
        }
      }

      // 3. Fallback single tracking row only if no leads and no public emails exist
      if (companyRows.length === 0) {
        if (applyFilter && roleFilter !== 'ALL_PROTOCOLS') continue;
        companyRows.push({
          rowOrderScore: -1,
          record: {
            'Company': res.companyName || 'N/A',
            'Brand Name': brandName,
            'Domain': res.domain || 'Not Verified',
            'Email': 'N/A',
            'Email Category': 'None',
            'Email Type': 'UNAVAILABLE',
            'Lead Name': '',
            'Role': '',
            'Lead LinkedIn': '',
            'Phones': phones,
            'Location': location,
            'Industry': industry,
            'Verification Stage': verificationStage,
            'Missing Roles': missingRoles,
            'Redirected Website': redirectedSite,
            'LinkedIn Company': linkedinCompany,
            'Source': res.domain ? `https://${res.domain}` : '',
            'Social Links': socials,
          },
        });
      }

      companyRows.sort((a, b) => b.rowOrderScore - a.rowOrderScore);
      const bestRowScore = companyRows[0]?.rowOrderScore ?? -1;
      const hasValidEmail = companyRows.some(r => r.record['Email'] && r.record['Email'] !== 'N/A');

      groups.push({
        bestScore: bestRowScore,
        hasValidEmail,
        companySortKey: (res.companyName || res.domain || '').toLowerCase(),
        rows: companyRows,
      });
    }

    // Order companies cleanly: companies with verified emails first (highest priority first), N/A companies at the bottom
    groups.sort((a, b) => {
      if (a.hasValidEmail !== b.hasValidEmail) return a.hasValidEmail ? -1 : 1;
      if (b.bestScore !== a.bestScore) return b.bestScore - a.bestScore;
      return a.companySortKey.localeCompare(b.companySortKey);
    });

    return groups.flatMap(g => g.rows.map(r => r.record));
  };

  const EXPORT_HEADERS = [
    'Company',
    'Brand Name',
    'Domain',
    'Email',
    'Email Category',
    'Email Type',
    'Lead Name',
    'Role',
    'Lead LinkedIn',
    'Phones',
    'Location',
    'Industry',
    'Verification Stage',
    'Missing Roles',
    'Redirected Website',
    'LinkedIn Company',
    'Source',
    'Social Links',
  ] as const;

  const downloadExcel = () => {
    if (results.length === 0) return;
    const filteredData = buildExportRows(true);
    if (filteredData.length === 0) return;

    const worksheet = XLSX.utils.json_to_sheet(filteredData, {
      header: [...EXPORT_HEADERS],
    });

    // Auto-size columns so email addresses, names, and domains are cleanly readable in Excel
    worksheet['!cols'] = EXPORT_HEADERS.map((header) => {
      const maxLen = filteredData.reduce((max, row) => {
        const val = row[header] ? String(row[header]) : '';
        return Math.max(max, Math.min(val.length, 48));
      }, header.length);
      return { wch: Math.max(maxLen + 3, 14) };
    });

    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "Leads");
    const suffix = roleFilter === 'ALL_PROTOCOLS' ? 'Full' : roleFilter.replace(/\s+/g, '_');
    XLSX.writeFile(workbook, `LeadGen_Pro_${suffix}_${new Date().toISOString().split('T')[0]}.xlsx`);
  };

  const downloadAggregateCSV = () => {
    if (results.length === 0) return;
    const allRows = buildExportRows(false);
    if (allRows.length === 0) return;

    const escapeCSV = (val: unknown) => {
      if (val === null || val === undefined) return '';
      let str = String(val);
      str = str.replace(/"/g, '""');
      if (/[",\n\r]/.test(str)) {
        str = `"${str}"`;
      }
      return str;
    };

    const csvRows = [
      EXPORT_HEADERS.join(','),
      ...allRows.map(item => EXPORT_HEADERS.map(h => escapeCSV(item[h])).join(','))
    ];

    // Prepend UTF-8 BOM so Microsoft Excel preserves international characters cleanly
    const csvContent = '\uFEFF' + csvRows.join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', `LeadGen_Aggregate_${new Date().toISOString().split('T')[0]}.csv`);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const downloadAggregateJSON = () => {
    if (results.length === 0) return;

    const payload = {
      timestamp: new Date().toISOString(),
      total_processed: results.length,
      total_leads: results.reduce((acc, r) => acc + (r && r.leads ? r.leads.length : 0), 0),
      data: results
    };

    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', `LeadGen_Aggregate_${new Date().toISOString().split('T')[0]}.json`);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const totalTargets = bulkInput.split('\n').filter(t => t.trim()).length;

  return (
    <div className="grid grid-cols-12 gap-6 items-start h-full">
      {/* Left Search Sidebar */}
      <aside className="col-span-12 lg:col-span-3 space-y-6 lg:h-[calc(100vh-180px)] lg:sticky lg:top-24">
        <div className="glass-panel p-5">
           <h3 className="text-xs font-bold text-white mb-4 uppercase tracking-[0.2em]">Bulk Discovery</h3>
           <form onSubmit={handleSearch} className="space-y-4">
              <div>
                <label className="text-[10px] text-slate-500 uppercase block mb-1.5 font-mono">Researcher Identity (Email)</label>
                <div className="relative group">
                  <input 
                    type="text"
                    value={researcherEmail}
                    onChange={e => {
                      setResearcherEmail(e.target.value);
                      if (hasSubmitted) {
                        if (isValidEmail(e.target.value)) setEmailError('');
                        else setEmailError('VALID_EMAIL_REQUIRED');
                      }
                    }}
                    placeholder="identity@protocol.io"
                    className={cn(
                      "w-full input-dark pl-9 transition-all",
                      emailError && "border-rose-500/50 bg-rose-500/5 focus:border-rose-500"
                    )}
                  />
                  <Mail className={cn(
                    "absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 transition-colors",
                    emailError ? "text-rose-500" : "text-slate-600 group-hover:text-slate-400"
                  )} />
                </div>
                <AnimatePresence>
                  {emailError && (
                    <motion.p 
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: 'auto' }}
                      exit={{ opacity: 0, height: 0 }}
                      className="text-[9px] text-rose-500 mt-1.5 font-mono uppercase tracking-tighter"
                    >
                      {emailError}
                    </motion.p>
                  )}
                </AnimatePresence>
              </div>

              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="text-[10px] text-slate-500 uppercase font-mono">Targets (One per line)</label>
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={loading}
                    className="text-[9px] font-mono uppercase tracking-wider text-cyan-400 hover:text-cyan-300 flex items-center gap-1 disabled:opacity-40"
                    title="Import .txt, .csv, or .xlsx target list"
                  >
                    <Upload className="w-2.5 h-2.5" />
                    Import List
                  </button>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".txt,.csv,.xlsx,.xls"
                    onChange={handleTargetFileUpload}
                    className="hidden"
                  />
                </div>
                <textarea 
                  rows={5}
                  value={bulkInput}
                  onChange={e => {
                    setBulkInput(e.target.value);
                    if (hasSubmitted && e.target.value.trim()) setTargetError('');
                  }}
                  placeholder={"google.com\nMicrosoft\napple.io"}
                  className={cn(
                    "w-full input-dark resize-none custom-scrollbar",
                    targetError && "border-rose-500/50 bg-rose-500/5 focus:border-rose-500"
                  )}
                />
                <AnimatePresence>
                  {targetError && (
                    <motion.p 
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: 'auto' }}
                      exit={{ opacity: 0, height: 0 }}
                      className="text-[9px] text-rose-500 mt-1 font-mono uppercase tracking-tighter"
                    >
                      {targetError}
                    </motion.p>
                  )}
                </AnimatePresence>
              </div>

              {/* Exhibitor Extractor toggle */}
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <button
                    type="button"
                    onClick={() => setShowExhibitorExtractor(!showExhibitorExtractor)}
                    disabled={loading}
                    className={cn(
                      "text-[9px] font-mono uppercase tracking-wider flex items-center gap-1 disabled:opacity-40",
                      showExhibitorExtractor ? "text-emerald-400" : "text-cyan-400 hover:text-cyan-300"
                    )}
                    title="Exhibitor List Importer"
                  >
                    <Download className="w-2.5 h-2.5" />
                    {showExhibitorExtractor ? 'HIDE_EXHIBITOR_EXTRACTOR' : 'EXHIBITOR_EXTRACTOR'}
                  </button>
                </div>
              </div>

              {showExhibitorExtractor && (
                <div className="glass-panel p-3 border-emerald-500/20 bg-emerald-500/5 mt-2 space-y-3">
                  <div>
                    <label className="text-[9px] text-emerald-400/70 uppercase block mb-1 font-mono">1. Bookmarklet (One-Click Extract)</label>
                    <div className="flex gap-2">
                      <input
                        type="text"
                        readOnly
                        value={EXHIBITOR_BOOKMARKLET}
                        className="flex-1 input-dark text-[8px] font-mono text-emerald-300"
                        onClick={(e) => e.target.select()}
                      />
                      <button
                        type="button"
                        onClick={() => copyToClipboard(EXHIBITOR_BOOKMARKLET, 'BOOKMARKLET_COPIED')}
                        disabled={loading}
                        className="text-[9px] font-mono uppercase text-emerald-400 hover:text-emerald-300 disabled:opacity-40 px-2"
                      >
                        COPY
                      </button>
                    </div>
                    <p className="text-[8px] text-slate-500 mt-1 font-mono uppercase tracking-tighter">
                      Drag to bookmarks bar → click on exhibition site → extracts "Name | domain.com" to clipboard
                    </p>
                  </div>

                  <div>
                    <label className="text-[9px] text-emerald-400/70 uppercase block mb-1 font-mono">2. Paste Raw Text or Upload List</label>
                    <textarea
                      rows={3}
                      value={exhibitorRawText}
                      onChange={e => setExhibitorRawText(e.target.value)}
                      placeholder="Paste exhibitor list here…\nAcme Corp | acme.com\nMicrosoft | microsoft.com\nShopify"
                      className="w-full input-dark text-[9px] resize-none custom-scrollbar"
                    />
                    <div className="flex gap-2 mt-2">
                      <button
                        type="button"
                        onClick={handleExhibitorPaste}
                        disabled={loading}
                        className="flex-1 py-1.5 bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-[9px] font-bold uppercase rounded hover:bg-emerald-500/20 disabled:opacity-40 transition-all"
                      >
                        PARSE_PASTED_TEXT
                      </button>
                      <button
                        type="button"
                        onClick={() => exhibitorFileRef.current?.click()}
                        disabled={loading}
                        className="text-[9px] font-mono uppercase tracking-wider text-cyan-400 hover:text-cyan-300 flex items-center gap-1 disabled:opacity-40 px-2"
                        title="Import .txt or .csv exhibitor list"
                      >
                        <Upload className="w-2.5 h-2.5" />
                        Upload List
                      </button>
                      <input
                        ref={exhibitorFileRef}
                        type="file"
                        accept=".txt,.csv"
                        onChange={handleExhibitorFileUpload}
                        className="hidden"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="text-[9px] text-emerald-400/70 uppercase block mb-1 font-mono">3. Parsed Pairs (Name | domain.com)</label>
                    <div className="max-h-24 overflow-y-auto custom-scrollbar space-y-1 mb-2">
                      {exhibitorParsed.map((p, i) => (
                        <div key={i} className="text-[9px] font-mono text-slate-300 flex justify-between">
                          <span className="text-cyan-300">{p.company}</span>
                          <span>{p.domain ? ` | ${p.domain}` : '<no domain>'}</span>
                        </div>
                      ))}
                      {exhibitorParsed.length === 0 && (
                        <p className="text-[9px] text-slate-500 font-mono italic">No pairs parsed yet.</p>
                      )}
                    </div>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={addParsedToBatch}
                        disabled={loading || exhibitorParsed.length === 0}
                        className="flex-1 py-2 bg-emerald-500/20 border border-emerald-500/30 text-emerald-400 text-[9px] font-bold uppercase rounded hover:bg-emerald-500/30 disabled:opacity-40 transition-all"
                      >
                        ADD_TO_BATCH ({exhibitorParsed.length})
                      </button>
                      <button
                        type="button"
                        onClick={() => { setExhibitorParsed([]); setExhibitorRawText(''); setExhibitorError(''); }}
                        className="text-[9px] text-rose-500 hover:text-rose-400 font-mono uppercase px-2"
                      >
                        CLEAR
                      </button>
                    </div>
                  </div>
                  {exhibitorError && (
                    <motion.p
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: 'auto' }}
                      exit={{ opacity: 0, height: 0 }}
                      className="text-[9px] text-rose-500 mt-1 font-mono uppercase tracking-tighter"
                    >
                      {exhibitorError}
                    </motion.p>
                  )}
                </div>
              )}
              <div>
                <input 
                  value={roles}
                  onChange={e => setRoles(e.target.value)}
                  className="w-full input-dark"
                />
              </div>
              <div>
                <label className="text-[10px] text-slate-500 uppercase block mb-1.5 font-mono">API Execution Mode</label>
                <select
                  value={apiMode}
                  disabled={loading}
                  onChange={e => setApiMode(e.target.value as ApiTierMode)}
                  className="w-full input-dark text-xs font-mono text-cyan-300 disabled:opacity-50"
                >
                  <option value="auto">AUTO (Free + Paid Seamless)</option>
                  <option value="free">FREE_SAFE (High-Quota Lite)</option>
                  <option value="paid">PAID_GROUNDED (Live Web Search)</option>
                </select>
              </div>
              <button 
                type="submit"
                disabled={loading}
                className="w-full h-11 mt-4 bg-gradient-to-r from-cyan-600/80 to-blue-600/80 hover:from-cyan-500 hover:to-blue-500 text-white rounded-lg flex items-center justify-center gap-2 text-xs font-bold uppercase tracking-[0.1em] shadow-[0_4px_20px_rgba(34,211,238,0.2)] disabled:opacity-50 transition-all font-mono"
              >
                {loading ? (
                  <span className="flex flex-col items-center">
                    <Activity className="w-4 h-4 animate-spin mb-1" />
                    <span className="text-[8px] animate-pulse">
                      PROCESSING_{Math.min(currentIndex + 1, statuses.length || totalTargets)}_OF_{statuses.length || totalTargets}
                    </span>
                  </span>
                ) : (
                  <>INITIATE_BULK_EXFILTRATION</>
                )}
              </button>
              {loading && (
                <button
                  type="button"
                  onClick={handleStopBatch}
                  className="w-full h-9 bg-rose-500/10 hover:bg-rose-500/20 border border-rose-500/30 text-rose-400 rounded-lg flex items-center justify-center gap-2 text-[10px] font-bold uppercase tracking-widest transition-all font-mono"
                >
                  <Square className="w-3 h-3 fill-current" />
                  STOP_BATCH
                </button>
              )}
           </form>
        </div>

        {results.length > 0 && (
          <div className="glass-panel p-5 border-cyan-500/20 bg-cyan-500/5">
             <h3 className="text-xs font-bold text-white mb-4 uppercase tracking-[0.2em] flex items-center gap-2">
               <ShieldCheck className="w-3 h-3 text-emerald-400" />
               Consolidated Data
             </h3>
             <div className="space-y-1 mb-4">
                <p className="text-[10px] font-mono text-slate-400">
                  Visible: <span className="text-cyan-400">
                    {results.reduce((acc, r) => acc + (r && r.leads ? (roleFilter === 'ALL_PROTOCOLS' ? r.leads.length : r.leads.filter(l => l && l.role === roleFilter).length) : 0), 0)}
                  </span> identities
                </p>
                <p className="text-[10px] font-mono text-slate-600">
                  Total: {results.reduce((acc, r) => acc + (r && r.leads ? r.leads.length : 0), 0)} identities
                </p>
             </div>
             <button 
               onClick={downloadExcel}
               className="w-full py-3 bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 font-bold uppercase tracking-widest text-[10px] flex items-center justify-center gap-2 hover:bg-emerald-500/20 transition-all rounded-lg"
             >
               <Upload className="w-3 h-3 rotate-180" />
               DOWNLOAD_EXCEL_SHEET
             </button>
          </div>
        )}

        <div className="glass-panel p-5">
          <div className="mb-4 flex items-start justify-between gap-2">
            <div className="min-w-0">
              <h3 className="text-xs font-bold text-white uppercase tracking-[0.2em] flex items-center gap-2">
                <Activity className="w-3 h-3 text-cyan-400" />
                Batch Progress
              </h3>
              {analyzingIndustry && (
                <p className="text-[9px] font-mono text-amber-300/90 mt-1 animate-pulse">
                  Detecting bulk industry context...
                </p>
              )}
              {!analyzingIndustry && batchIndustry && (
                <p className="text-[9px] font-mono text-emerald-400/90 mt-1 truncate" title={batchIndustry}>
                  Industry: {batchIndustry}
                </p>
              )}
              {activeTierInfo && (
                <p className="text-[9px] font-mono text-cyan-400/80 mt-0.5 truncate">
                  {activeTierInfo}
                </p>
              )}
            </div>
            {!loading && (statuses.some(s => s.status === 'FAILED') || incompleteTargetsCount > 0) && (
              <div className="flex flex-col gap-1.5 shrink-0 items-end">
                {statuses.some(s => s.status === 'FAILED') && (
                  <button
                    type="button"
                    onClick={handleRetryFailed}
                    className="px-2 py-1 rounded bg-amber-500/10 border border-amber-500/30 text-[9px] font-mono uppercase text-amber-300 hover:bg-amber-500/20 flex items-center gap-1 transition-colors"
                  >
                    <RotateCcw className="w-2.5 h-2.5" />
                    Retry
                  </button>
                )}
                {incompleteTargetsCount > 0 && (
                  <button
                    type="button"
                    onClick={handleReverifyIncomplete}
                    className="px-2 py-1 rounded bg-cyan-500/10 border border-cyan-500/30 text-[9px] font-mono uppercase text-cyan-300 hover:bg-cyan-500/20 flex items-center gap-1 transition-colors"
                    title="Re-run LinkedIn & Industry Verification for companies with missing roles"
                  >
                    <RotateCcw className="w-2.5 h-2.5" />
                    Re-Verify ({incompleteTargetsCount})
                  </button>
                )}
              </div>
            )}
          </div>
          <div className="space-y-2 max-h-[300px] overflow-y-auto custom-scrollbar pr-2">
            {statuses.length > 0 ? statuses.map((s, idx) => (
              <div key={idx} className="flex flex-col gap-1 p-2 rounded bg-white/5 border border-white/5">
                <div className="flex items-center justify-between gap-3 text-[10px] font-mono">
                  <span className={cn(
                    "truncate max-w-[120px]",
                    s.status === 'PROCESSING' ? "text-cyan-400" : 
                    s.status === 'COMPLETED' ? "text-emerald-400" :
                    s.status === 'FAILED' ? "text-rose-400" : "text-slate-500"
                  )}>
                    {s.name}
                  </span>
                  <span className={cn(
                    "uppercase tracking-tighter text-[8px] font-bold px-1.5 py-0.5 rounded border leading-none",
                    s.status === 'PENDING' && "text-slate-500 border-slate-500/20",
                    s.status === 'PROCESSING' && "text-cyan-400 border-cyan-400/20 bg-cyan-400/10 animate-pulse",
                    s.status === 'COMPLETED' && "text-emerald-400 border-emerald-400/20 bg-emerald-400/10",
                    s.status === 'FAILED' && "text-rose-400 border-rose-400/20 bg-rose-400/10"
                  )}>
                    {s.status}
                  </span>
                </div>
                {s.error && (
                  <span className="text-[7px] font-mono text-slate-500 uppercase italic tracking-widest">{s.error}</span>
                )}
              </div>
            )) : (
              <p className="text-[10px] italic text-slate-600">No active batch sequence...</p>
            )}
          </div>
        </div>
      </aside>

      {/* Main Results Area */}
      <main className="col-span-12 lg:col-span-9 space-y-8">
        <AnimatePresence>
          {apiAlert && (
            <motion.div
              initial={{ opacity: 0, y: -10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              className={cn(
                "glass-panel p-4 border flex items-start justify-between gap-4",
                apiAlert.type === 'quota'
                  ? "border-amber-500/30 bg-amber-500/10"
                  : "border-rose-500/30 bg-rose-500/10"
              )}
            >
              <div className="flex items-start gap-3">
                <AlertTriangle
                  className={cn(
                    "w-5 h-5 shrink-0 mt-0.5",
                    apiAlert.type === 'quota' ? "text-amber-400" : "text-rose-400"
                  )}
                />
                <div className="space-y-1">
                  <h4 className="text-xs font-bold text-white uppercase tracking-wider font-mono">
                    {apiAlert.title}
                  </h4>
                  <p className="text-xs text-slate-300 leading-relaxed">{apiAlert.message}</p>
                  {apiAlert.type === 'quota' && (
                    <a
                      href="https://ai.dev/rate-limit"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-block text-[10px] font-mono text-amber-300 underline hover:text-amber-200 mt-1"
                    >
                      Monitor API Usage &amp; Rate Limits
                    </a>
                  )}
                </div>
              </div>
              <button
                type="button"
                onClick={() => setApiAlert(null)}
                className="text-slate-400 hover:text-white transition-colors p-1"
                aria-label="Dismiss alert"
              >
                <X className="w-4 h-4" />
              </button>
            </motion.div>
          )}
        </AnimatePresence>

        {results.length > 0 && (
          <div className="space-y-3">
            {batchIndustry && (
              <div className="glass-panel px-4 py-2.5 border-emerald-500/20 bg-emerald-500/5 flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2 text-xs font-mono text-emerald-300">
                  <Briefcase className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                  <span className="text-slate-400 uppercase text-[10px]">Detected Bulk Industry:</span>
                  <span className="font-semibold text-white">{batchIndustry}</span>
                </div>
                {!loading && incompleteTargetsCount > 0 && (
                  <button
                    type="button"
                    onClick={handleReverifyIncomplete}
                    className="px-3 py-1 rounded-lg bg-cyan-500/10 border border-cyan-500/30 text-[10px] font-mono uppercase tracking-wider text-cyan-300 hover:bg-cyan-500/20 flex items-center gap-1.5 transition-colors"
                  >
                    <RotateCcw className="w-3 h-3" />
                    Re-Verify Incomplete ({incompleteTargetsCount})
                  </button>
                )}
              </div>
            )}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div className="glass-panel px-4 py-3 border-white/5">
                <p className="text-[9px] font-mono uppercase tracking-widest text-slate-500">Processed</p>
                <p className="text-lg font-mono text-white mt-0.5">{results.length}</p>
              </div>
              <div className="glass-panel px-4 py-3 border-cyan-500/15">
                <p className="text-[9px] font-mono uppercase tracking-widest text-slate-500">Verified Domains</p>
                <p className="text-lg font-mono text-cyan-400 mt-0.5">
                  {results.filter(r => Boolean(r?.domain)).length}
                </p>
              </div>
              <div className="glass-panel px-4 py-3 border-emerald-500/15">
                <p className="text-[9px] font-mono uppercase tracking-widest text-slate-500">Named Leads</p>
                <p className="text-lg font-mono text-emerald-400 mt-0.5">
                  {results.reduce((acc, r) => acc + (r?.leads?.length || 0), 0)}
                </p>
              </div>
              <div className="glass-panel px-4 py-3 border-white/5">
                <p className="text-[9px] font-mono uppercase tracking-widest text-slate-500">Public Contacts</p>
                <p className="text-lg font-mono text-slate-200 mt-0.5">
                  {results.filter(r => (r?.companyIntel?.emails?.length || 0) > 0 || (r?.companyIntel?.phones?.length || 0) > 0).length}
                </p>
              </div>
            </div>

            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 glass-panel p-4 border-cyan-500/10">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-cyan-500/10 rounded-lg">
                  <Search className="w-4 h-4 text-cyan-400" />
                </div>
                <div>
                  <h3 className="text-xs font-bold text-white uppercase tracking-widest">Active View Filter</h3>
                  <p className="text-[10px] font-mono text-slate-500">Live identity &amp; verification refinement</p>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-3">
                <div className="flex items-center gap-2">
                  <label className="text-[10px] font-mono text-slate-500 uppercase">Status:</label>
                  <select
                    value={statusFilter}
                    onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)}
                    className="bg-black/40 border border-white/10 rounded-lg px-3 py-2 text-[10px] font-mono text-cyan-400 uppercase tracking-widest focus:outline-none focus:border-cyan-500/50 transition-all outline-none"
                  >
                    <option value="ALL">ALL_TARGETS</option>
                    <option value="WITH_LEADS">WITH_NAMED_LEADS</option>
                    <option value="VERIFIED_CONTACTS">VERIFIED_DOMAIN_OR_CONTACTS</option>
                    <option value="UNVERIFIED">UNVERIFIED_ONLY</option>
                  </select>
                </div>

                <div className="flex items-center gap-2">
                  <label className="text-[10px] font-mono text-slate-500 uppercase">Protocol:</label>
                  <select 
                    value={roleFilter}
                    onChange={(e) => setRoleFilter(e.target.value)}
                    className="bg-black/40 border border-white/10 rounded-lg px-4 py-2 text-[10px] font-mono text-cyan-400 uppercase tracking-widest focus:outline-none focus:border-cyan-500/50 transition-all custom-scrollbar outline-none"
                  >
                    <option value="ALL_PROTOCOLS">ALL_PROTOCOLS</option>
                    {availableRoles.map(role => (
                      <option key={role} value={role}>{role}</option>
                    ))}
                  </select>
                </div>
              </div>
            </div>
          </div>
        )}

        <AnimatePresence mode="popLayout">
          {results.length > 0 ? (
            results.map((result, resIdx) => {
              if (!result || !result.leads) return null;

              const hasContacts = Boolean(
                result.domain ||
                (result.companyIntel?.emails?.length || 0) > 0 ||
                (result.companyIntel?.phones?.length || 0) > 0
              );
              if (statusFilter === 'WITH_LEADS' && result.leads.length === 0) return null;
              if (statusFilter === 'VERIFIED_CONTACTS' && !hasContacts && result.leads.length === 0) return null;
              if (statusFilter === 'UNVERIFIED' && (hasContacts || result.leads.length > 0)) return null;
              
              const filteredLeads = roleFilter === 'ALL_PROTOCOLS' 
                ? result.leads 
                : result.leads.filter(l => l && l.role === roleFilter);

              if (roleFilter !== 'ALL_PROTOCOLS' && filteredLeads.length === 0) return null;

              return (
                <motion.div 
                  key={result.companyName + resIdx}
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="glass-panel p-6"
                >
                  <div className="flex justify-between items-start mb-4 pb-4 border-b border-white/5 gap-4">
                    <div>
                      <h2 className="text-xl font-light text-white tracking-tight flex items-center gap-3 flex-wrap">
                        {result.companyName}
                        {result.companyIntel?.brandName &&
                          result.companyIntel.brandName.toLowerCase() !== result.companyName.toLowerCase() && (
                            <span className="text-xs font-mono text-slate-400 font-normal">
                              ({result.companyIntel.brandName})
                            </span>
                          )}
                        <span className="text-[8px] font-mono bg-cyan-400/10 text-cyan-400 px-2 py-0.5 rounded border border-cyan-400/20 uppercase tracking-widest leading-none">
                          TARGET_{resIdx + 1}
                        </span>
                        {result.companyIntel?.verificationStage === 'SITE_AND_LINKEDIN_VERIFIED' && (
                          <span className="text-[8px] font-mono bg-emerald-500/10 text-emerald-300 px-2 py-0.5 rounded border border-emerald-500/25 uppercase tracking-widest leading-none inline-flex items-center gap-1">
                            <CheckCircle2 className="w-2.5 h-2.5" />
                            Verified
                          </span>
                        )}
                        {result.companyIntel?.verificationStage === 'SITE_VERIFIED_ROLES_MISSING' && (
                          <span className="text-[8px] font-mono bg-amber-500/10 text-amber-300 px-2 py-0.5 rounded border border-amber-500/25 uppercase tracking-widest leading-none">
                            Site Verified · Roles Pending
                          </span>
                        )}
                        {result.companyIntel?.secondPassExecuted && (
                          <span className="text-[8px] font-mono bg-sky-500/10 text-sky-300 px-2 py-0.5 rounded border border-sky-500/25 uppercase tracking-widest leading-none">
                            2nd Pass Checked
                          </span>
                        )}
                      </h2>
                      <div className="text-[10px] text-slate-500 mt-1.5 uppercase tracking-widest font-bold flex items-center gap-3 flex-wrap">
                        <span className="inline-flex items-center gap-1.5">
                          Domain:{' '}
                          {result.domain ? (
                            <a
                              href={`https://${result.domain.replace(/^https?:\/\//i, '')}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-cyan-400 hover:underline lowercase font-mono inline-flex items-center gap-1"
                            >
                              {result.domain}
                              <ExternalLink className="w-2.5 h-2.5" />
                            </a>
                          ) : (
                            <span className="text-slate-500 italic">Not Verified</span>
                          )}
                        </span>
                        {result.companyIntel?.redirectedDomain &&
                          result.companyIntel.redirectedDomain.toLowerCase() !== result.domain.toLowerCase() && (
                            <a
                              href={`https://${result.companyIntel.redirectedDomain.replace(/^https?:\/\//i, '')}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-[9px] font-mono lowercase px-2 py-0.5 rounded bg-amber-500/10 border border-amber-500/25 text-amber-300 hover:bg-amber-500/20 inline-flex items-center gap-1"
                            >
                              Redirects → {result.companyIntel.redirectedDomain}
                              <ExternalLink className="w-2.5 h-2.5" />
                            </a>
                          )}
                        {result.companyIntel?.industry && (
                          <span className="text-[9px] font-mono normal-case px-2 py-0.5 rounded bg-white/5 border border-white/10 text-slate-300 inline-flex items-center gap-1">
                            <Briefcase className="w-2.5 h-2.5 text-cyan-400" />
                            {result.companyIntel.industry}
                          </span>
                        )}
                      </div>
                      {result.companyIntel?.rolesMissing && result.companyIntel.rolesMissing.length > 0 && (
                        <p className="text-[10px] font-mono text-amber-300/80 mt-1.5">
                          Missing target roles: {result.companyIntel.rolesMissing.join(', ')}
                        </p>
                      )}
                      {result.statusDetail && filteredLeads.length > 0 && (
                        <p className="text-[10px] font-mono text-slate-400 mt-1">{result.statusDetail}</p>
                      )}
                    </div>
                    <div className="text-right shrink-0">
                       <span className="text-[9px] font-mono text-cyan-500/60 uppercase">Found: {filteredLeads.length}</span>
                    </div>
                  </div>

                  {/* Verified Company Intelligence Bar */}
                  {result.companyIntel && (
                    result.companyIntel.emails.length > 0 ||
                    result.companyIntel.phones.length > 0 ||
                    result.companyIntel.location ||
                    result.companyIntel.linkedinCompanyUrl ||
                    result.companyIntel.socialLinks.length > 0
                  ) && (
                    <div className="mb-5 p-3.5 rounded-xl bg-black/30 border border-white/5 flex flex-wrap gap-x-6 gap-y-2 text-[11px] font-mono">
                      {result.companyIntel.emails.length > 0 && (
                        <div className="flex items-center gap-2 text-emerald-300">
                          <Mail className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                          <span>{result.companyIntel.emails.join(' · ')}</span>
                        </div>
                      )}
                      {result.companyIntel.phones.length > 0 && (
                        <div className="flex items-center gap-2 text-slate-300">
                          <Phone className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
                          <span>{result.companyIntel.phones.join(' · ')}</span>
                        </div>
                      )}
                      {result.companyIntel.location && (
                        <div className="flex items-center gap-2 text-slate-400">
                          <MapPin className="w-3.5 h-3.5 text-cyan-500/70 shrink-0" />
                          <span>{result.companyIntel.location}</span>
                        </div>
                      )}
                      {(result.companyIntel.linkedinCompanyUrl || result.companyIntel.socialLinks.length > 0) && (
                        <div className="flex items-center gap-2 flex-wrap">
                          {result.companyIntel.linkedinCompanyUrl && sanitizeExternalUrl(result.companyIntel.linkedinCompanyUrl) && (
                            <a
                              href={sanitizeExternalUrl(result.companyIntel.linkedinCompanyUrl)!}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="px-2 py-0.5 rounded bg-sky-500/10 border border-sky-500/30 text-[10px] text-sky-300 hover:bg-sky-500/20 transition-colors inline-flex items-center gap-1"
                            >
                              LinkedIn Company
                              <ExternalLink className="w-2.5 h-2.5" />
                            </a>
                          )}
                          {result.companyIntel.socialLinks.slice(0, 3).map((sUrl, sIdx) => {
                            const safeSocial = sanitizeExternalUrl(sUrl);
                            if (!safeSocial || safeSocial === result.companyIntel?.linkedinCompanyUrl) return null;
                            const label = safeSocial.includes('linkedin')
                              ? 'LinkedIn'
                              : safeSocial.includes('facebook')
                                ? 'Facebook'
                                : safeSocial.includes('instagram')
                                  ? 'Instagram'
                                  : 'Social';
                            return (
                              <a
                                key={sIdx}
                                href={safeSocial}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="px-2 py-0.5 rounded bg-white/5 border border-white/10 text-[10px] text-cyan-300 hover:border-cyan-500/40 transition-colors"
                              >
                                {label}
                              </a>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  )}

                  <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                    {filteredLeads.map((lead, i) => (
                      <LeadCard key={i} lead={lead} />
                    ))}
                    {filteredLeads.length === 0 && (
                      <div className="col-span-full py-6 px-4 text-center text-slate-400 font-mono text-[11px] bg-white/[0.02] rounded-xl border border-white/5">
                        {result.statusDetail || "No verified decision-maker profiles found for selected protocols."}
                      </div>
                    )}
                  </div>

                  {result.companyIntel?.groundingSources && result.companyIntel.groundingSources.length > 0 && (
                    <div className="mt-5 pt-3 border-t border-white/5 flex flex-wrap items-center gap-2">
                      <span className="text-[9px] font-mono uppercase tracking-widest text-slate-500">Web Sources:</span>
                      {result.companyIntel.groundingSources.slice(0, 4).map((src, idx) => (
                        <a
                          key={idx}
                          href={src.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-[10px] font-mono text-cyan-400/80 hover:text-cyan-300 underline truncate max-w-[220px]"
                          title={src.title}
                        >
                          {src.title}
                        </a>
                      ))}
                    </div>
                  )}
                </motion.div>
              );
            })
          ) : !loading && (
            <div className="glass-panel p-12 min-h-[400px] flex flex-col items-center justify-center opacity-20">
              <Globe className="w-16 h-16 mb-4 animate-[pulse_4s_infinite]" />
              <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-center max-w-xs">System_Awaiting_Bulk_Query_Initialization_Sequence</p>
            </div>
          )}
          
          {loading && (
             <motion.div 
               initial={{ opacity: 0 }}
               animate={{ opacity: 1 }}
               className="glass-panel p-6 border-dashed border-cyan-500/30 animate-pulse flex items-center justify-center py-20"
             >
                <div className="text-center space-y-4">
                   <Activity className="w-8 h-8 text-cyan-400 mx-auto animate-spin" />
                   <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-cyan-400">Exfiltrating Data for Target {currentIndex + 1}...</p>
                </div>
             </motion.div>
          )}
        </AnimatePresence>

        {/* Console-style summary at top of results if multiple */}
        {results.length > 0 && (
          <div className="bg-black/60 border border-white/10 rounded-2xl overflow-hidden mt-8">
            <div className="flex items-center px-4 py-2 border-b border-white/10 justify-between bg-white/[0.02]">
              <span className="text-[10px] font-mono text-emerald-400 uppercase tracking-widest flex items-center gap-2">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse"></span>
                Aggregate Data stream
              </span>
              <div className="flex items-center gap-2">
                <button
                  onClick={downloadAggregateCSV}
                  className="flex items-center gap-1.5 px-3 py-1 rounded bg-emerald-500/10 border border-emerald-500/20 text-[9px] font-mono font-bold uppercase tracking-wider text-emerald-400 hover:bg-emerald-500/20 hover:border-emerald-500/40 transition-all cursor-pointer"
                  title="Download as structured CSV"
                >
                  <FileSpreadsheet className="w-3 h-3" />
                  Save CSV
                </button>
                <button
                  onClick={downloadAggregateJSON}
                  className="flex items-center gap-1.5 px-3 py-1 rounded bg-cyan-500/10 border border-cyan-500/20 text-[9px] font-mono font-bold uppercase tracking-wider text-cyan-400 hover:bg-cyan-500/20 hover:border-cyan-500/40 transition-all cursor-pointer"
                  title="Download raw JSON"
                >
                  <Download className="w-3 h-3" />
                  Save JSON
                </button>
              </div>
            </div>
            <div className="p-4">
              <pre className="terminal-text whitespace-pre-wrap max-h-48 overflow-y-auto custom-scrollbar">
                {JSON.stringify({
                  timestamp: new Date().toISOString(),
                  total_processed: results.length,
                  total_leads: results.reduce((acc, r) => acc + (r && r.leads ? r.leads.length : 0), 0),
                  data: results
                }, null, 2)}
              </pre>
            </div>
          </div>
        )}
      </main>
    </div>
  );
};


const HistoryView = () => {
  const [leadhistory, setLeadHistory] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [authError, setAuthError] = useState(false);

  useEffect(() => {
    const fetchHistory = async () => {
      try {
        const leads = await persistenceService.getRecentLeads();
        setLeadHistory(leads || []);
        
        if (supabase) {
          await supabase.auth.getUser();
        }
      } catch (err: any) {
        console.error("History fetch error:", err);
        setLeadHistory([]);
      } finally {
        setLoading(false);
      }
    };
    fetchHistory();
  }, []);

  if (authError) {
    return (
      <div className="flex flex-col items-center justify-center py-20 glass-panel border-rose-500/20 bg-rose-500/5">
        <ShieldCheck className="w-12 h-12 text-rose-500 mb-4 opacity-50" />
        <h2 className="text-xl font-bold text-white mb-2 uppercase tracking-tight">PERSISTENCE_LOCKED</h2>
        <p className="text-sm text-slate-400 text-center max-w-md font-mono">
          Could not establish connection to the persistence layer. Please check your Supabase configuration in .env.
        </p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Activity className="w-8 h-8 text-cyan-400 animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-12 pb-20">
      <section className="space-y-6">
        <h2 className="text-xl font-light text-white tracking-[0.2em] flex items-center gap-3">
          <Clock className="w-5 h-5 text-cyan-400" />
          Lead_Discovery_Logs
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {leadhistory && leadhistory.length > 0 ? leadhistory.map((batch) => {
            if (!batch) return null;
            return (
              <div key={batch.id} className="glass-panel p-5 relative group border-white/5 hover:border-cyan-500/30 transition-all">
                <div className="flex justify-between items-start mb-4">
                  <span className="text-[10px] font-mono text-cyan-500 bg-cyan-500/5 px-2 py-1 rounded">
                    {batch.created_at ? new Date(batch.created_at).toLocaleDateString() : 'N/A'}
                  </span>
                  <span className="text-[10px] font-mono text-slate-500 uppercase">
                    {batch.total_leads || 0} Records
                  </span>
                </div>
                <div className="space-y-1 mb-6">
                  <h4 className="text-sm font-bold text-white truncate">{batch.targets ? batch.targets.join(', ') : 'No Targets'}</h4>
                  <p className="text-[10px] text-slate-500 uppercase font-mono tracking-widest leading-none">Extraction_Batch</p>
                </div>
                <div className="flex justify-between items-center text-[10px] text-slate-400 pt-4 border-t border-white/5">
                  <span className="flex items-center gap-1.5"><FileSpreadsheet className="w-3 h-3" /> Grounded</span>
                  <span className="font-mono text-cyan-400/60 uppercase">ACTIVE</span>
                </div>
              </div>
            );
          }) : (
            <p className="col-span-full py-10 text-center glass-panel border-dashed border-white/10 text-slate-600 font-mono text-xs uppercase tracking-widest">No discovery logs found</p>
          )}
        </div>
      </section>
    </div>
  );
};

export default function App() {
  const [mode, setMode] = useState<AppMode>('LEAD_GEN');

  return (
    <div className="min-h-screen relative overflow-x-hidden font-sans selection:bg-cyan-500/30 selection:text-white">
      {/* Immersive Atmosphere Blobs */}
      <div className="fixed top-[-10%] left-[-10%] w-[40%] h-[40%] bg-cyan-900/20 rounded-full blur-[140px] pointer-events-none animate-pulse" />
      <div className="fixed bottom-[-5%] right-[-5%] w-[30%] h-[30%] bg-blue-900/15 rounded-full blur-[100px] pointer-events-none" />
      <div className="fixed top-[40%] right-[10%] w-[20%] h-[20%] bg-cyan-500/5 rounded-full blur-[120px] pointer-events-none" />

      {/* Top Navigation Rail (Immersive Branding) */}
      <nav className="fixed top-0 left-0 w-full h-20 px-8 flex justify-between items-center z-50 bg-[#02040a]/40 backdrop-blur-xl border-b border-white/5">
        <div className="flex items-center gap-5">
           <div className="h-10 w-10 bg-gradient-to-br from-cyan-400 to-blue-600 rounded-xl flex items-center justify-center shadow-[0_0_25px_rgba(34,211,238,0.3)] animate-pulse">
              <Activity className="w-6 h-6 text-white" />
           </div>
           <div>
             <h1 className="text-xl font-bold text-white tracking-widest uppercase flex items-baseline gap-1">
               LeadGen <span className="text-cyan-400 text-sm italic font-light tracking-[0.2em] relative top-[-2px]">Pro</span>
             </h1>
             <div className="flex items-center gap-2 text-[9px] uppercase tracking-[0.3em] text-slate-500 font-bold">
               <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]"></span>
               Core_Protocol_Active
             </div>
           </div>
        </div>

         <div className="flex bg-white/5 border border-white/10 rounded-2xl p-1 gap-1">
            <button 
              onClick={() => setMode('LEAD_GEN')}
              className={cn(
                "px-6 py-2 rounded-xl text-[10px] font-bold tracking-widest uppercase transition-all",
                mode === 'LEAD_GEN' ? "bg-cyan-400/10 text-cyan-400 border border-cyan-400/20 shadow-[0_0_20px_rgba(34,211,238,0.1)]" : "text-slate-500 hover:text-slate-300"
              )}
            >
              Analysis_Suite
            </button>
            <button 
              onClick={() => setMode('HISTORY')}
              className={cn(
                "px-6 py-2 rounded-xl text-[10px] font-bold tracking-widest uppercase transition-all",
                mode === 'HISTORY' ? "bg-cyan-400/10 text-cyan-400 border border-cyan-400/20 shadow-[0_0_20px_rgba(34,211,238,0.1)]" : "text-slate-500 hover:text-slate-300"
              )}
            >
              Historical_Logs
            </button>
         </div>
      </nav>

      {/* Primary Command Viewport */}
      <main className="pt-28 pb-20 px-8 relative z-10 max-w-screen-2xl mx-auto min-h-screen">
        <AnimatePresence mode="wait">
          {mode === 'LEAD_GEN' && (
            <motion.div
              key="leadv"
              initial={{ opacity: 0, scale: 0.98 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 1.02 }}
              transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
            >
              <LeadFinder />
            </motion.div>
          )}
          {mode === 'HISTORY' && (
            <motion.div
              key="histv"
              initial={{ opacity: 0, scale: 0.98 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 1.02 }}
              transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
            >
              <HistoryView />
            </motion.div>
          )}
        </AnimatePresence>
      </main>

      {/* Bottom Status Ticker (Immersive Theme) */}
      <footer className="fixed bottom-0 left-0 w-full px-8 py-4 bg-black/60 backdrop-blur-2xl border-t border-white/5 flex justify-between items-center z-50">
        <div className="flex gap-10">
          <div className="flex items-center gap-3">
             <div className="w-1.5 h-1.5 bg-cyan-400 rounded-full shadow-[0_0_8px_cyan]" />
             <div className="flex flex-col">
               <span className="text-[8px] uppercase tracking-widest text-slate-500 font-bold font-mono">Telemetry_Latency</span>
               <span className="text-[10px] text-white font-mono">42ms_Synchronized</span>
             </div>
          </div>
          <div className="flex items-center gap-3">
             <div className="w-1.5 h-1.5 bg-emerald-400 rounded-full shadow-[0_0_8px_#10b981]" />
             <div className="flex flex-col">
               <span className="text-[8px] uppercase tracking-widest text-slate-500 font-bold font-mono">Protocol_Encryption</span>
               <span className="text-[10px] text-white font-mono">AES-256_RSA_Bit</span>
             </div>
          </div>
          <div className="hidden md:flex items-center gap-3">
             <Activity className="w-3 h-3 text-slate-600" />
             <div className="flex flex-col">
               <span className="text-[8px] uppercase tracking-widest text-slate-500 font-bold font-mono">Search_Grounding</span>
               <span className="text-[10px] text-white font-mono uppercase italic tracking-tighter">Verified</span>
             </div>
          </div>
        </div>

        <div className="text-[9px] font-mono text-slate-500 uppercase tracking-widest font-bold opacity-30 select-none">
          Secure_Command_Shell_01 // Sess_ID: AI_LGEN_884P
        </div>
      </footer>
    </div>
  );
}
