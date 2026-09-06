BEGIN;
CREATE TABLE IF NOT EXISTS rounds (
  id text PRIMARY KEY,
  slug text NOT NULL UNIQUE,
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  content text NOT NULL DEFAULT '',
  image text NOT NULL DEFAULT '',
  starts_at timestamptz NOT NULL,
  submissions_open_at timestamptz NOT NULL,
  voting_starts_at timestamptz NOT NULL,
  voting_ends_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  active boolean NOT NULL DEFAULT false,
  featured boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'draft',
  voting_strategy text NOT NULL DEFAULT 'fixed_per_wallet',
  votes_per_wallet integer NOT NULL DEFAULT 1,
  winner_count integer NOT NULL DEFAULT 1,
  max_submissions_per_wallet integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT rounds_status_check CHECK (status IN ('draft', 'published', 'archived')),
  CONSTRAINT rounds_voting_strategy_check CHECK (voting_strategy IN ('one_per_wallet', 'one_per_nft', 'fixed_per_wallet')),
  CONSTRAINT rounds_votes_per_wallet_check CHECK (votes_per_wallet > 0),
  CONSTRAINT rounds_winner_count_check CHECK (winner_count > 0),
  CONSTRAINT rounds_submission_limit_check CHECK (max_submissions_per_wallet > 0)
);

CREATE TABLE IF NOT EXISTS round_submissions (
  id text PRIMARY KEY,
  round_id text NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
  wallet_address text NOT NULL,
  title text NOT NULL,
  description text NOT NULL,
  image text NOT NULL,
  url text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'approved',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT round_submissions_status_check CHECK (status IN ('pending', 'approved', 'rejected', 'hidden'))
);

CREATE TABLE IF NOT EXISTS round_votes (
  id text PRIMARY KEY,
  round_id text NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
  submission_id text NOT NULL REFERENCES round_submissions(id) ON DELETE CASCADE,
  wallet_address text NOT NULL,
  vote_count integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT round_votes_positive_check CHECK (vote_count > 0),
  CONSTRAINT round_votes_unique_wallet_submission UNIQUE (round_id, submission_id, wallet_address)
);

CREATE TABLE IF NOT EXISTS round_awards (
  id text PRIMARY KEY,
  round_id text NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
  award_position integer NOT NULL,
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  award_value text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT round_awards_position_check CHECK (award_position > 0),
  CONSTRAINT round_awards_unique_position UNIQUE (round_id, award_position)
);

CREATE TABLE IF NOT EXISTS round_requests (
  id text PRIMARY KEY,
  wallet_address text NOT NULL,
  requester_name text NOT NULL,
  requester_email text NOT NULL,
  requested_slug text NOT NULL,
  title text NOT NULL,
  description text NOT NULL,
  content text NOT NULL DEFAULT '',
  image text NOT NULL DEFAULT '',
  url text NOT NULL DEFAULT '',
  timeline text NOT NULL DEFAULT '',
  starts_at timestamptz NOT NULL,
  submissions_open_at timestamptz NOT NULL,
  voting_starts_at timestamptz NOT NULL,
  voting_ends_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  voting_strategy text NOT NULL DEFAULT 'fixed_per_wallet',
  votes_per_wallet integer NOT NULL DEFAULT 1,
  winner_count integer NOT NULL DEFAULT 1,
  max_submissions_per_wallet integer NOT NULL DEFAULT 1,
  awards jsonb NOT NULL DEFAULT '[]',
  status text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  reviewed_at timestamptz,
  deleted_at timestamptz,
  CONSTRAINT round_requests_status_check CHECK (status IN ('pending', 'approved', 'rejected')),
  CONSTRAINT round_requests_voting_strategy_check CHECK (voting_strategy IN ('one_per_wallet', 'one_per_nft', 'fixed_per_wallet')),
  CONSTRAINT round_requests_votes_per_wallet_check CHECK (votes_per_wallet > 0),
  CONSTRAINT round_requests_winner_count_check CHECK (winner_count > 0),
  CONSTRAINT round_requests_submission_limit_check CHECK (max_submissions_per_wallet > 0)
);

CREATE INDEX IF NOT EXISTS rounds_public_idx ON rounds(status, active, deleted_at);
CREATE INDEX IF NOT EXISTS round_submissions_round_status_idx ON round_submissions(round_id, status);
CREATE INDEX IF NOT EXISTS round_votes_round_wallet_idx ON round_votes(round_id, wallet_address);
CREATE INDEX IF NOT EXISTS round_awards_round_position_idx ON round_awards(round_id, award_position);
CREATE INDEX IF NOT EXISTS round_requests_status_idx ON round_requests(status, deleted_at);
COMMIT;

