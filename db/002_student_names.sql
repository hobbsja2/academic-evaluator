-- Roster import stores each student's real name next to the course pseudonym.
-- Grading runs keep referencing the student row, never the name; the 21-day
-- cascading purge on courses remains the retention control.
ALTER TABLE students ADD COLUMN IF NOT EXISTS display_name text;
ALTER TABLE students ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS students_course_display_name_idx ON students (course_id, display_name);
CREATE INDEX IF NOT EXISTS grading_runs_student_created_idx ON grading_runs (student_id, created_at DESC);
