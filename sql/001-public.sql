-- Public stable edition only. Never import the private file stores here.
-- The application authenticates callers and binds all history queries to user_id.
-- These explicit predicates are the isolation boundary; this migration does not
-- claim owner-bypassing RLS to be a separate tenant-security boundary.
CREATE TABLE IF NOT EXISTS public_productivity (
  id text PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 200),
  entry jsonb NOT NULL CHECK (jsonb_typeof(entry) = 'object' AND octet_length(entry::text) <= 32768),
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Registered users edit only their own overlay. The shared catalog is never
-- updated by public website/MCP writes. A tombstone hides an item for its owner.
CREATE TABLE IF NOT EXISTS public_personal_productivity (
  user_id text NOT NULL CHECK (length(user_id) BETWEEN 1 AND 200),
  id text NOT NULL CHECK (length(id) BETWEEN 1 AND 200),
  entry jsonb NOT NULL CHECK (jsonb_typeof(entry) = 'object' AND octet_length(entry::text) <= 32768),
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, id)
);

CREATE TABLE IF NOT EXISTS public_plan_history (
  id uuid PRIMARY KEY,
  user_id text NOT NULL CHECK (length(user_id) BETWEEN 1 AND 200),
  request_id text CHECK (length(request_id) BETWEEN 1 AND 200),
  request_input_hash text CHECK (length(request_input_hash) BETWEEN 1 AND 200),
  plan jsonb NOT NULL CHECK (jsonb_typeof(plan) = 'object' AND octet_length(plan::text) <= 2097152),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT public_history_request_metadata CHECK ((request_id IS NULL) = (request_input_hash IS NULL)),
  CONSTRAINT public_history_request_unique UNIQUE (user_id, request_id)
);

CREATE INDEX IF NOT EXISTS public_history_user_created_idx
  ON public_plan_history (user_id, created_at DESC, id DESC);

-- Retained separately from history: deleting a plan must not reset daily limits.
CREATE TABLE IF NOT EXISTS public_plan_usage (
  user_id text PRIMARY KEY CHECK (length(user_id) BETWEEN 1 AND 200),
  usage_day date NOT NULL DEFAULT CURRENT_DATE,
  saved_count integer NOT NULL DEFAULT 0 CHECK (saved_count >= 0)
);
