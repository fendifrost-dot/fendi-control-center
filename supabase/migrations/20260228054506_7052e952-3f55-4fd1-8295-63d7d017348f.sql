
-- Add verification columns to observations
ALTER TABLE public.observations 
ADD COLUMN is_verified boolean NOT NULL DEFAULT false,
ADD COLUMN verified_at timestamp with time zone,
ADD COLUMN verified_via text; -- 'telegram', 'dashboard', etc.

-- Bot settings table for model preference and other config
CREATE TABLE public.bot_settings (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  setting_key text NOT NULL UNIQUE,
  setting_value text NOT NULL,
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

ALTER TABLE public.bot_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated full access" ON public.bot_settings
  FOR ALL USING (auth.uid() IS NOT NULL)
  WITH CHECK (auth.uid() IS NOT NULL);

-- Seed default model setting
INSERT INTO public.bot_settings (setting_key, setting_value) 
VALUES ('ai_model', 'gemini');

-- Pending approval queue: tracks which observation sets are awaiting Telegram approval
CREATE TABLE public.telegram_approval_queue (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  document_id uuid NOT NULL,
  client_id uuid NOT NULL,
  telegram_message_id bigint, -- Telegram message ID for callback tracking
  observation_count integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'pending', -- pending, approved, rejected
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  resolved_at timestamp with time zone
);

ALTER TABLE public.telegram_approval_queue ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated full access" ON public.telegram_approval_queue
  FOR ALL USING (auth.uid() IS NOT NULL)
  WITH CHECK (auth.uid() IS NOT NULL);

-- Service role needs direct access for edge functions
CREATE POLICY "Service role full access" ON public.telegram_approval_queue
  FOR ALL USING (true)
  WITH CHECK (true);

CREATE POLICY "Service role full access" ON public.bot_settings
  FOR ALL USING (true)
  WITH CHECK (true);
