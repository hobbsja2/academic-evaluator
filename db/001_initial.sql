CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS courses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL,
  section text NOT NULL,
  title text,
  term text NOT NULL,
  start_date date NOT NULL,
  end_date date NOT NULL CHECK (end_date >= start_date),
  purge_after date GENERATED ALWAYS AS (end_date + 21) STORED,
  canvas_course_id text,
  canvas_url text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (code, section, term)
);

CREATE TABLE IF NOT EXISTS assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id uuid NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  canvas_assignment_id text,
  title text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (course_id, title)
);

CREATE TABLE IF NOT EXISTS rubrics (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  assignment_id uuid NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
  title text,
  version integer NOT NULL CHECK (version > 0),
  total_points numeric,
  source text NOT NULL,
  source_url text,
  captured_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (assignment_id, version)
);

CREATE TABLE IF NOT EXISTS rubric_criteria (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rubric_id uuid NOT NULL REFERENCES rubrics(id) ON DELETE CASCADE,
  source_id text NOT NULL,
  name text,
  description text,
  maximum_points numeric,
  position integer NOT NULL,
  UNIQUE (rubric_id, source_id)
);
CREATE TABLE IF NOT EXISTS rubric_ratings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  criterion_id uuid NOT NULL REFERENCES rubric_criteria(id) ON DELETE CASCADE,
  source_id text NOT NULL,
  label text,
  description text,
  points numeric,
  position integer NOT NULL,
  UNIQUE (criterion_id, source_id)
);

CREATE TABLE IF NOT EXISTS students (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id uuid NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  pseudonym text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (course_id, pseudonym)
);

CREATE TABLE IF NOT EXISTS grading_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id uuid NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  assignment_id uuid NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
  rubric_id uuid NOT NULL REFERENCES rubrics(id) ON DELETE CASCADE,
  student_id uuid REFERENCES students(id) ON DELETE CASCADE,
  apa_enabled boolean NOT NULL,
  model text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS criterion_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  grading_run_id uuid NOT NULL REFERENCES grading_runs(id) ON DELETE CASCADE,
  criterion_id uuid NOT NULL REFERENCES rubric_criteria(id) ON DELETE CASCADE,
  suggested_rating text NOT NULL,
  suggested_points numeric NOT NULL,
  explanation text NOT NULL,
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  confidence numeric NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  review_required boolean NOT NULL,
  approved_rating text NOT NULL,
  approved_points numeric NOT NULL,
  approved_explanation text NOT NULL,
  UNIQUE (grading_run_id, criterion_id)
);

CREATE INDEX IF NOT EXISTS courses_purge_after_idx ON courses (purge_after);
CREATE INDEX IF NOT EXISTS assignments_course_idx ON assignments (course_id);
CREATE INDEX IF NOT EXISTS students_course_idx ON students (course_id);
CREATE INDEX IF NOT EXISTS grading_runs_course_idx ON grading_runs (course_id);
