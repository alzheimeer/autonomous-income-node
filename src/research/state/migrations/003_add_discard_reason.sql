-- Add discard_reason column to opportunities table
-- Used by Categorizer to record why an opportunity was discarded

ALTER TABLE opportunities ADD COLUMN discard_reason TEXT;
