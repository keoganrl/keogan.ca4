-- The gap between "the ledger has moved on to the next hand" and "the cards are
-- physically out". A settled hand now advances the button, posts the blinds and
-- sets this flag in one go, so every badge on the table names the hand about to be
-- played; the dealer (or the host) tapping Deal clears it and the action starts.
--
-- Run this BEFORE deploying the code that reads it. Old code ignores the column,
-- new code writes it on every deal, so this order is safe either way.
alter table sessions add column if not exists awaiting_deal boolean not null default false;
