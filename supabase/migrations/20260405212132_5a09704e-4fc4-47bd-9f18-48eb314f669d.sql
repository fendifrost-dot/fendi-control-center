create table if not exists public.telegram_webhook_processed_updates (
  update_id bigint not null primary key,
  received_at timestamptz not null default now()
);

comment on table public.telegram_webhook_processed_updates is
  'Telegram update_id idempotency; inserted at start of processing after ingress gates.';

alter table public.telegram_webhook_processed_updates enable row level security;