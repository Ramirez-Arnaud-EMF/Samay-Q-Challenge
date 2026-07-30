/**
 * SoloQ Tracker — backend/index.js
 *
 * REST API Express + PostgreSQL
 *
 * Routes :
 *   GET /api/health
 *   GET /api/players?sort=lp|winrate|wins&search=<name>
 *   GET /api/players/:id/matches
 *   GET /api/matches?limit=500
 *
 * [RIOT-API] Points d'intégration marqués ci-dessous.
 */

'use strict';

const express = require('express');
const cors    = require('cors');
const { Pool } = require('pg');
const { syncSinglePlayer, syncTrackedPlayers, refreshAllLiveGames } = require('./riot');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Connexion PostgreSQL ──────────────────────────────────────
const pool = new Pool({
  host:     process.env.DB_HOST     || 'localhost',
  port:     Number(process.env.DB_PORT) || 5432,
  database: process.env.DB_NAME     || 'soloq',
  user:     process.env.DB_USER     || 'soloq',
  password: process.env.DB_PASSWORD || 'soloq_pass',
});

app.use(cors());
app.use(express.json({ limit: '600kb' }));

// ── Migration DB ─────────────────────────────────────────────
async function ensureMigrations() {
  const migrations = [
    `ALTER TABLE players ADD COLUMN IF NOT EXISTS display_name  VARCHAR(100)`,
    `ALTER TABLE players ADD COLUMN IF NOT EXISTS profile_url   VARCHAR(500)`,
    `ALTER TABLE players ADD COLUMN IF NOT EXISTS team          VARCHAR(50)`,
    `ALTER TABLE players ADD COLUMN IF NOT EXISTS avatar_custom TEXT`,
    `ALTER TABLE matches  ADD COLUMN IF NOT EXISTS lp_change    INT`,
    `ALTER TABLE matches  ADD COLUMN IF NOT EXISTS first_blood  BOOLEAN NOT NULL DEFAULT false`,
    `ALTER TABLE matches  ADD COLUMN IF NOT EXISTS total_pings  INT NOT NULL DEFAULT 0`,
    `ALTER TABLE matches  ADD COLUMN IF NOT EXISTS surrendered  BOOLEAN NOT NULL DEFAULT false`,
    `ALTER TABLE matches  ADD COLUMN IF NOT EXISTS team          VARCHAR(50)`,
    `UPDATE matches m SET team = p.team FROM players p WHERE m.player_id = p.id AND m.team IS NULL`,
    `CREATE TABLE IF NOT EXISTS settings (key VARCHAR(50) PRIMARY KEY, value TEXT NOT NULL)`,
    `INSERT INTO settings (key, value) VALUES ('team_1', 'Équipe 1'), ('team_2', 'Équipe 2'), ('team_3', 'Équipe 3') ON CONFLICT DO NOTHING`,
    `ALTER TABLE players ADD COLUMN IF NOT EXISTS pending_lp INT NOT NULL DEFAULT 0`,
  ];
  for (const sql of migrations) {
    await pool.query(sql).catch((err) =>
      console.warn('[migration]', sql.slice(0, 60), '—', err.message)
    );
  }
  console.log('[soloq-backend] Migrations vérifiées.');
}

// ── Helpers ───────────────────────────────────────────────────

/** Clause ORDER BY selon le critère de tri demandé. */
function buildOrderBy(sort) {
  if (sort === 'winrate') {
    return `ROUND(wins::numeric / NULLIF(wins + losses, 0) * 100) DESC NULLS LAST`;
  }
  if (sort === 'wins') {
    return `wins DESC`;
  }
  if (sort === 'games') {
    return `(wins + losses) DESC`;
  }
  return `
    (CASE tier
      WHEN 'IRON'        THEN 0
      WHEN 'BRONZE'      THEN 400
      WHEN 'SILVER'      THEN 800
      WHEN 'GOLD'        THEN 1200
      WHEN 'PLATINUM'    THEN 1600
      WHEN 'EMERALD'     THEN 2000
      WHEN 'DIAMOND'     THEN 2400
      WHEN 'MASTER'      THEN 2800
      WHEN 'GRANDMASTER' THEN 2800
      WHEN 'CHALLENGER'  THEN 2800
      ELSE 0
    END
    +
    CASE division
      WHEN 'IV'  THEN 0
      WHEN 'III' THEN 100
      WHEN 'II'  THEN 200
      WHEN 'I'   THEN 300
      ELSE 0
    END
    + lp) DESC
  `;
}

