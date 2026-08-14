-- One-off repair: chips wrongly credited by endSession, 2026-07-28 → 2026-08-14.
--
-- endSession handed every player their `hand_total_bet` back before closing the
-- books. That column is only cleared by the next deal, so ending a session right
-- after a hand finished — the normal way a night ends — refunded that hand's
-- commitment on top of the pot the winners had already been awarded. Fixed in
-- src/chips/lib/services/table.ts (refunds are now capped at sessions.pot); this
-- script corrects the sessions played before the fix.
--
-- Derived by replaying the full `events` ledger and reconciling against the live
-- `players` rows: the replay reproduced all six sessions' drift exactly, and
-- matched per-player stacks in five of the six. Buy-ins are untouched — they were
-- always right — so the nets and the lifetime board come out correct.
--
-- Verify with query 0b in ../session-audit.sql before and after. Expected after:
-- one row, 2026-08-04 at +50. That night also carried the leaver-mint bug (fixed
-- 2026-08-07 in 9749d35); the host's corrections at the table cancelled all but
-- 50 of it, and the remainder went into pots as they were won with no single
-- recipient to bill. Deliberately left unassigned rather than charged to someone
-- who may not have received it.

begin;

-- 1. remove chips endSession refunded that the pot did not owe
--    2026-07-30
update players set stack = stack - 50   where id = '7f15cd37-4201-49e4-8fa1-5f109a4d078a';  -- Owen the great and wonderful
--    2026-08-04
update players set stack = stack - 50   where id = '4ccc1198-d596-45ea-8332-d82fd384b381';  -- Emily
--    2026-08-05
update players set stack = stack - 175  where id = 'b47bbdaa-1268-4b43-a4cb-7a54ed51fa41';  -- Emily
update players set stack = stack - 50   where id = 'fd9e5db0-2d73-4cbd-a970-2d0da52c1806';  -- Shaw-Ern
--    2026-08-06
update players set stack = stack - 50   where id = '6777fe47-216c-4155-8643-7f590bd09e47';  -- Owen the great and wonderful
update players set stack = stack - 50   where id = '92ad3bfc-c55f-492f-8547-3e6d8b6eefd5';  -- Keogan
update players set stack = stack - 50   where id = '70094891-a50f-4f6a-954c-a00f25c5fc4f';  -- Jack Aiden Hinderager
update players set stack = stack - 50   where id = '6d391b80-78e3-4aad-8abe-439cc29e4e79';  -- Chong
--    2026-08-12
update players set stack = stack - 690  where id = '4c148eb7-8cd7-4fdf-be80-f15b33f11f57';  -- Adam
update players set stack = stack - 690  where id = 'a751cfc2-4aac-4408-8256-c979a76cf004';  -- so did he embodies
update players set stack = stack - 460  where id = '36ccdd6b-b541-4056-b893-7956e9b932c5';  -- Shaw-Ern
update players set stack = stack - 20   where id = '3a8ad483-1712-4028-9cd1-683996b7c294';  -- Jack Aiden Hinderager
update players set stack = stack - 20   where id = '8039a5cb-e314-4cd9-a19f-5cc510cfdb8b';  -- Keogan
--    2026-08-14
update players set stack = stack - 2590 where id = '596a0b25-5e5f-4bef-8993-48d6c033037c';  -- Jun
update players set stack = stack - 460  where id = '98cfd1e5-a11e-4f76-9525-b0fc08672bcc';  -- Chong
update players set stack = stack - 240  where id = 'acccfedc-806d-4f6f-a691-e3df3f0b5bbe';  -- Shaw-Ern

-- 2. return chips left stranded in the pot, and close those pots
update players set stack = stack + 50  , hand_total_bet = 0 where id = '70fd069c-e071-402e-9d3e-8a804aacf2eb';  -- 2026-07-28 Keogan
update players set stack = stack + 25  , hand_total_bet = 0 where id = '6024ca07-e663-4ea9-9029-135e56fe4293';  -- 2026-07-28 Jack Aiden Hinderager
update players set stack = stack + 25  , hand_total_bet = 0 where id = 'daad3a94-be34-4257-b958-a6552ab87c6c';  -- 2026-07-29 Keogan
update players set stack = stack + 50  , hand_total_bet = 0 where id = '8827b9e8-abcd-4d17-bfbe-636ae49b0ec1';  -- 2026-07-29 so did he embodies
update sessions set pot = 0 where id = '72d6f97a-337e-4721-a449-c3e09c081be9';
update sessions set pot = 0 where id = '79dfbe0a-cc4d-4261-a022-db304120c0f2';

commit;

-- Confirm: expect exactly one row, 2026-08-04 / +50.
select s.created_at::date as night, sum(p.stack) + s.pot - sum(p.total_buyin) as drift
from sessions s
join players p on p.session_id = s.id
group by s.id
having sum(p.stack) + s.pot <> sum(p.total_buyin)
order by 1;
