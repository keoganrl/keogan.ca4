-- Chips — one seat per identity per session.
--
-- Two things live here: the functions that fold two chairs into one, and the
-- constraint that stops a third appearing. Run the whole file; the constraint at the
-- bottom will refuse if any duplicates are left, which is the point.
--
-- ---------------------------------------------------------------------------
-- WHY THIS EXISTS
-- ---------------------------------------------------------------------------
-- joinSession reads "have you got a seat here already?" and then inserts, which is
-- two round trips with a gap in the middle. Two tabs both read "no" and both insert,
-- and one human ends up holding two chairs in one game: two stacks, two buy-ins, and
-- a lifetime net that counts them twice.
--
-- The identity merge tool produces the same shape deliberately. Someone who joins
-- from a private tab gets a fresh identity, so one human appears several times on
-- the leaderboard; merging them repoints every seat onto the surviving identity, and
-- if they played the SAME session under two identities, the survivor now holds two
-- seats in it. That is not a mistake — it is the true state of the night — but it
-- has to be represented as one seat, or every per-session number counts them twice.
--
-- ---------------------------------------------------------------------------
-- LOOK BEFORE YOU MERGE
-- ---------------------------------------------------------------------------
-- Folding two chairs together ADDS their stacks and their buy-ins. That is right
-- when both chairs were really bought and really played: the session's chip totals
-- do not move, and the person's net is the sum of what each chair made.
--
-- It is WRONG if one of the rows is a phantom — a seat created by a bug, carrying a
-- buy-in nobody paid. Adding that buy-in in would invent a loss. So look first:
--
--   select p.session_id, s.created_at::date as played, s.join_code,
--          p.identity_id, i.display_name,
--          count(*) as seats,
--          array_agg(p.display_name)      as seat_names,
--          array_agg(p.stack)             as stacks,
--          array_agg(p.total_buyin)       as buyins,
--          array_agg(p.seat_order)        as seat_orders,
--          array_agg(
--            (select count(*) from events e where e.player_id = p.id)
--          )                              as events_each
--   from players p
--   join sessions s on s.id = p.session_id
--   left join players_identity i on i.id = p.identity_id
--   where p.identity_id is not null
--   group by p.session_id, s.created_at, s.join_code, p.identity_id, i.display_name
--   having count(*) > 1;
--
-- A row with a real buy-in and a handful of events is a chair that was played: fold
-- it in. A row with a buy-in and ZERO events never played a hand, and whether its
-- buy-in was real is a question about the night, not about the database — if nobody
-- actually put those chips in, delete that row instead of merging it.


-- ---------------------------------------------------------------------------
-- merge_seats: fold one chair into another
-- ---------------------------------------------------------------------------
-- Everything that points at the disappearing seat is repointed BEFORE it is deleted.
-- That ordering is load-bearing: events.player_id is ON DELETE SET NULL, and an
-- event with no owner drops out of its hand's ring in player_stats, which shifts
-- every position label in that hand (see the note in player-stats.sql).
create or replace function merge_seats(keep_seat uuid, drop_seat uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if keep_seat is null or drop_seat is null or keep_seat = drop_seat then
    return;
  end if;

  -- The chips add up. Both chairs' money belongs to one person, so the session's
  -- totals are unchanged and chip conservation still holds afterwards.
  update players k
  set stack             = k.stack + d.stack,
      total_buyin       = k.total_buyin + d.total_buyin,
      hand_total_bet    = k.hand_total_bet + d.hand_total_bet,
      current_round_bet = k.current_round_bet + d.current_round_bet,
      -- Flags survive if either chair had them; folded only if BOTH were folded.
      is_host           = k.is_host or d.is_host,
      is_active         = k.is_active or d.is_active,
      folded            = k.folded and d.folded
  from players d
  where k.id = keep_seat and d.id = drop_seat;

  update events   set player_id        = keep_seat where player_id        = drop_seat;
  update events   set target_player_id = keep_seat where target_player_id = drop_seat;
  update rebuys   set player_id        = keep_seat where player_id        = drop_seat;
  update hands    set winner_player_id = keep_seat where winner_player_id = drop_seat;
  update sessions set button_player_id = keep_seat where button_player_id = drop_seat;
  update sessions set current_actor_id = keep_seat where current_actor_id = drop_seat;

  delete from players where id = drop_seat;
end;
$$;


-- ---------------------------------------------------------------------------
-- collapse_duplicate_seats: fold every duplicate chair in the table
-- ---------------------------------------------------------------------------
-- Returns how many chairs it removed, so running it is not a silent operation.
-- Re-running it once there are none is a no-op returning 0.
--
-- The surviving chair is chosen: the host's chair first (it is the one the session
-- was run from), then the lowest seat number, then by id so the choice is stable.
create or replace function collapse_duplicate_seats()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  grp     record;
  gone    uuid;
  removed integer := 0;