// ── Routes ────────────────────────────────────────────────────

/** Health check (utilisé par Docker et les monitors externes). */
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok' });
});

/**
 * Liste des joueurs avec winrate calculé.
 * [RIOT-API] Remplacer/compléter par un refresh périodique depuis :
 *   GET /lol/league/v4/challengerleagues/by-queue/RANKED_SOLO_5x5
 *
 * Query params :
 *   sort   — 'lp' (défaut) | 'winrate' | 'wins'
 *   search — filtre sur le nom (ILIKE)
 */
app.get('/api/players', async (req, res) => {
  const sort   = ['lp', 'winrate', 'wins', 'games'].includes(req.query.sort)
    ? req.query.sort
    : 'lp';
  const search = typeof req.query.search === 'string' ? req.query.search : '';

  const sql = `
    SELECT
      id, name, tag, avatar, tier, division,
      lp, lp_delta, wins, losses,
      display_name, profile_url, team, avatar_custom,
      COALESCE(
        ROUND(wins::numeric / NULLIF(wins + losses, 0) * 100),
        0
      )::int AS winrate,
      (SELECT ROUND(AVG(lp_change))::int
         FROM (SELECT lp_change FROM matches
               WHERE player_id = players.id AND lp_change > 0
               ORDER BY played_at DESC LIMIT 20) t) AS avg_lp_gain,
      (SELECT ROUND(AVG(ABS(lp_change)))::int
         FROM (SELECT lp_change FROM matches
               WHERE player_id = players.id AND lp_change < 0
               ORDER BY played_at DESC LIMIT 20) t) AS avg_lp_loss
    FROM players
    WHERE name ILIKE $1 OR display_name ILIKE $1
    ORDER BY ${buildOrderBy(sort)}
  `;

  try {
    const { rows } = await pool.query(sql, [`%${search}%`]);
    res.json(rows);
  } catch (err) {
    console.error('[GET /api/players]', err.message);
    res.status(500).json({ error: 'Erreur base de données' });
  }
});

/**
 * Streak — 10 dernières parties (champion + résultat) pour tous les joueurs.
 * Utilisé par la colonne STREAK du classement.
 */
app.get('/api/players/streaks', async (_req, res) => {
  const sql = `
    SELECT player_id, result, champion
    FROM (
      SELECT player_id, result, champion,
             ROW_NUMBER() OVER (PARTITION BY player_id ORDER BY played_at DESC) AS rn
      FROM matches
    ) ranked
    WHERE rn <= 10
    ORDER BY player_id, rn
  `;
  try {
    const { rows } = await pool.query(sql);
    // Regroupe par player_id : { [id]: [{result, champion}, ...] }
    const byPlayer = {};
    for (const r of rows) {
      if (!byPlayer[r.player_id]) byPlayer[r.player_id] = [];
      byPlayer[r.player_id].push({ result: r.result, champion: r.champion });
    }
    res.json(byPlayer);
  } catch (err) {
    console.error('[GET /api/players/streaks]', err.message);
    res.status(500).json({ error: 'Erreur base de données' });
  }
});

/**
 * Historique des 10 dernières parties d'un joueur.
 * [RIOT-API] Remplacer par :
 *   GET /lol/match/v5/matches/by-puuid/{puuid}/ids?count=10
 *   puis GET /lol/match/v5/matches/{matchId} pour chaque partie
 */
app.get('/api/players/:id/matches', async (req, res) => {
  const playerId = parseInt(req.params.id, 10);
  if (!Number.isFinite(playerId)) {
    return res.status(400).json({ error: 'ID invalide' });
  }

  const sql = `
    SELECT id, result, champion, role,
           kills, deaths, assists, cs, duration, lp_change, played_at
    FROM matches
    WHERE player_id = $1
    ORDER BY played_at DESC
    LIMIT 10
  `;

  try {
    const { rows } = await pool.query(sql, [playerId]);
    res.json(rows);
  } catch (err) {
    console.error('[GET /api/players/:id/matches]', err.message);
    res.status(500).json({ error: 'Erreur base de données' });
  }
});

