
-- Create marketing_spend table for Meta ad spend cross-referencing
CREATE TABLE public.marketing_spend (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  client_id UUID REFERENCES public.clients(id),
  platform TEXT NOT NULL DEFAULT 'meta',
  campaign_id TEXT,
  campaign_name TEXT,
  ad_set_name TEXT,
  ad_name TEXT,
  spend NUMERIC(12,2) NOT NULL DEFAULT 0,
  impressions INTEGER DEFAULT 0,
  clicks INTEGER DEFAULT 0,
  conversions INTEGER DEFAULT 0,
  date DATE NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  raw_data JSONB,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.marketing_spend ENABLE ROW LEVEL SECURITY;

-- RLS policy consistent with existing tables
CREATE POLICY "Authenticated full access"
ON public.marketing_spend
FOR ALL
USING (auth.uid() IS NOT NULL)
WITH CHECK (auth.uid() IS NOT NULL);

-- Index for cross-referencing by client and date
CREATE INDEX idx_marketing_spend_client_date ON public.marketing_spend(client_id, date);
CREATE INDEX idx_marketing_spend_platform ON public.marketing_spend(platform);