begin
  for grp in
    select (array_agg(id order by is_host desc, seat_order, id))[1]  as keep_seat,
           (array_agg(id order by is_host desc, seat_order, id))[2:] as drop_seats
    from players
    where identity_id is not null
    group by session_id, identity_id
    having count(*) > 1
  loop
    foreach gone in array grp.drop_seats loop
      perform merge_seats(grp.keep_seat, gone);
      removed := removed + 1;
    end loop;
  end loop;

  return removed;
end;
$$;


-- ---------------------------------------------------------------------------
-- merge_identities: what the leaderboard's merge button now calls
-- ---------------------------------------------------------------------------
-- The client used to do this as two bare statements, which cannot work once the
-- constraint below exists: repointing a ghost's seat onto an identity that already
-- has a seat in that session violates it, the client discards the error, and the
-- merge silently does nothing. Here the colliding chairs are folded together FIRST,
-- so by the time the repoint runs there is nothing left to collide with — and the
-- whole thing is one transaction, so a failure half way through cannot leave seats
-- pointing at an identity that has been deleted.
create or replace function merge_identities(keep_id uuid, ghost_ids uuid[])
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  grp  record;
  gone uuid;
begin
  if keep_id is null or ghost_ids is null or array_length(ghost_ids, 1) is null then
    return;
  end if;

  -- Sessions where these identities hold more than one chair between them. Grouped
  -- across the whole set rather than pairwise, so two ghosts seated in a session the
  -- survivor never played still collapse to one chair.
  for grp in
    select (array_agg(id order by (identity_id = keep_id) desc, is_host desc, seat_order, id))[1]
             as keep_seat,
           (array_agg(id order by (identity_id = keep_id) desc, is_host desc, seat_order, id))[2:]
             as drop_seats
    from players
    where identity_id = keep_id or identity_id = any(ghost_ids)
    group by session_id
    having count(*) > 1
  loop
    foreach gone in array grp.drop_seats loop
      perform merge_seats(grp.keep_seat, gone);
    end loop;
  end loop;

  update players
     set identity_id = keep_id
   where identity_id = any(ghost_ids)
     and identity_id <> keep_id;

  delete from players_identity
   where id = any(ghost_ids)
     and id <> keep_id;
end;
$$;

grant execute on function merge_seats(uuid, uuid)          to anon, authenticated, service_role;
grant execute on function collapse_duplicate_seats()       to anon, authenticated, service_role;
grant execute on function merge_identities(uuid, uuid[])   to anon, authenticated, service_role;


-- ---------------------------------------------------------------------------
-- Fold together whatever duplicates exist right now
-- ---------------------------------------------------------------------------
-- Read the LOOK BEFORE YOU MERGE query above first. If any duplicate is a phantom
-- seat rather than a chair somebody played, delete that row by hand instead and then
-- run this: it only touches what is still duplicated.
select collapse_duplicate_seats() as chairs_folded_in;


-- ---------------------------------------------------------------------------
-- The constraint
-- ---------------------------------------------------------------------------
-- identity_id is nullable, and NULLs do not conflict in a unique index, so guest
-- seats with no identity are unaffected — any number of them can share a session.
create unique index if not exists players_session_identity_idx
  on players (session_id, identity_id);


-- Confirm: expect zero rows.
select session_id, identity_id, count(*)
from players
where identity_id is not null
group by session_id, identity_id
having count(*) > 1;