/**
 * Historique global de toutes les parties (tous joueurs confondus).
 * Query params :
 *   limit — nombre max de parties (défaut 500, max 2000)
 */
app.get('/api/matches', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 500, 2000);
  if (!Number.isFinite(limit) || limit < 1) {
    return res.status(400).json({ error: 'Paramètre limit invalide' });
  }

  const sql = `
    SELECT m.id, m.result, m.champion, m.role,
           m.kills, m.deaths, m.assists, m.cs, m.duration, m.lp_change, m.played_at,
           p.id AS player_id,
           COALESCE(p.display_name, p.name) AS player_name,
           p.avatar_custom
    FROM matches m
    JOIN players p ON m.player_id = p.id
    ORDER BY m.played_at DESC
    LIMIT $1
  `;

  try {
    const { rows } = await pool.query(sql, [limit]);
    res.json(rows);
  } catch (err) {
    console.error('[GET /api/matches]', err.message);
    res.status(500).json({ error: 'Erreur base de données' });
  }
});

/**
 * Hall of Fame — records sur une seule partie.
 */
app.get('/api/hall-of-fame', async (req, res) => {
  const sel = `
    m.id, m.result, m.champion, m.role,
    m.kills, m.deaths, m.assists, m.cs, m.duration, m.lp_change, m.played_at,
    p.id AS player_id,
    COALESCE(p.display_name, p.name) AS player_name,
    p.avatar_custom
  `;
  const durSec = `(
    COALESCE(NULLIF(SPLIT_PART(m.duration,'m',1),'')::int, 0) * 60 +
    COALESCE(NULLIF(REPLACE(SPLIT_PART(m.duration,'m',2),'s',''),'')::int, 0)
  )`;
  const cats = [
    { key: 'most_kills',    icon: '⚔️',  label: 'Plus de kills',         order: 'm.kills DESC NULLS LAST' },
    { key: 'most_deaths',   icon: '💀',  label: 'Plus de morts',         order: 'm.deaths DESC NULLS LAST' },
    { key: 'most_assists',  icon: '🤝',  label: "Plus d'assists",         order: 'm.assists DESC NULLS LAST' },
    { key: 'most_cs',       icon: '🌾',  label: 'Plus de CS',             order: 'm.cs DESC NULLS LAST' },
    { key: 'longest',       icon: '⏱️',  label: 'Partie la plus longue', order: `${durSec} DESC` },
    { key: 'best_lp',       icon: '📈',  label: 'Plus gros gain LP',     order: 'm.lp_change DESC NULLS LAST', where: 'm.lp_change IS NOT NULL' },
    { key: 'worst_lp',      icon: '📉',  label: 'Plus grosse perte LP',  order: 'm.lp_change ASC NULLS LAST',  where: 'm.lp_change IS NOT NULL' },
    { key: 'best_kda_game', icon: '🏅',  label: 'Meilleur KDA en 1 game',order: `(m.kills + m.assists)::numeric / NULLIF(m.deaths,0) DESC NULLS LAST` },
  ];

  try {
    const results = await Promise.all(cats.map(async (c) => {
      const where = c.where ? `AND ${c.where}` : '';
      const { rows } = await pool.query(`
        SELECT ${sel}
        FROM matches m
        JOIN players p ON m.player_id = p.id
        WHERE m.kills IS NOT NULL ${where}
        ORDER BY ${c.order}
        LIMIT 1
      `);
      if (!rows.length) return null;
      return { key: c.key, icon: c.icon, label: c.label, match: rows[0] };
    }));
    res.json(results.filter(Boolean));
  } catch (err) {
    console.error('[GET /api/hall-of-fame]', err.message);
    res.status(500).json({ error: 'Erreur base de données' });
  }
});

