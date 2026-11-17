-- EXCERPT 05 — Debounce, atomic turn claiming, bounded retries, and the internal-call secret.
--
-- What this shows: how "a customer who stopped typing" becomes exactly one unit of work, with no
-- Redis. A "turn" is everything the customer wrote since the last reply, read together once they
-- have been silent for `debounce_s` seconds.
--   · Claiming is atomic per conversation: an upsert that only succeeds if the lease is free or expired.
--   · If the worker dies, the lease expires on its own and the turn is retried.
--   · Errors back off (30 s, then 2 min) and the 3rd failure of the same slice is "abandoned"
--     (advances without replying) so a poison message cannot burn model tokens forever.
--   · Edge functions are deployed without JWT, so callers must present a secret kept in a vault.
-- Source: the turn migration of the production database (heavily trimmed). Table and column names
-- are simplified/generic and translated; the real schema, the identity-resolution join and the
-- cron wiring are omitted. Not runnable as-is.

-- ── Who is ready? ─────────────────────────────────────────────────────────────────────
-- One row per customer whose latest inbound message is older than the debounce window, that is
-- newer than what was already processed, and whose conversation is not leased by another worker.
-- Compared on created_at (microseconds), not on the provider timestamp (seconds): two messages
-- in the same second would tie.
create function turn_candidates(p_now timestamptz default now())
returns table (business_id uuid, customer_id uuid, conversation_id uuid, since timestamptz, until timestamptz)
language sql stable security definer set search_path = public as $$
  select b.id, ident.id, c.id, c.processed_until, max(e.created_at)
  from businesses b
  join message_events e
    on e.business_phone_id = b.phone_id
   and e.direction = 'inbound'
   and e.created_at > greatest(b.active_since, p_now - interval '30 minutes')  -- never answer stale messages
  join identities ident on ident.phone = e.contact_phone            -- (real join also handles BSUIDs)
  left join conversations c on c.business_id = b.id and c.customer_id = ident.id
  where b.active
    and (c.processed_until is null or e.created_at > c.processed_until)
    and (c.lease_until is null or c.lease_until <= p_now)
  group by b.id, b.debounce_s, ident.id, c.id, c.processed_until
  having max(e.created_at) <= p_now - make_interval(secs => b.debounce_s);
$$;

-- ── Claim ─────────────────────────────────────────────────────────────────────────────
create function claim_turns(p_limit integer default 5, p_now timestamptz default now())
returns setof turns
language plpgsql security definer set search_path = public as $$
declare
  c record; v_conv uuid; v_row turns;
begin
  -- turns whose worker died: the lease expired, count it as one failed attempt
  update turns t set status = 'error', error = 'Lease expired: worker did not close the turn'
  from conversations cv
  where cv.id = t.conversation_id and t.status = 'processing' and cv.lease_until <= p_now;

  for c in select * from turn_candidates(p_now) order by until limit greatest(p_limit, 1) loop
    v_conv := null;
    insert into conversations as cv (business_id, customer_id, lease_until)
    values (c.business_id, c.customer_id, p_now + interval '3 minutes')
    on conflict (business_id, customer_id) do update
      set lease_until = excluded.lease_until
      where cv.lease_until is null or cv.lease_until <= p_now       -- only wins if the lease is free
    returning cv.id into v_conv;
    if v_conv is null then continue; end if;                        -- another worker took it

    -- … collect message ids for (since, until], compute `attempt` = 1 + failed turns for this slice,
    --    insert the turn row and `return next` it (omitted)
  end loop;
end $$;

-- ── Close ─────────────────────────────────────────────────────────────────────────────
-- ok / skipped : advance `processed_until` ONLY up to what was read. A message that arrived while
--                the reply was being generated opens the next turn.
-- error        : do not advance; back off 30 s, then 2 min; 3rd failure of the same slice → 'abandoned'.
-- Closing an already closed turn is a no-op (idempotent).

-- ── Internal-call secret ──────────────────────────────────────────────────────────────
-- The comparison happens inside the database so the secret never has to be read by application code
-- beyond the single header value; the function is executable only by the service role.
create function validate_cron_secret(p_value text) returns boolean
language sql security definer set search_path = public, vault as $$
  select exists (
    select 1 from vault.decrypted_secrets
    where name = 'cron_secret' and p_value is not null and decrypted_secret = p_value);
$$;
