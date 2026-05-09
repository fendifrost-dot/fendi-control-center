-- Pending route clarifications — operator-in-the-loop router ambiguity handling.
-- See Hub Resume Packet PR 3. Created with no runtime trigger yet; the Telegram
-- callback handler reads this table, but the branch that inserts into it is
-- gated separately (to be turned on in a follow-up PR).
create table if not exists public.pending_route_clarifications (
  id uuid primary key default gen_random_uuid(),
  correlation_id text not null,
  task_id uuid references public.tasks(id) on delete set null,
  chat_id text not null,
  update_id bigint not null,
  message_text text not null,
  candidate_routes jsonb not null,
  prompt_message_id bigint,
  status text not null default 'awaiting_operator'
    check (status in ('awaiting_operator', 'operator_selected', 'timed_out', 'skipped')),
  selected_route text,
  selected_at timestamptz,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '30 minutes')
);

create index if not exists idx_pending_clarifications_awaiting
  on public.pending_route_clarifications(status, expires_at)
  where status = 'awaiting_operator';

create index if not exists idx_pending_clarifications_correlation
  on public.pending_route_clarifications(correlation_id);
