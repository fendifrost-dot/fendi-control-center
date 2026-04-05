-- Add Instagram outreach columns to pitch_drafts
ALTER TABLE public.pitch_drafts
  ADD COLUMN IF NOT EXISTS channel text NOT NULL DEFAULT 'email',
  ADD COLUMN IF NOT EXISTS instagram_handle text,
  ADD COLUMN IF NOT EXISTS dm_content text;