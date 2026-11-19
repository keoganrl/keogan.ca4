-- Playing for money. The host can switch it on at /chips/setup and name what the
-- whole buy-in is worth in dollars; every chip figure in the game (stacks, pot,
-- blinds, bets, the activity log, the game-over screen) is then shown as money
-- instead, at money_buyin / starting_stack dollars per chip.
--
-- Display only. The ledger, the blind schedule and every chip-conservation check
-- still run in whole chips, so nothing about play changes and player_stats never
-- sees this column. The leaderboard stays in chips too: a series can mix sessions
-- at different stakes, and adding their dollars together would mean nothing.
--
-- NULL = playing for chips, which is every session before this and the default.
--
-- Safe to deploy the code before running this: the client only names the column
-- when the host switches money on, so until then nothing reads or writes it. The
-- first money game started against a database without it would fail to start.
alter table sessions add column if not exists money_buyin numeric(10, 2)
  check (money_buyin is null or money_buyin > 0);