/**
 * Ajoute ou rafraîchit un joueur par son Riot ID.
 * Body JSON : { riotId, displayName, profileUrl, team }
 */
app.post('/api/players/add', async (req, res) => {
  const { riotId, displayName, profileUrl, team, avatarCustom } = req.body || {};

  const raw = typeof riotId === 'string' ? riotId.trim() : '';
  const sep = raw.lastIndexOf('#');
  if (sep < 1) {
    return res.status(400).json({ error: 'Format invalide. Attendu : Nom#TAG' });
  }
  const gameName = raw.slice(0, sep).trim();
  const tagLine  = raw.slice(sep + 1).trim();
  if (!gameName || !tagLine) {
    return res.status(400).json({ error: 'Nom ou TAG vide' });
  }

  // Validation URL profil
  const safeUrl = typeof profileUrl === 'string' ? profileUrl.trim() : '';
  if (safeUrl && !safeUrl.startsWith('https://') && !safeUrl.startsWith('http://')) {
    return res.status(400).json({ error: 'URL de profil invalide (doit commencer par https://)' });
  }

  // Validation longueur
  const safeDisplayName = typeof displayName === 'string' ? displayName.trim().slice(0, 100) : null;
  const safeTeam        = typeof team === 'string'        ? team.trim().slice(0, 50)         : null;
  // Validation avatar : doit être un data URL image, max ~400 Ko base64
  const rawAvatar  = typeof avatarCustom === 'string' ? avatarCustom.trim() : '';
  const safeAvatar = rawAvatar.startsWith('data:image/') ? rawAvatar.slice(0, 450_000) : null;

  try {
    let playerId;

    if (process.env.RIOT_API_KEY) {
      // Mode Riot API : sync des données ranked
      const result = await syncSinglePlayer(pool, gameName, tagLine);
      playerId = result.playerId;
    } else {
      // Mode manuel : insertion basique sans données ranked
      const existing = await pool.query(
        'SELECT id FROM players WHERE LOWER(name)=$1 AND LOWER(tag)=$2',
        [gameName.toLowerCase(), `#${tagLine}`.toLowerCase()]
      );
      if (existing.rows.length > 0) {
        playerId = existing.rows[0].id;
      } else {
        const ins = await pool.query(
          `INSERT INTO players (name, tag, avatar, tier, lp, lp_delta, wins, losses)
           VALUES ($1, $2, '🎮', 'UNRANKED', 0, 0, 0, 0) RETURNING id`,
          [gameName, `#${tagLine}`]
        );
        playerId = ins.rows[0].id;
      }
    }

    // Mise à jour des métadonnées supplémentaires
    await pool.query(
      `UPDATE players
         SET display_name  = COALESCE($1, display_name),
             profile_url   = COALESCE($2, profile_url),
             team          = COALESCE($3, team),
             avatar_custom = COALESCE($4, avatar_custom)
       WHERE id = $5`,
      [safeDisplayName || null, safeUrl || null, safeTeam || null, safeAvatar || null, playerId]
    );

    res.json({ ok: true, playerId });
  } catch (err) {
    console.error('[POST /api/players/add]', err.message);
    const status = err.message.includes('404') ? 404 : 500;
    res.status(status).json({ error: err.message });
  }
});

/**
 * Met à jour les métadonnées d'un joueur existant.
 * Body JSON : { displayName, profileUrl, team, avatarCustom?, clearAvatar?, riotName?, riotTag? }
 */
