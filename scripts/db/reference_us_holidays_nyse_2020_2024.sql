-- NYSE weekday closures 2020-01-01 through 2024-12-31 (aligned with XNYS / NYSE schedule).
-- Table: public.reference_us_holidays (PK: exchange, holiday_date)
--
-- Apply (example):
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/db/reference_us_holidays_nyse_2020_2024.sql
-- Or pick Dev / Prod connection string explicitly.

BEGIN;

INSERT INTO public.reference_us_holidays (exchange, holiday_date, label)
VALUES
  ('NYSE', DATE '2020-01-01', 'New Year''s Day'),
  ('NYSE', DATE '2020-01-20', 'Martin Luther King Jr. Day'),
  ('NYSE', DATE '2020-02-17', 'Washington''s Birthday'),
  ('NYSE', DATE '2020-04-10', 'Good Friday'),
  ('NYSE', DATE '2020-05-25', 'Memorial Day'),
  ('NYSE', DATE '2020-07-03', 'Independence Day (observed)'),
  ('NYSE', DATE '2020-09-07', 'Labor Day'),
  ('NYSE', DATE '2020-11-26', 'Thanksgiving'),
  ('NYSE', DATE '2020-12-25', 'Christmas'),
  ('NYSE', DATE '2021-01-01', 'New Year''s Day'),
  ('NYSE', DATE '2021-01-18', 'Martin Luther King Jr. Day'),
  ('NYSE', DATE '2021-02-15', 'Washington''s Birthday'),
  ('NYSE', DATE '2021-04-02', 'Good Friday'),
  ('NYSE', DATE '2021-05-31', 'Memorial Day'),
  ('NYSE', DATE '2021-07-05', 'Independence Day (observed)'),
  ('NYSE', DATE '2021-09-06', 'Labor Day'),
  ('NYSE', DATE '2021-11-25', 'Thanksgiving'),
  ('NYSE', DATE '2021-12-24', 'NYSE closed (Christmas Eve)'),
  ('NYSE', DATE '2022-01-17', 'Martin Luther King Jr. Day'),
  ('NYSE', DATE '2022-02-21', 'Washington''s Birthday'),
  ('NYSE', DATE '2022-04-15', 'Good Friday'),
  ('NYSE', DATE '2022-05-30', 'Memorial Day'),
  ('NYSE', DATE '2022-06-20', 'Juneteenth'),
  ('NYSE', DATE '2022-07-04', 'Independence Day'),
  ('NYSE', DATE '2022-09-05', 'Labor Day'),
  ('NYSE', DATE '2022-11-24', 'Thanksgiving'),
  ('NYSE', DATE '2022-12-26', 'Christmas (observed)'),
  ('NYSE', DATE '2023-01-02', 'New Year''s Day (observed)'),
  ('NYSE', DATE '2023-01-16', 'Martin Luther King Jr. Day'),
  ('NYSE', DATE '2023-02-20', 'Washington''s Birthday'),
  ('NYSE', DATE '2023-04-07', 'Good Friday'),
  ('NYSE', DATE '2023-05-29', 'Memorial Day'),
  ('NYSE', DATE '2023-06-19', 'Juneteenth'),
  ('NYSE', DATE '2023-07-04', 'Independence Day'),
  ('NYSE', DATE '2023-09-04', 'Labor Day'),
  ('NYSE', DATE '2023-11-23', 'Thanksgiving'),
  ('NYSE', DATE '2023-12-25', 'Christmas'),
  ('NYSE', DATE '2024-01-01', 'New Year''s Day'),
  ('NYSE', DATE '2024-01-15', 'Martin Luther King Jr. Day'),
  ('NYSE', DATE '2024-02-19', 'Washington''s Birthday'),
  ('NYSE', DATE '2024-03-29', 'Good Friday'),
  ('NYSE', DATE '2024-05-27', 'Memorial Day'),
  ('NYSE', DATE '2024-06-19', 'Juneteenth'),
  ('NYSE', DATE '2024-07-04', 'Independence Day'),
  ('NYSE', DATE '2024-09-02', 'Labor Day'),
  ('NYSE', DATE '2024-11-28', 'Thanksgiving'),
  ('NYSE', DATE '2024-12-25', 'Christmas')
ON CONFLICT (exchange, holiday_date) DO NOTHING;

COMMIT;

-- 47 rows (weekday NYSE closures in range). Ad-hoc closures (e.g. national mourning) must be added manually.
