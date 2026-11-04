-- Run this ONLY if you deployed before the image-sizing fix.
-- A fresh database created from schema.sql already has these columns.
--
--   npx wrangler d1 execute lightline --remote --file=./migrations/001-before-dims.sql
--
-- Existing rows get NULL for bw/bh; the app treats that as "same shape as the
-- after image", which is how those pairs already behaved.

ALTER TABLE items ADD COLUMN bw  INTEGER;
ALTER TABLE items ADD COLUMN bh  INTEGER;
ALTER TABLE items ADD COLUMN fit TEXT DEFAULT 'cover';
