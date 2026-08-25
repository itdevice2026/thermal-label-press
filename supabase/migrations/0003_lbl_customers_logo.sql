-- A customer can carry its own mark, shown beside the name in the app so an
-- operator can see at a glance whose run is on screen. It is deliberately not
-- part of the label: the printout stays exactly as the original.
--
-- Held as a small data URL rather than a file in storage — the app resizes to
-- 160px on the way in, which lands around 4 KB, and keeping it in the row means
-- the customer list needs no second round trip.
alter table public.lbl_customers add column if not exists logo text;
