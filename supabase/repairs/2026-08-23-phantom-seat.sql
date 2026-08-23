-- One-off repair: a phantom seat in the 2026-08-12 KITE session.
--
-- Someone typed the join code as their display name, was kicked before a hand was
-- dealt, and rejoined properly. Both chairs belong to the same identity, which is
-- the duplicate that supabase/one-seat-per-identity.sql refuses to index over.
--
-- Deleted rather than folded in. Folding adds both chairs' stacks AND buy-ins, and
-- although this chair is net-zero (stack == buy-in, it never played), folding would
-- credit that player with a 1000 buy-in nobody actually made. Chip conservation
-- holds either way: removing a row whose stack equals its buy-in takes the same
-- amount off both sides of sum(stack) + pot == sum(total_buyin).
--
-- The two events on the chair (its join and its kick) go with it. They are already
-- excluded from player_stats — `dealt` skips join/leave/kick — so nothing in the
-- numbers moves, and leaving them behind would only put two ownerless lines in the
-- session's ledger (events.player_id is ON DELETE SET NULL).
--
-- Guarded: it aborts unless the row really is the harmless thing described above.

begin;

do $$
declare
  seat        uuid;
  seats_found int;
  hand_events int;
  other_refs  int;
begin
  -- array_agg()[1], not min(): there is no min() aggregate over uuid. Same reason
  -- the blinds CTE in player-stats.sql is written that way.
  select count(*), (array_agg(id))[1] into seats_found, seat
  from players
  where session_id = 'f453cf37-d758-41fd-a7ea-0bb2195d1362'
    and display_name = 'Kite';

  if seats_found <> 1 then
    raise exception 'expected exactly one "Kite" seat in that session, found %', seats_found;
  end if;

  -- Anything that would make this a chair somebody actually played.
  select count(*) into hand_events
  from events
  where player_id = seat
    and type not in ('join', 'leave', 'kick');

  if hand_events > 0 then
    raise exception 'that seat has % hand event(s); it was played, so fold it in instead of deleting it', hand_events;
  end if;

  select (select count(*) from rebuys   where player_id        = seat)
       + (select count(*) from hands    where winner_player_id = seat)
       + (select count(*) from events   where target_player_id = seat)
       + (select count(*) from sessions where button_player_id = seat)
       + (select count(*) from sessions where current_actor_id = seat)
    into other_refs;

  if other_refs > 0 then
    raise exception 'that seat is referenced % time(s) elsewhere; fold it in instead of deleting it', other_refs;
  end if;

  delete from events  where player_id = seat;
  delete from players where id        = seat;
end
$$;

commit;

-- Confirm: expect zero rows.
select session_id, identity_id, count(*)
from players
where identity_id is not null
group by session_id, identity_id
having count(*) > 1;
