-- ============================================================
-- SoloQ Tracker — init.sql  (schéma uniquement, pas de seed)
-- Exécuté une seule fois à la création du volume.
-- ============================================================

CREATE TABLE IF NOT EXISTS players (
  id                SERIAL PRIMARY KEY,
  name              VARCHAR(80)  NOT NULL,
  tag               VARCHAR(20)  NOT NULL DEFAULT '#EUW',
  avatar            VARCHAR(10)  NOT NULL DEFAULT '🎮',
  tier              VARCHAR(20)  NOT NULL,
  division          VARCHAR(5),
  lp                INT          NOT NULL DEFAULT 0,
  lp_delta          INT          NOT NULL DEFAULT 0,
  wins              INT          NOT NULL DEFAULT 0,
  losses            INT          NOT NULL DEFAULT 0,
  riot_summoner_id  VARCHAR(100) UNIQUE,
  riot_puuid        VARCHAR(200) UNIQUE,
  display_name      VARCHAR(100),
  profile_url       VARCHAR(500),
  team              VARCHAR(50),
  avatar_custom     TEXT,
  updated_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Migration idempotente pour les bases existantes
ALTER TABLE players ADD COLUMN IF NOT EXISTS display_name  VARCHAR(100);
ALTER TABLE players ADD COLUMN IF NOT EXISTS profile_url   VARCHAR(500);
ALTER TABLE players ADD COLUMN IF NOT EXISTS team          VARCHAR(50);
ALTER TABLE players ADD COLUMN IF NOT EXISTS avatar_custom TEXT;

CREATE TABLE IF NOT EXISTS matches (
  id             SERIAL PRIMARY KEY,
  player_id      INT          NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  riot_match_id  VARCHAR(50),
  result         VARCHAR(10)  NOT NULL CHECK (result IN ('win', 'loss')),
  champion       VARCHAR(60)  NOT NULL,
  role           VARCHAR(20)  NOT NULL,
  kills          INT          NOT NULL DEFAULT 0,
  deaths         INT          NOT NULL DEFAULT 0,
  assists        INT          NOT NULL DEFAULT 0,
  cs             INT          NOT NULL DEFAULT 0,
  duration       VARCHAR(10)  NOT NULL,
  lp_change      INT,
  first_blood    BOOLEAN NOT NULL DEFAULT false,
  total_pings    INT     NOT NULL DEFAULT 0,
  surrendered    BOOLEAN NOT NULL DEFAULT false,
  played_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE (riot_match_id, player_id)
);

CREATE INDEX IF NOT EXISTS idx_matches_player ON matches(player_id, played_at DESC);


-- ---------- Players seed ----------

