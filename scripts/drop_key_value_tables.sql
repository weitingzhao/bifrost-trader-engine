-- Drop Key-Value Config tables (removed from project 2026-03-11).
-- Run this manually against your PostgreSQL database, then delete this file if desired.
-- Order: drop child table first (key_value_config has FK to key_value_group).

DROP TABLE IF EXISTS key_value_config;
DROP TABLE IF EXISTS key_value_group;
