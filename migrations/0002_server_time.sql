-- The API's own time on real requests, as /health reports it (median over its last 15 minutes),
-- kept beside the probe's round trip. The round trip is mostly the network from whichever colo ran
-- the cron; this is what the page draws. A check whose /health carries no such number adds nothing,
-- so the average divides by server_checks, not checks.
ALTER TABLE target_state ADD COLUMN server_ms REAL;
ALTER TABLE target_hours ADD COLUMN server_sum REAL NOT NULL DEFAULT 0;
ALTER TABLE target_hours ADD COLUMN server_checks INTEGER NOT NULL DEFAULT 0;
ALTER TABLE target_days ADD COLUMN server_sum REAL NOT NULL DEFAULT 0;
ALTER TABLE target_days ADD COLUMN server_checks INTEGER NOT NULL DEFAULT 0;
