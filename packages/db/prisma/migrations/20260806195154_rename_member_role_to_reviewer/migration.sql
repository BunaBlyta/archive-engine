-- Rename the "member" role value to "reviewer". Two roles only: admin, reviewer.
UPDATE "Membership" SET role = 'reviewer' WHERE role = 'member';

ALTER TABLE "Membership" ALTER COLUMN "role" SET DEFAULT 'reviewer';
