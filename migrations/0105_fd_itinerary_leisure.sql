-- FD package itinerary: per-day "Leisure day" flag. A leisure day carries
-- only an (optional) hotel — no tours/transfers/activities — plus an
-- optional remark shown to agents. The editor (FdPackageEditor.jsx) now
-- saves a row for every day 1..N so this flag is stored for all days.
ALTER TABLE fd_itinerary_days
  ADD COLUMN is_leisure BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN leisure_remark TEXT NULL;
