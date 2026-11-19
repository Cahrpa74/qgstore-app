import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { LeadGenResult } from '../types';

const supabaseUrl = (import.meta.env.VITE_SUPABASE_URL || '').trim();
const supabaseAnonKey = (import.meta.env.VITE_SUPABASE_ANON_KEY || '').trim();

const hasValidSupabaseConfig =
  supabaseUrl.startsWith('http://') || supabaseUrl.startsWith('https://');

export const supabase: SupabaseClient | null =
  hasValidSupabaseConfig && supabaseAnonKey
    ? createClient(supabaseUrl, supabaseAnonKey)
    : null;

export const storageService = {
  async uploadFile(file: File) {
    if (!supabase) {
      return { data: null, error: new Error('Supabase is not configured') };
    }

    const fileName = `${Date.now()}_${file.name}`;
    const { data, error } = await supabase.storage
      .from('uploads')
      .upload(fileName, file, {
        cacheControl: '3600',
        upsert: false,
      });

    if (error) {
      console.error('Storage Upload Error:', error.message);
      return { data: null, error };
    }

    return { data, error: null };
  },
};

export const persistenceService = {
  async saveLeadBatch(targets: string[], results: LeadGenResult[]) {
    if (!supabase) return;

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;

    const totalLeads = results.reduce((acc, r) => acc + (r.leads ? r.leads.length : 0), 0);

    const { error } = await supabase
      .from('lead_batches')
      .insert([
        {
          targets,
          results,
          total_leads: totalLeads,
          owner_id: user.id,
        },
      ]);

    if (error) {
      console.error('Database Save Error:', error);
    }
  },

  async getRecentLeads(maxCount = 10) {
    if (!supabase) return [];

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return [];

    const { data, error } = await supabase
      .from('lead_batches')
      .select('*')
      .eq('owner_id', user.id)
      .order('created_at', { ascending: false })
      .limit(maxCount);

    if (error) {
      console.error('Fetch Error:', error);
      return [];
    }
    return data || [];
  },
};