app.put('/api/players/:id', async (req, res) => {
  const playerId = parseInt(req.params.id, 10);
  if (!Number.isFinite(playerId)) {
    return res.status(400).json({ error: 'ID invalide' });
  }

  const { displayName, profileUrl, team, avatarCustom, clearAvatar, riotName, riotTag } = req.body || {};

  const safeUrl = typeof profileUrl === 'string' ? profileUrl.trim() : '';
  if (safeUrl && !safeUrl.startsWith('https://') && !safeUrl.startsWith('http://')) {
    return res.status(400).json({ error: 'URL de profil invalide (doit commencer par https://)' });
  }

  const safeDisplayName = typeof displayName === 'string' ? displayName.trim().slice(0, 100) : null;
  const safeTeam        = typeof team        === 'string' ? team.trim().slice(0, 50)          : null;
  const safeRiotName    = typeof riotName    === 'string' ? riotName.trim().slice(0, 80)       : null;
  const safeRiotTag     = typeof riotTag     === 'string' ? riotTag.trim().slice(0, 20)        : null;

  try {
    const check = await pool.query('SELECT id FROM players WHERE id=$1', [playerId]);
    if (check.rows.length === 0) return res.status(404).json({ error: 'Joueur introuvable' });

    const sets   = ['display_name=$1', 'profile_url=$2', 'team=$3'];
    const params = [safeDisplayName || null, safeUrl || null, safeTeam || null];

    if (clearAvatar === true) {
      sets.push('avatar_custom=NULL');
    } else if (typeof avatarCustom === 'string' && avatarCustom.startsWith('data:image/')) {
      sets.push(`avatar_custom=$${params.length + 1}`);
      params.push(avatarCustom.slice(0, 450_000));
    }

    if (safeRiotName) {
      sets.push(`name=$${params.length + 1}`);
      params.push(safeRiotName);
    }
    if (safeRiotTag) {
      sets.push(`tag=$${params.length + 1}`);
      params.push(safeRiotTag.startsWith('#') ? safeRiotTag : `#${safeRiotTag}`);
    }

    params.push(playerId);
    await pool.query(
      `UPDATE players SET ${sets.join(', ')} WHERE id=$${params.length}`,
      params
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[PUT /api/players/:id]', err.message);
    res.status(500).json({ error: 'Erreur base de données' });
  }
});

/**
 * Supprime un joueur et ses matchs (CASCADE).
 */
app.delete('/api/players/:id', async (req, res) => {
  const playerId = parseInt(req.params.id, 10);
  if (!Number.isFinite(playerId)) {
    return res.status(400).json({ error: 'ID invalide' });
  }
  try {
    const { rowCount } = await pool.query('DELETE FROM players WHERE id=$1', [playerId]);
    if (rowCount === 0) return res.status(404).json({ error: 'Joueur introuvable' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[DELETE /api/players/:id]', err.message);
    res.status(500).json({ error: 'Erreur base de données' });
  }
});

/**
 * Déclenche manuellement une synchronisation depuis l'API Riot.
 * Retourne 202 immédiatement ; 409 si un sync est déjà en cours.
 * Exemple : curl -X POST http://localhost:3000/api/sync
 */
app.post('/api/sync', (_req, res) => {
  if (!process.env.RIOT_API_KEY) {
    return res.status(400).json({ error: 'RIOT_API_KEY non configurée' });
  }
  if (syncState.running) {
    return res.status(409).json({ error: 'Sync déjà en cours', ...syncStatePublic() });
  }
  runSync();
  res.status(202).json({ ok: true, message: 'Sync démarré en arrière-plan', ...syncStatePublic() });
});

/**
 * Statistiques agrégées : kills, morts, first bloods, pings, FF, parties, équipes.
 */
app.get('/api/stats', async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        p.id,
        COALESCE(p.display_name, p.name)                                   AS display_name,
        p.avatar,
        p.avatar_custom,
        p.team,
        p.wins,
        p.losses,
        (p.wins + p.losses)                                                 AS games,
        COALESCE(ROUND(p.wins::numeric / NULLIF(p.wins+p.losses,0)*100),0)::int AS winrate,
        COALESCE(SUM(m.kills),   0)::int                                    AS total_kills,
        COALESCE(ROUND(AVG(m.kills)::numeric,   1), 0)::numeric             AS avg_kills,
        COALESCE(SUM(m.deaths),  0)::int                                    AS total_deaths,
        COALESCE(ROUND(AVG(m.deaths)::numeric,  1), 0)::numeric             AS avg_deaths,
        COALESCE(SUM(m.assists), 0)::int                                    AS total_assists,
        COALESCE(SUM(CASE WHEN m.first_blood THEN 1 ELSE 0 END), 0)::int    AS first_bloods,
        COALESCE(SUM(m.total_pings), 0)::int                                AS total_pings_sum,
        COALESCE(ROUND(AVG(
          CASE WHEN m.total_pings > 0 THEN m.total_pings::numeric END
        )), 0)::int                                                         AS avg_pings,
        COALESCE(SUM(CASE WHEN m.surrendered THEN 1 ELSE 0 END), 0)::int    AS surrendered_games,
        COUNT(m.id)::int                                                    AS match_count,
        COALESCE(ROUND(AVG(
          (m.kills + m.assists)::numeric / NULLIF(m.deaths, 0)
        )::numeric, 2), 0)::numeric                                         AS avg_kda
      FROM players p
      LEFT JOIN matches m ON m.player_id = p.id
      GROUP BY p.id, p.display_name, p.name, p.avatar, p.avatar_custom,
               p.team, p.wins, p.losses
      ORDER BY (p.wins + p.losses) DESC
    `);

    const totalGames  = rows.reduce((s, p) => s + Number(p.games), 0);
    const totalKills  = rows.reduce((s, p) => s + Number(p.total_kills), 0);
    const totalDeaths   = rows.reduce((s, p) => s + Number(p.total_deaths), 0);
    const totalAssists  = rows.reduce((s, p) => s + Number(p.total_assists), 0);
    const matchesStored = rows.reduce((s, p) => s + Number(p.match_count), 0);
    const avgKillsGlobal = matchesStored > 0
      ? (totalKills / matchesStored).toFixed(1)
      : '0.0';
    const avgKdaGlobal = totalDeaths > 0
      ? ((totalKills + totalAssists) / totalDeaths).toFixed(2)
      : '0.00';

    const teamMap = {};
    rows.forEach((p) => {
      const team = p.team || null;
      if (!team) return;
      if (!teamMap[team]) teamMap[team] = { name: team, wins: 0, losses: 0, players: [] };
      teamMap[team].wins   += Number(p.wins);
      teamMap[team].losses += Number(p.losses);
      teamMap[team].players.push(p.display_name);
    });
    const teams = Object.values(teamMap).map((t) => ({
      ...t,
      games:   t.wins + t.losses,
      winrate: t.wins + t.losses > 0
        ? Math.round(t.wins / (t.wins + t.losses) * 100)
        : 0,
    })).sort((a, b) => b.winrate - a.winrate);

    res.json({ global: { totalGames, totalKills, avgKillsGlobal, avgKdaGlobal, matchesStored }, players: rows, teams });
  } catch (err) {
    console.error('[GET /api/stats]', err.message);
    res.status(500).json({ error: 'Erreur base de données' });
  }
});

/** Progression LP cumulée par joueur et par équipe. */
app.get('/api/stats/lp-progression', async (_req, res) => {
  try {
    // Constantes LPT — identiques à calcLPT() frontend et calcLpt() riot.js
    const TIER_BASE = { IRON:0, BRONZE:400, SILVER:800, GOLD:1200, PLATINUM:1600, EMERALD:2000, DIAMOND:2400, MASTER:2800, GRANDMASTER:2800, CHALLENGER:2800 };
    const DIV_OFF   = { IV:0, III:100, II:200, I:300 };
    const lpt = (tier, div, lp) => (TIER_BASE[tier] ?? 0) + (DIV_OFF[div] ?? 0) + Number(lp || 0);

    // LPT actuel de chaque joueur
    const { rows: players } = await pool.query(
      `SELECT id, COALESCE(display_name, name) AS name, team, tier, division, lp FROM players`
    );
    const playerLptNow  = Object.fromEntries(players.map(p => [p.id, lpt(p.tier, p.division, p.lp)]));
    const playerTeamNow = Object.fromEntries(players.map(p => [p.id, p.team || '']));

    // Parties triées par date ASC avec lp_change connu — on inclut played_at
    const { rows } = await pool.query(`
      SELECT m.player_id, p.display_name, COALESCE(m.team, p.team) AS team,
             m.lp_change,
             to_char(m.played_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day
      FROM matches m
      JOIN players p ON m.player_id = p.id
      WHERE m.lp_change IS NOT NULL
      ORDER BY m.played_at ASC
    `);

    // Somme totale des lp_change par joueur → point de départ = lpt_actuel - somme
    const sumPlayer = {};
    for (const r of rows) sumPlayer[r.player_id] = (sumPlayer[r.player_id] || 0) + Number(r.lp_change);

    // Accumulation par joueur avec date — on garde le dernier LPT de chaque jour
    const playerMap = new Map();
    for (const r of rows) {
      if (!playerMap.has(r.player_id)) {
        const cur   = playerLptNow[r.player_id] ?? 0;
        const start = cur - (sumPlayer[r.player_id] || 0);
        playerMap.set(r.player_id, { name: r.display_name, team: r.team || '', running: start, data: [Math.round(start)] });
      }
      const p = playerMap.get(r.player_id);
      p.running += Number(r.lp_change);
      p.data.push(Math.round(p.running));
    }
    // Joueurs sans aucune partie → juste leur LPT actuel
    for (const p of players) {
      if (!playerMap.has(p.id)) {
        playerMap.set(p.id, { name: p.name, team: p.team || '', data: [playerLptNow[p.id]] });
      }
    }

    // LPT actuel par équipe = somme des LPT des joueurs actuellement dans l'équipe
    const teamLptNow = {};
    for (const p of players) {
      if (!p.team) continue;
      teamLptNow[p.team] = (teamLptNow[p.team] || 0) + playerLptNow[p.id];
    }
    const sumTeam = {};
    for (const r of rows) {
      const t = r.team || 'Sans équipe';
      sumTeam[t] = (sumTeam[t] || 0) + Number(r.lp_change);
    }

    const teamMap = new Map();
    for (const r of rows) {
      const team = r.team || 'Sans équipe';
      if (!teamMap.has(team)) {
        const cur   = teamLptNow[team] ?? 0;
        const start = cur - (sumTeam[team] || 0);
        teamMap.set(team, { name: team, running: start, data: [] });
      }
      const t = teamMap.get(team);
      t.running += Number(r.lp_change);
      const last = t.data[t.data.length - 1];
      if (last && last.date === r.day) {
        last.lp = Math.round(t.running);
      } else {
        t.data.push({ date: r.day, lp: Math.round(t.running) });
      }
    }

    res.json({
      byPlayer: [...playerMap.values()].map(({ name, team, data }) => ({ name, team, data })),
      byTeam:   [...teamMap.values()].map(({ name, data }) => ({ name, data })),
    });
  } catch (err) {
    console.error('[GET /api/stats/lp-progression]', err.message);
    res.status(500).json({ error: 'Erreur base de données' });
  }
});

// ── Live game — cache mis à jour par le job background ────────
const liveCache = { data: {}, lastUpdated: null };

/** Lecture instantanée du cache — aucun appel Riot au moment de la requête. */
app.get('/api/live', (_req, res) => {
  res.json(liveCache.data);
});

/** État du sync périodique (utile pour le frontend). */
app.get('/api/status', (_req, res) => {
  res.json({
    syncRunning:    syncState.running,
    lastSync:       syncState.lastSync,
    lastError:      syncState.lastError,
    syncIntervalMs: SYNC_INTERVAL_MS,
  });
});

/** Retourne les noms des 3 équipes. */
app.get('/api/teams', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT key, value FROM settings WHERE key IN ('team_1','team_2','team_3') ORDER BY key"
    );
    const map = {};
    rows.forEach(r => { map[r.key] = r.value; });
    res.json({
      team1: map['team_1'] || 'Équipe 1',
      team2: map['team_2'] || 'Équipe 2',
      team3: map['team_3'] || 'Équipe 3',
    });
  } catch (err) {
    console.error('[GET /api/teams]', err.message);
    res.status(500).json({ error: 'Erreur base de données' });
  }
});

/** Met à jour les noms des 3 équipes (et renomme les joueurs concernés). */
app.put('/api/teams', async (req, res) => {
  const { team1, team2, team3 } = req.body || {};
  const names = [team1, team2, team3].map(t =>
    typeof t === 'string' ? t.trim().slice(0, 50) : ''
  );
  if (names.some(n => !n)) {
    return res.status(400).json({ error: 'Les 3 noms sont requis' });
  }

  try {
    // Lire les anciens noms pour migrer les joueurs
    const { rows } = await pool.query(
      "SELECT key, value FROM settings WHERE key IN ('team_1','team_2','team_3') ORDER BY key"
    );
    const old = {};
    rows.forEach(r => { old[r.key] = r.value; });

    const pairs = [
      ['team_1', names[0]],
      ['team_2', names[1]],
      ['team_3', names[2]],
    ];

    for (const [key, newName] of pairs) {
      const oldName = old[key];
      if (oldName && oldName !== newName) {
        await pool.query('UPDATE players SET team=$1 WHERE team=$2', [newName, oldName]);
      }
      await pool.query(
        "INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value=$2",
        [key, newName]
      );
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('[PUT /api/teams]', err.message);
    res.status(500).json({ error: 'Erreur base de données' });
  }
});

// ── Joueurs par défaut ────────────────────────────────────────

const DEFAULT_PLAYERS = [
  { gameName: 'pzzzang3',        tagLine: '2173' },
  { gameName: 'IRL yuumi',       tagLine: 'meow' },
  { gameName: 'FOUTU POUR FOUTU', tagLine: 'SMC' },
];

async function ensureDefaultPlayers() {
  if (!process.env.RIOT_API_KEY) return;
  for (const { gameName, tagLine } of DEFAULT_PLAYERS) {
    const { rows } = await pool.query(
      'SELECT 1 FROM players WHERE LOWER(name)=$1 AND tag=$2',
      [gameName.toLowerCase(), `#${tagLine}`]
    );
    if (rows.length === 0) {
      console.log(`[soloq-backend] Ajout joueur par défaut : ${gameName}#${tagLine}`);
      await syncSinglePlayer(pool, gameName, tagLine).catch((err) =>
        console.error(`[soloq-backend] Échec ${gameName}#${tagLine}:`, err.message)
      );
    }
  }
}

// ── Sync périodique ─────────────────────────────────────────────────────────

const SYNC_INTERVAL_MS = parseInt(process.env.RIOT_SYNC_INTERVAL_MS || String(30 * 60 * 1000), 10);

const syncState = { running: false, lastSync: null, lastError: null };

function syncStatePublic() {
  return { syncRunning: syncState.running, lastSync: syncState.lastSync, lastError: syncState.lastError };
}

async function runLiveRefresh() {
  try {
    liveCache.data = await refreshAllLiveGames(pool, liveCache.data);
    liveCache.lastUpdated = new Date().toISOString();
    const inGame = Object.entries(liveCache.data)
      .filter(([, v]) => v?.champion)
      .map(([k, v]) => `${k}:${v.champion}`);
    console.log('[live-game] Rafraîchi —', inGame.length ? inGame.join(', ') : 'personne en jeu');
  } catch (err) {
    console.error('[live-game] Erreur :', err.message);
  }
}

async function runSync() {
  if (syncState.running) return;
  syncState.running   = true;
  syncState.lastError = null;
  try {
    await syncTrackedPlayers(pool);
    syncState.lastSync = new Date().toISOString();
  } catch (err) {
    syncState.lastError = err.message;
    console.error('[soloq-backend] Sync error:', err.message);
  } finally {
    syncState.running = false;
  }
  // Live refresh juste après le sync — séquentiel, jamais concurrent
  await runLiveRefresh();
}

// ── Démarrage ─────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`[soloq-backend] Running on port ${PORT}`);

  await ensureMigrations().catch((err) =>
    console.error('[soloq-backend] Migration error:', err.message)
  );

  if (process.env.RIOT_API_KEY) {
    console.log(`[soloq-backend] Sync périodique toutes les ${SYNC_INTERVAL_MS / 1000}s`);
    setTimeout(async () => {
      await ensureDefaultPlayers();
      await runSync(); // inclut le live refresh à la fin
    }, 10_000);
    setInterval(runSync, SYNC_INTERVAL_MS);
  } else {
    console.warn('[soloq-backend] RIOT_API_KEY absente — sync désactivé');
  }
});
