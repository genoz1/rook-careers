-- Additive; only the service role can read or mutate these tables.
create table if not exists public.resource_topics (
 slug text primary key, title text not null unique, category text not null,
 intent text not null, audience text not null, priority integer not null default 100,
 status text not null default 'queued' check(status in ('queued','generating','published','failed','rejected')),
 attempts integer not null default 0, published_url text, published_at timestamptz,
 last_error text, selected_at timestamptz
);
create table if not exists public.resource_articles (
 slug text primary key references public.resource_topics(slug), title text not null unique,
 category text not null, description text not null, body_html text not null,
 body_hash text not null unique, image_path text not null, image_alt text not null,
 sources jsonb not null default '[]', social_copy jsonb not null default '{}',
 kind text not null default 'evergreen' check(kind in ('evergreen','news')),
 published_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 public_verified_at timestamptz, word_count integer not null
);
create table if not exists public.resource_slots (
 day date not null, slot integer not null check(slot>=0), due_at timestamptz not null,
 topic_slug text references public.resource_topics(slug), owner uuid, lease_until timestamptz,
 attempts integer not null default 0, state text not null default 'queued'
 check(state in ('queued','generating','published','failed')),
 primary key(day,slot)
);
create table if not exists public.resource_distribution (
 article_slug text not null references public.resource_articles(slug), channel text not null,
 state text not null default 'queued' check(state in ('queued','sending','sent','uncertain')),
 receipt jsonb, updated_at timestamptz not null default now(), primary key(article_slug,channel)
);
create index if not exists resource_articles_date on public.resource_articles(published_at desc);
create index if not exists resource_topics_queue on public.resource_topics(status,priority,slug);
alter table public.resource_topics enable row level security;
alter table public.resource_articles enable row level security;
alter table public.resource_slots enable row level security;
alter table public.resource_distribution enable row level security;
revoke all on public.resource_topics,public.resource_articles,public.resource_slots,public.resource_distribution from anon,authenticated;
grant all on public.resource_topics,public.resource_articles,public.resource_slots,public.resource_distribution to service_role;

create or replace function public.claim_resource_slot(p_day date,p_slot integer,p_due timestamptz,p_owner uuid)
returns jsonb language plpgsql security invoker set search_path=public as $$
declare s resource_slots; t resource_topics; previous_category text;
begin
 perform pg_advisory_xact_lock(726665);
 insert into resource_slots(day,slot,due_at) values(p_day,p_slot,p_due) on conflict do nothing;
 select * into s from resource_slots where day=p_day and slot=p_slot for update;
 if s.state in ('published','failed') or s.due_at>now() or (s.lease_until>now()) then return null; end if;
 -- Serialize generation across web replicas and scheduled workers.
 if exists(select 1 from resource_slots where state='generating' and lease_until>now()) then return null; end if;
 if s.attempts>=6 then update resource_slots set state='failed' where day=p_day and slot=p_slot; return null; end if;
 if s.topic_slug is not null then
   select * into t from resource_topics where slug=s.topic_slug and status='generating';
 end if;
 if t.slug is null then
   select category into previous_category from resource_topics where selected_at is not null order by selected_at desc limit 1;
   select * into t from resource_topics where status='queued' and category<>'industry-news'
    order by (category=coalesce(previous_category,'')), priority,slug limit 1 for update;
 end if;
 if t.slug is null then return null; end if;
 update resource_topics set status='generating',selected_at=now() where slug=t.slug;
 update resource_slots set state='generating',topic_slug=t.slug,owner=p_owner,
 lease_until=now()+interval '30 minutes',attempts=attempts+1 where day=p_day and slot=p_slot;
 return to_jsonb(t);
end $$;
create or replace function public.finish_resource_slot(p_day date,p_slot integer,p_owner uuid,p_article jsonb,p_error text default null)
returns boolean language plpgsql security invoker set search_path=public as $$
declare s resource_slots;
begin
 select * into s from resource_slots where day=p_day and slot=p_slot for update;
 if s.owner is distinct from p_owner or s.state<>'generating' or s.lease_until<=now() then raise exception 'Resource lease lost'; end if;
 if p_article is null then
   update resource_topics set status='rejected',last_error=left(p_error,200),attempts=attempts+2 where slug=s.topic_slug;
   update resource_slots set state='queued',topic_slug=null,owner=null,lease_until=null where day=p_day and slot=p_slot;
   return false;
 end if;
 insert into resource_articles(slug,title,category,description,body_html,body_hash,image_path,image_alt,sources,social_copy,word_count)
 select t.slug,t.title,t.category,p_article->>'description',p_article->>'body_html',p_article->>'body_hash',
 p_article->>'image_path',p_article->>'image_alt',p_article->'sources',p_article->'social_copy',(p_article->>'word_count')::integer
 from resource_topics t where t.slug=s.topic_slug;
 update resource_topics set status='published',published_at=now(),published_url=p_article->>'url',attempts=attempts+1 where slug=s.topic_slug;
 update resource_slots set state='published',owner=null,lease_until=null where day=p_day and slot=p_slot;
 insert into resource_distribution(article_slug,channel) select s.topic_slug,channel from unnest(array['linkedin','personal','facebook','instagram']) channel;
 return true;
end $$;
revoke all on function public.claim_resource_slot(date,integer,timestamptz,uuid) from public,anon,authenticated;
revoke all on function public.finish_resource_slot(date,integer,uuid,jsonb,text) from public,anon,authenticated;
grant execute on function public.claim_resource_slot(date,integer,timestamptz,uuid) to service_role;
grant execute on function public.finish_resource_slot(date,integer,uuid,jsonb,text) to service_role;
