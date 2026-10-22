-- Additive sidecar only. No existing customer, job, billing or ingestion tables changed.
create table if not exists rook_acq_documents (
 kind text not null, id text not null, body jsonb not null,
 updated_at timestamptz not null default now(), primary key(kind,id)
);
create unique index if not exists rook_acq_partner_user on rook_acq_documents((body->>'userId')) where kind='partner';
create unique index if not exists rook_acq_partner_identity on rook_acq_documents((body->>'identityHash')) where kind='partner';
create table if not exists rook_acq_outbox (
 id text primary key, lane text not null, channel text not null,
 payload jsonb not null, status text not null default 'ready',
 attempts integer not null default 0, due_at timestamptz not null default now(),
 lease_token text, lease_until timestamptz, receipt jsonb, error_code text,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index if not exists rook_acq_outbox_due on rook_acq_outbox(lane,status,due_at);
create table if not exists rook_acq_commissions (
 customer_id text primary key, identity_hash text not null unique,
 invoice_id text not null unique, subscription_id text not null, fingerprint_hash text unique,
 partner_id text not null, amount_cents integer not null default 500 check(amount_cents=500),
 status text not null default 'held', eligible_at timestamptz not null,
 batch_id text, reversal_reason text, created_at timestamptz not null default now()
);
create table if not exists rook_acq_blocks (
 invoice_id text primary key, reason text not null, created_at timestamptz not null default now()
);
create table if not exists rook_acq_events (
 event_id text primary key, type text not null, result jsonb not null,
 created_at timestamptz not null default now()
);
alter table rook_acq_documents enable row level security;
alter table rook_acq_outbox enable row level security;
alter table rook_acq_commissions enable row level security;
alter table rook_acq_blocks enable row level security;
alter table rook_acq_events enable row level security;

-- Single server-only RPC keeps mutations atomic in Postgres and identical in local PGlite.
create or replace function rook_acq_command(op text, a jsonb)
returns jsonb language plpgsql security invoker set search_path = public as $$
declare r jsonb; row_out rook_acq_outbox; binding jsonb; partner jsonb; cfg jsonb; total integer;
begin
 if op='put' then
  if a->>'kind' not in ('config','partner','prospect','snapshot','report','metrics','seo','consent','suppression','baseline','batch') then raise exception 'Unknown document kind'; end if;
  insert into rook_acq_documents(kind,id,body) values(a->>'kind',a->>'id',a->'body') on conflict(kind,id) do update set body=excluded.body,updated_at=now();
  return a->'body';
 elsif op='get' then
  select body into r from rook_acq_documents where kind=a->>'kind' and id=a->>'id'; return r;
 elsif op='list' then
  select coalesce(jsonb_agg(jsonb_build_object('id',id,'body',body) order by id),'[]'::jsonb) into r from
   (select id,body from rook_acq_documents where kind=a->>'kind' order by id limit 2000) d; return r;
 elsif op='enroll' then
  -- Unique user ID and email fingerprint prevent account duplication.
  perform pg_advisory_xact_lock(hashtext('rook-partner:'||(a->>'identityHash')));
  select body into r from rook_acq_documents where kind='partner' and (id=a->>'id' or body->>'identityHash'=a->>'identityHash') limit 1;
  if r is not null then return r; end if;
  insert into rook_acq_documents(kind,id,body) values('partner',a->>'id',a);
  return a;
 elsif op='bind' then
  select body into cfg from rook_acq_documents where kind='config' and id='launch';
  if cfg->>'baselineComplete' is distinct from 'true' then return jsonb_build_object('bound',false,'reason','baseline_required'); end if;
  select body into partner from rook_acq_documents where kind='partner' and id=a->>'partnerId';
  if partner is null or partner->>'status'<>'active' or partner->>'userId'=a->>'userId' or partner->>'identityHash'=a->>'identityHash' then return jsonb_build_object('bound',false,'reason','invalid_or_self'); end if;
  if exists(select 1 from rook_acq_documents where kind='baseline' and (id=a->>'userId' or body->>'identityHash'=a->>'identityHash')) then return jsonb_build_object('bound',false,'reason','existing_customer'); end if;
  insert into rook_acq_documents(kind,id,body) values('binding',a->>'userId',a) on conflict do nothing;
  select body into r from rook_acq_documents where kind='binding' and id=a->>'userId'; return jsonb_build_object('bound',true,'partnerId',r->>'partnerId');
 elsif op='enqueue' then
  insert into rook_acq_outbox(id,lane,channel,payload,due_at) values(a->>'id',a->>'lane',a->>'channel',a->'payload',(a->>'dueAt')::timestamptz) on conflict do nothing;
  select to_jsonb(t) into r from rook_acq_outbox t where id=a->>'id'; return r;
 elsif op='claim' then
  select * into row_out from rook_acq_outbox where lane=a->>'lane' and due_at<=(a->>'now')::timestamptz
   and (status in ('ready','retry','uncertain','accepted') or (status='working' and lease_until<(a->>'now')::timestamptz))
   and (lease_until is null or lease_until<(a->>'now')::timestamptz)
   order by due_at,id for update skip locked limit 1;
  if row_out.id is null then return null; end if;
  update rook_acq_outbox set status='working',lease_token=a->>'token',lease_until=(a->>'now')::timestamptz+interval '2 minutes', attempts=attempts+1,updated_at=now() where id=row_out.id;
  return to_jsonb(row_out)||jsonb_build_object('lease_token',a->>'token');
 elsif op='outcome' then
  update rook_acq_outbox set status=a->>'status',receipt=coalesce(a->'receipt',receipt),error_code=a->>'error',due_at=(a->>'dueAt')::timestamptz,lease_token=null,lease_until=null,updated_at=now()
   where id=a->>'id' and lease_token=a->>'token';
  if not found then raise exception 'Lost lease'; end if; return jsonb_build_object('ok',true);
 elsif op='outbox' then
  select coalesce(jsonb_agg(to_jsonb(t)),'[]') into r from (select * from rook_acq_outbox order by created_at desc limit 1000) t; return r;
 elsif op='paid' then
  perform pg_advisory_xact_lock(hashtext('rook-customer:'||(a->>'customerId')));
  if exists(select 1 from rook_acq_events where event_id=a->>'eventId') then select result into r from rook_acq_events where event_id=a->>'eventId'; return r; end if;
  select body into cfg from rook_acq_documents where kind='config' and id='launch';
  select body into binding from rook_acq_documents where kind='binding' and id=a->>'userId';
  select body into partner from rook_acq_documents where kind='partner' and id=binding->>'partnerId';
  r=jsonb_build_object('credited',false,'invoiceId',a->>'invoiceId','amountCents',(a->>'amountCents')::integer,'paidAt',a->>'paidAt','channel',case when binding is not null then 'referral_partner' else coalesce(a->>'channel','unattributed') end);
  if cfg->>'baselineComplete'='true' and (a->>'paidAt')::timestamptz>=(cfg->>'goLiveAt')::timestamptz
   and a->>'eligible'='true' and length(a->>'fingerprintHash')>20 and binding is not null and partner->>'status'='active'
   and (binding->>'boundAt')::timestamptz<=(a->>'invoiceCreatedAt')::timestamptz
   and (binding->>'expiresAt')::timestamptz>=(a->>'invoiceCreatedAt')::timestamptz
   and partner->>'identityHash'<>a->>'identityHash' and partner->>'userId'<>a->>'userId'
   and not exists(select 1 from rook_acq_documents where kind='baseline' and (id=a->>'userId' or body->>'customerId'=a->>'customerId' or body->>'identityHash'=a->>'identityHash'))
   and not exists(select 1 from rook_acq_blocks where invoice_id=a->>'invoiceId') then
   insert into rook_acq_commissions(customer_id,identity_hash,invoice_id,subscription_id,fingerprint_hash,partner_id,eligible_at)
    values(a->>'customerId',a->>'identityHash',a->>'invoiceId',a->>'subscriptionId',a->>'fingerprintHash',binding->>'partnerId',(a->>'paidAt')::timestamptz+interval '30 days') on conflict do nothing;
   if found then r=r||jsonb_build_object('credited',true,'commissionCents',500); end if;
  end if;
  insert into rook_acq_events(event_id,type,result) values(a->>'eventId','paid',r); return r;
 elsif op='reverse' then
  insert into rook_acq_blocks(invoice_id,reason) values(a->>'invoiceId',a->>'reason') on conflict do nothing;
  update rook_acq_commissions set status=case when status='paid' then 'recovery_review' else 'reversed' end,reversal_reason=a->>'reason' where invoice_id=a->>'invoiceId';
  return jsonb_build_object('ok',true);
 elsif op='revenue' then
  select coalesce(jsonb_agg(to_jsonb(t)),'[]') into r from
   (select channel,count(*) invoices,sum(amount) gross_paid_cents from
    (select distinct on(result->>'invoiceId') result->>'invoiceId' invoice_id,result->>'channel' channel,(result->>'amountCents')::integer amount from rook_acq_events where type='paid' order by result->>'invoiceId',created_at) i group by channel) t; return r;
 elsif op='budget' then
  perform pg_advisory_xact_lock(hashtext('rook-acq-budget:'||coalesce(a->>'scope','buffer')||':'||(a->>'month')));
  select body into cfg from rook_acq_documents where kind='budget' and id=coalesce(a->>'scope','buffer')||':'||(a->>'month');
  total=coalesce((cfg->>'monthCount')::integer,0);
  if total>=(a->>'monthlyLimit')::integer or (cfg->>'day'=a->>'day' and (cfg->>'dayCount')::integer>=(a->>'dailyLimit')::integer) then return jsonb_build_object('allowed',false); end if;
  cfg=jsonb_build_object('monthCount',total+1,'day',a->>'day','dayCount',case when cfg->>'day'=a->>'day' then (cfg->>'dayCount')::integer+1 else 1 end);
  insert into rook_acq_documents(kind,id,body) values('budget',coalesce(a->>'scope','buffer')||':'||(a->>'month'),cfg) on conflict(kind,id) do update set body=excluded.body;
  return jsonb_build_object('allowed',true);
 elsif op='lease' then
  insert into rook_acq_documents(kind,id,body) values('lease',a->>'id',a)
   on conflict(kind,id) do update set body=excluded.body,updated_at=now()
    where (rook_acq_documents.body->>'expiresAt')::timestamptz<(a->>'now')::timestamptz;
  return jsonb_build_object('acquired',found);
 elsif op='commissions' then
  select coalesce(jsonb_agg(to_jsonb(t)),'[]') into r from (select * from rook_acq_commissions where (a->>'partnerId' is null or partner_id=a->>'partnerId') order by created_at desc limit 2000) t; return r;
 elsif op='prepare_batch' then
  perform pg_advisory_xact_lock(hashtext('rook-payout-batch'));
  select body into r from rook_acq_documents where kind='batch' and id=a->>'id'; if r is not null then return r; end if;
  update rook_acq_commissions set status='batched',batch_id=a->>'id'
   where status='held' and eligible_at<=(a->>'now')::timestamptz and partner_id in
    (select partner_id from rook_acq_commissions where status='held' and eligible_at<=(a->>'now')::timestamptz group by partner_id having sum(amount_cents)>=1000);
  select coalesce(jsonb_agg(jsonb_build_object('partnerId',partner_id,'amountCents',amount,'invoices',invoices)),'[]') into r from
   (select partner_id,sum(amount_cents) amount,jsonb_agg(invoice_id order by invoice_id) invoices from rook_acq_commissions where batch_id=a->>'id' group by partner_id order by partner_id) x;
  r=jsonb_build_object('id',a->>'id','status','awaiting_approval','recipients',r);
  insert into rook_acq_documents(kind,id,body) values('batch',a->>'id',r); return r;
 else raise exception 'Unknown acquisition operation'; end if;
end $$;
revoke all on function rook_acq_command(text,jsonb) from public;
-- Run grants only on Supabase (roles absent in local PGlite).
do $$ begin
 if exists(select 1 from pg_roles where rolname='anon') then
  execute 'revoke all on rook_acq_documents,rook_acq_outbox,rook_acq_commissions,rook_acq_blocks,rook_acq_events from anon, authenticated';
 end if;
 if exists(select 1 from pg_roles where rolname='service_role') then
  execute 'grant all on rook_acq_documents,rook_acq_outbox,rook_acq_commissions,rook_acq_blocks,rook_acq_events to service_role';
  execute 'grant execute on function rook_acq_command(text,jsonb) to service_role';
 end if;
end $$;
