-- AGH MCP OAuth: sliding refresh-token window.
--
-- Destination: fendifrost-dot/fan-growth-pilot  supabase/migrations/20261107190000_mcp_oauth_sliding_refresh.sql
-- Apply via Lovable -> SQL Editor on project vsemrziqxrrfcquxfnwd (paste, don't type).
--
-- Why: agh_mcp_rotate_oauth_refresh carried the ORIGINAL family expiry
-- (authorize time + 30 days) onto every rotated token, so a connector that
-- refreshes every hour, seven days a week, still dies exactly 30 days after
-- Fendi's one click. That is what flipped "AGH Playlist Discovery" to
-- needs_reconnect at 2026-11-07T14:38:36Z (authorized 2026-10-08T14:38:36Z).
--
-- After: every successful rotation moves refresh_expires_at to now() + 30 days.
-- A connector only expires if it has been idle for 30 days. The access-token
-- TTL (1 hour), one-time rotation, revocation and client binding are unchanged.
-- The edge function needs no change: it reads refresh_expires_at from the RPC result.

create or replace function public.agh_mcp_rotate_oauth_refresh(
  p_refresh_token_hash text,
  p_client_id text,
  p_new_access_token_hash text,
  p_new_refresh_token_hash text,
  p_access_expires_at timestamptz
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tok public.agh_mcp_oauth_tokens%rowtype;
  v_updated int;
  v_new_refresh_expires_at timestamptz;
begin
  if p_refresh_token_hash is null or p_client_id is null
     or p_new_access_token_hash is null or p_new_refresh_token_hash is null then
    return jsonb_build_object('ok', false, 'code', 'bad_request', 'error', 'required fields missing');
  end if;

  select * into v_tok
    from public.agh_mcp_oauth_tokens
   where refresh_token_hash = p_refresh_token_hash
     and revoked_at is null
   for update;

  if not found then
    return jsonb_build_object('ok', false, 'code', 'invalid_grant', 'error', 'refresh not found or revoked');
  end if;

  if v_tok.client_id is distinct from p_client_id then
    return jsonb_build_object('ok', false, 'code', 'invalid_grant', 'error', 'client mismatch');
  end if;

  if v_tok.refresh_expires_at is null or v_tok.refresh_expires_at < now() then
    update public.agh_mcp_oauth_tokens
       set revoked_at = now()
     where token_hash = v_tok.token_hash;
    return jsonb_build_object('ok', false, 'code', 'invalid_grant', 'error', 'refresh_expired');
  end if;

  update public.agh_mcp_oauth_tokens
     set revoked_at = now()
   where token_hash = v_tok.token_hash
     and revoked_at is null;
  get diagnostics v_updated = row_count;
  if v_updated <> 1 then
    return jsonb_build_object('ok', false, 'code', 'invalid_grant', 'error', 'refresh already rotated');
  end if;

  -- Sliding window: each successful rotation extends the family by 30 days.
  v_new_refresh_expires_at := now() + interval '30 days';

  insert into public.agh_mcp_oauth_tokens (
    token_hash, refresh_token_hash, client_id, scope, actor_kind,
    authorized_by_user_id, expires_at, refresh_expires_at
  ) values (
    p_new_access_token_hash, p_new_refresh_token_hash, p_client_id, v_tok.scope,
    v_tok.actor_kind, v_tok.authorized_by_user_id,
    p_access_expires_at, v_new_refresh_expires_at
  );

  return jsonb_build_object(
    'ok', true,
    'authorized_by_user_id', v_tok.authorized_by_user_id,
    'refresh_expires_at', v_new_refresh_expires_at,
    'scope', v_tok.scope,
    'actor_kind', v_tok.actor_kind
  );
exception
  when unique_violation then
    return jsonb_build_object('ok', false, 'code', 'conflict', 'error', 'token hash collision');
end;
$$;

comment on function public.agh_mcp_rotate_oauth_refresh(text, text, text, text, timestamptz) is
  'Rotates an AGH MCP OAuth refresh token. Sliding window: refresh_expires_at = now() + 30 days on each rotation (2026-11-07).';
