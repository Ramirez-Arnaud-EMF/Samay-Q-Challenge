/**
 * backend/riot.js — Client Riot API + synchronisation DB
 *
 * Flux syncChallenger :
 *  1. Challenger league → puuid, LP, wins, losses  (summonerId supprimé par Riot)
 *  2. Riot Account      → gameName + tagLine
 *  3. Match IDs         → 10 derniers ranked
 *  4. Match detail      → champion, rôle, KDA, CS, durée
 *
 * Flux syncSinglePlayer :
 *  1. Account by Riot ID → puuid
 *  2. Summoner by puuid  → summonerId (pour les ranked entries)
 *  3. Ranked entries     → tier, division, LP, wins, losses
 *  4. Match IDs + détails
 */

'use strict';

const https = require('https');

const API_KEY  = process.env.RIOT_API_KEY   || '';
const PLATFORM = process.env.RIOT_PLATFORM  || 'euw1';
const REGION   = process.env.RIOT_REGION    || 'europe';
const TOP_N    = parseInt(process.env.RIOT_TOP_N    || '10',   10);
const DELAY_MS = parseInt(process.env.RIOT_DELAY_MS || '1300', 10);

const ROLE_MAP = {
  TOP:     'Top',
  JUNGLE:  'Jungle',
  MIDDLE:  'Mid',
  BOTTOM:  'ADC',
  UTILITY: 'Support',
};

const TIER_EMOJI = {
  CHALLENGER: '🏆', GRANDMASTER: '💎', MASTER: '🔮',
  DIAMOND: '💠', EMERALD: '🟢', PLATINUM: '🔷',
  GOLD: '🥇', SILVER: '🥈', BRONZE: '🥉', IRON: '⚙',
};

// LP Total — même logique que calcLPT() dans le frontend
const TIER_BASE_LP = {
  IRON: 0, BRONZE: 400, SILVER: 800, GOLD: 1200,
  PLATINUM: 1600, EMERALD: 2000, DIAMOND: 2400,
  MASTER: 2800, GRANDMASTER: 2800, CHALLENGER: 2800,
};
const DIV_OFFSET_LP = { IV: 0, III: 100, II: 200, I: 300 };

function calcLpt(tier, division, lp) {
  return (TIER_BASE_LP[tier] ?? 0) + (DIV_OFFSET_LP[division] ?? 0) + Number(lp || 0);
}

// ── Helpers ───────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Requête HTTPS vers l'API Riot avec gestion d'erreur. */
function riotGet(host, path) {
  return new Promise((resolve, reject) => {
    https.get(
      { hostname: host, path, headers: { 'X-Riot-Token': API_KEY } },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => {
          if (res.statusCode === 429) return reject(new Error('Rate limited (429)'));
          if (res.statusCode === 403) return reject(new Error('API key invalide ou expirée (403)'));
          if (res.statusCode === 404) return reject(new Error(`Ressource introuvable (404): ${path}`));
          if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}: ${path}`));
          try { resolve(JSON.parse(raw)); } catch (e) { reject(e); }
        });
      }
    ).on('error', reject);
  });
}

// ── Endpoints Riot API ────────────────────────────────────────

async function fetchChallengerLeague() {
  return riotGet(
    `${PLATFORM}.api.riotgames.com`,
    `/lol/league/v4/challengerleagues/by-queue/RANKED_SOLO_5x5`
  );
}

async function fetchSummoner(summonerId) {
  await sleep(DELAY_MS);
  return riotGet(
    `${PLATFORM}.api.riotgames.com`,
    `/lol/summoner/v4/summoners/${encodeURIComponent(summonerId)}`
  );
}

async function fetchSummonerByPuuid(puuid) {
  await sleep(DELAY_MS);
  return riotGet(
    `${PLATFORM}.api.riotgames.com`,
    `/lol/summoner/v4/summoners/by-puuid/${encodeURIComponent(puuid)}`
  );
}

async function fetchAccountByRiotId(gameName, tagLine) {
  await sleep(DELAY_MS);
  return riotGet(
    `${REGION}.api.riotgames.com`,
    `/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(gameName)}/${encodeURIComponent(tagLine)}`
  );
}

// Déprécié par Riot mais accessible avec dev key (contrairement à by-riot-id)
async function fetchSummonerByName(name) {
  await sleep(DELAY_MS);
  return riotGet(
    `${PLATFORM}.api.riotgames.com`,
    `/lol/summoner/v4/summoners/by-name/${encodeURIComponent(name)}`
  );
}

async function fetchRiotAccount(puuid) {
  await sleep(DELAY_MS);
  return riotGet(
    `${REGION}.api.riotgames.com`,
    `/riot/account/v1/accounts/by-puuid/${encodeURIComponent(puuid)}`
  );
}

async function fetchRankedEntriesByPuuid(puuid) {
  await sleep(DELAY_MS);
  return riotGet(
    `${PLATFORM}.api.riotgames.com`,
    `/lol/league/v4/entries/by-puuid/${encodeURIComponent(puuid)}`
  );
}

async function fetchRankedEntries(summonerId) {
  await sleep(DELAY_MS);
  return riotGet(
    `${PLATFORM}.api.riotgames.com`,
    `/lol/league/v4/entries/by-summoner/${encodeURIComponent(summonerId)}`
  );
}

async function fetchMatchIds(puuid) {
  await sleep(DELAY_MS);
  return riotGet(
    `${REGION}.api.riotgames.com`,
    `/lol/match/v5/matches/by-puuid/${encodeURIComponent(puuid)}/ids?type=ranked&count=10`
  );
}

async function fetchMatch(matchId) {
  await sleep(DELAY_MS);
  return riotGet(
    `${REGION}.api.riotgames.com`,
    `/lol/match/v5/matches/${encodeURIComponent(matchId)}`
  );
}

// ── Sync principal ────────────────────────────────────────────

/**
 * Synchronise les TOP_N challengers + leurs 10 derniers matchs dans la DB.
 * Retourne un rapport { playersUpdated, matchesAdded, skipped, errors }.
 */
async function syncChallenger(pool) {
  if (!API_KEY) throw new Error('RIOT_API_KEY non définie');

  const report = { playersUpdated: 0, matchesAdded: 0, skipped: 0, errors: [] };

  // 1. Top N joueurs du classement Challenger
  const league  = await fetchChallengerLeague();
  const entries = league.entries
    .sort((a, b) => b.leaguePoints - a.leaguePoints)
    .slice(0, TOP_N);

  console.log(`[riot-sync] ${entries.length} joueurs à synchroniser…`);

  for (const entry of entries) {
    try {
      // puuid disponible directement dans l'entrée (summonerId supprimé par Riot en 2024)
      const puuid = entry.puuid;

      // Riot Account → gameName + tagLine
      const account = await fetchRiotAccount(puuid);
      const name    = account.gameName || 'Unknown';
      const tag     = `#${account.tagLine || 'EUW'}`;
      const avatar  = TIER_EMOJI['CHALLENGER'];

      // lp_delta par rapport à la valeur précédente en DB (en LPT pour gérer les promotions)
      const prev    = await pool.query('SELECT lp, tier, division FROM players WHERE riot_puuid=$1', [puuid]);
      const prevLpt = prev.rows[0]
        ? calcLpt(prev.rows[0].tier, prev.rows[0].division, prev.rows[0].lp)
        : calcLpt('CHALLENGER', null, entry.leaguePoints);
      const lpDelta = calcLpt('CHALLENGER', null, entry.leaguePoints) - prevLpt;

      const upsert = await pool.query(
        `INSERT INTO players
           (name, tag, avatar, tier, division, lp, lp_delta, wins, losses, riot_puuid)
         VALUES ($1,$2,$3,'CHALLENGER',NULL,$4,$5,$6,$7,$8)
         ON CONFLICT (riot_puuid) DO UPDATE SET
           name=EXCLUDED.name, tag=EXCLUDED.tag,
           lp=EXCLUDED.lp, lp_delta=$5,
           wins=EXCLUDED.wins, losses=EXCLUDED.losses,
           updated_at=NOW()
         RETURNING id`,
        [name, tag, avatar, entry.leaguePoints, lpDelta, entry.wins, entry.losses, puuid]
      );

      const playerId = upsert.rows[0].id;
      report.playersUpdated++;
      console.log(`[riot-sync] ✓ ${name}${tag} (id=${playerId})`);

      const added = await upsertPlayerMatches(pool, playerId, puuid, lpDelta);
      report.matchesAdded += added;
    } catch (err) {
      console.error(`[riot-sync] ✗ ${entry.puuid?.slice(0, 8)}:`, err.message);
      report.errors.push({ puuid: entry.puuid, error: err.message });
    }
  }

  console.log('[riot-sync] Terminé :', report);
  return report;
}

/** Réutilisée par syncChallenger et syncSinglePlayer. */
async function upsertPlayerMatches(pool, playerId, puuid, lpDelta = 0) {
  // Snapshot the player's current team so historical matches stay tied to it
  const { rows: pRows } = await pool.query('SELECT team FROM players WHERE id=$1', [playerId]);
  const playerTeam = pRows[0]?.team || null;

  const matchIds = await fetchMatchIds(puuid);

  // First pass: collect data for all new matches
  const newMatchData = [];
  for (const matchId of matchIds) {
    const exists = await pool.query(
      'SELECT 1 FROM matches WHERE riot_match_id=$1 AND player_id=$2',
      [matchId, playerId]
    );
    if (exists.rows.length > 0) continue;

    const match = await fetchMatch(matchId);
    const info  = match.info;
    const me    = info.participants.find((p) => p.puuid === puuid);
    if (!me) continue;

    const totalSec = info.gameDuration;
    const duration = `${Math.floor(totalSec / 60)}m${(totalSec % 60).toString().padStart(2, '0')}s`;
    const cs = (me.totalMinionsKilled || 0) + (me.neutralMinionsKilled || 0);

    const PING_FIELDS = [
      'allInPings', 'assistMePings', 'baitPings', 'commandPings', 'dangerPings',
      'enemyMissingPings', 'enemyVisionPings', 'getBackPings', 'holdPings',
      'needVisionPings', 'onMyWayPings', 'pushPings', 'visionClearedPings',
    ];
    const totalPings = PING_FIELDS.reduce((s, f) => s + (me[f] || 0), 0);

    newMatchData.push({
      matchId,
      result:     me.win ? 'win' : 'loss',
      champion:   me.championName,
      role:       ROLE_MAP[me.teamPosition] || me.teamPosition || 'Unknown',
      kills: me.kills, deaths: me.deaths, assists: me.assists,
      cs, duration,
      playedAt:   new Date(info.gameStartTimestamp),
      firstBlood:  me.firstBloodKill         || false,
      totalPings,
      surrendered: me.gameEndedInSurrender   || false,
    });
  }

  // Calculate LP change per match based on the sync delta
  // Only assign when all new matches have the same result (pure win or pure loss streak)
  // — mixed results can't be split accurately without per-game LP data from the API
  const newWins   = newMatchData.filter((m) => m.result === 'win').length;
  const newLosses = newMatchData.filter((m) => m.result === 'loss').length;

  let lpPerWin = null, lpPerLoss = null;
  if (newMatchData.length > 0 && lpDelta !== 0) {
    if (newWins > 0 && newLosses === 0) {
      lpPerWin = Math.round(lpDelta / newWins);
    } else if (newLosses > 0 && newWins === 0) {
      lpPerLoss = Math.abs(Math.round(lpDelta / newLosses));
    }
    // Mixed results → cannot determine individual LP changes accurately
  }

  // Second pass: insert with lp_change values
  let added = 0;
  for (const m of newMatchData) {
    const lpChange = m.result === 'win'
      ? (lpPerWin  !== null ? lpPerWin   : null)
      : (lpPerLoss !== null ? -lpPerLoss : null);

    await pool.query(
      `INSERT INTO matches
         (player_id, riot_match_id, result, champion, role, kills, deaths, assists, cs, duration, played_at, lp_change, first_blood, total_pings, surrendered, team)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       ON CONFLICT (riot_match_id, player_id) DO NOTHING`,
      [
        playerId, m.matchId, m.result, m.champion, m.role,
        m.kills, m.deaths, m.assists, m.cs, m.duration, m.playedAt,
        lpChange, m.firstBlood, m.totalPings, m.surrendered, playerTeam,
      ]
    );
    added++;
  }
  return added;
}

/**
 * Ajoute ou met à jour un joueur spécifique par son Riot ID (gameName#tagLine).
 * Fonctionne pour n'importe quel rang (pas uniquement Challenger).
 */
async function syncSinglePlayer(pool, gameName, tagLine) {
  if (!API_KEY) throw new Error('RIOT_API_KEY non définie');

  // 1. Riot Account → puuid (by-riot-id fonctionne avec dev key)
  const account = await fetchAccountByRiotId(gameName, tagLine);
  const puuid   = account.puuid;

  // 2. Ranked entries by puuid (pas besoin de summonerId)
  const entries = await fetchRankedEntriesByPuuid(puuid);
  const solo    = entries.find((e) => e.queueType === 'RANKED_SOLO_5x5');

  const tier     = solo?.tier         || 'UNRANKED';
  const division = solo?.rank         || null;
  const lp       = solo?.leaguePoints || 0;
  const wins     = solo?.wins         || 0;
  const losses   = solo?.losses       || 0;
  const avatar   = TIER_EMOJI[tier]   || '🎮';

  // 3. lp_delta en LPT pour gérer les promotions/rétrogradations
  const prev    = await pool.query('SELECT lp, tier, division FROM players WHERE riot_puuid=$1', [puuid]);
  const prevLpt = prev.rows[0]
    ? calcLpt(prev.rows[0].tier, prev.rows[0].division, prev.rows[0].lp)
    : calcLpt(tier, division, lp);
  const lpDelta = calcLpt(tier, division, lp) - prevLpt;

  // 4. Upsert joueur
  const upsert = await pool.query(
    `INSERT INTO players
       (name, tag, avatar, tier, division, lp, lp_delta, wins, losses, riot_puuid)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (riot_puuid) DO UPDATE SET
       name=EXCLUDED.name, tag=EXCLUDED.tag, avatar=EXCLUDED.avatar,
       tier=EXCLUDED.tier, division=EXCLUDED.division,
       lp=EXCLUDED.lp, lp_delta=$7,
       wins=EXCLUDED.wins, losses=EXCLUDED.losses,
       updated_at=NOW()
     RETURNING id`,
    [gameName, `#${tagLine}`, avatar, tier, division, lp, lpDelta, wins, losses, puuid]
  );

  const playerId    = upsert.rows[0].id;
  const matchesAdded = await upsertPlayerMatches(pool, playerId, puuid, lpDelta);

  return { playerId, name: gameName, tag: `#${tagLine}`, tier, lp, matchesAdded };
}

/**
 * Rafraîchit uniquement les joueurs déjà présents en DB.
 * Utilisé par le sync périodique — aucun nouveau joueur n'est importé.
 */
async function syncTrackedPlayers(pool) {
  if (!API_KEY) throw new Error('RIOT_API_KEY non définie');

  const { rows } = await pool.query(
    'SELECT id, name, tag, riot_puuid, pending_lp FROM players WHERE riot_puuid IS NOT NULL ORDER BY id'
  );
  const report = { playersUpdated: 0, matchesAdded: 0, errors: [] };

  console.log(`[riot-sync] ${rows.length} joueur(s) suivi(s) à synchroniser…`);

  for (const player of rows) {
    try {
      const puuid   = player.riot_puuid;
      const entries = await fetchRankedEntriesByPuuid(puuid);
      const solo    = entries.find((e) => e.queueType === 'RANKED_SOLO_5x5');

      const tier     = solo?.tier         || 'UNRANKED';
      const division = solo?.rank         || null;
      const lp       = solo?.leaguePoints || 0;
      const wins     = solo?.wins         || 0;
      const losses   = solo?.losses       || 0;
      const avatar   = TIER_EMOJI[tier]   || '🎮';

      const prev    = await pool.query('SELECT lp, tier, division FROM players WHERE id=$1', [player.id]);
      const prevLpt = prev.rows[0]
        ? calcLpt(prev.rows[0].tier, prev.rows[0].division, prev.rows[0].lp)
        : calcLpt(tier, division, lp);
      const lpDelta = calcLpt(tier, division, lp) - prevLpt;

      // pending_lp : accumule le delta LP quand le match n'est pas encore indexé
      // par l'API Riot (délai de 5-15 min après la fin de partie).
      const pendingLp      = Number(player.pending_lp || 0);
      const effectiveDelta = lpDelta + pendingLp;

      // Attribution du lp_change par partie :
      // - Cas pur pending (lpDelta=0) : on utilise pendingLp → correct
      // - Cas normal (pendingLp=0)    : on utilise lpDelta   → correct
      // - Cas mixte (les deux ≠ 0)   : on n'utilise QUE lpDelta pour éviter
      //   de contaminer les nouvelles parties avec le LP en attente des anciennes
      const deltaForAttribution = (lpDelta !== 0 && pendingLp !== 0)
        ? lpDelta
        : effectiveDelta;

      // Optimisation taux limite : ne chercher les matchs que si le LP a changé
      // ou s'il reste un delta en attente (évite 1 appel API inutile par joueur par sync)
      let added = 0;
      if (effectiveDelta !== 0) {
        added = await upsertPlayerMatches(pool, player.id, puuid, deltaForAttribution);
      }

      // Si aucun nouveau match trouvé ET qu'on a détecté un changement LP :
      // garder le delta en attente pour le prochain sync.
      const newPending = added === 0 ? pendingLp + lpDelta : 0;

      await pool.query(
        `UPDATE players
         SET avatar=$1, tier=$2, division=$3, lp=$4, lp_delta=$5,
             wins=$6, losses=$7, pending_lp=$9, updated_at=NOW()
         WHERE id=$8`,
        [avatar, tier, division, lp, lpDelta, wins, losses, player.id, newPending]
      );

      report.playersUpdated++;
      report.matchesAdded += added;
      if (added > 0 && pendingLp !== 0) {
        console.log(`[riot-sync] ✓ ${player.name}${player.tag} (pending_lp ${pendingLp > 0 ? '+' : ''}${pendingLp} appliqué)`);
      } else {
        console.log(`[riot-sync] ✓ ${player.name}${player.tag}`);
      }
    } catch (err) {
      console.error(`[riot-sync] ✗ ${player.name}${player.tag}:`, err.message);
      report.errors.push({ name: player.name, error: err.message });
    }
  }

  console.log('[riot-sync] Terminé :', report);
  return report;
}

// ── Champion ID → name (Data Dragon, mis en cache) ───────────

let _champIdMap = null; // { 235: 'Senna', 350: 'Yuumi', ... }

async function getChampIdMap() {
  if (_champIdMap) return _champIdMap;
  try {
    const versions = await new Promise((resolve, reject) => {
      https.get('https://ddragon.leagueoflegends.com/api/versions.json', (res) => {
        let raw = '';
        res.on('data', (c) => { raw += c; });
        res.on('end', () => { try { resolve(JSON.parse(raw)); } catch (e) { reject(e); } });
      }).on('error', reject);
    });
    const version = versions[0];
    const champData = await new Promise((resolve, reject) => {
      https.get(
        `https://ddragon.leagueoflegends.com/cdn/${version}/data/en_US/champion.json`,
        (res) => {
          let raw = '';
          res.on('data', (c) => { raw += c; });
          res.on('end', () => { try { resolve(JSON.parse(raw)); } catch (e) { reject(e); } });
        }
      ).on('error', reject);
    });
    _champIdMap = {};
    for (const [name, data] of Object.entries(champData.data)) {
      _champIdMap[Number(data.key)] = name;
    }
    console.log(`[live-game] Champion map chargée : ${Object.keys(_champIdMap).length} champions`);
  } catch (err) {
    console.warn('[live-game] Impossible de charger la champion map :', err.message);
    _champIdMap = {};
  }
  return _champIdMap;
}

/**
 * Vérifie si un joueur est en partie via l'API Spectator v5.
 * Retourne le nom du champion si en jeu, null sinon.
 */
async function fetchLiveChampion(puuid) {
  await sleep(DELAY_MS);
  try {
    const data = await riotGet(
      `${PLATFORM}.api.riotgames.com`,
      `/lol/spectator/v5/active-games/by-summoner/${encodeURIComponent(puuid)}`
    );
    // 200 → joueur en jeu
    const participants = data.participants || [];
    const me = participants.find(
      (p) => p.puuid && p.puuid.toLowerCase() === puuid.toLowerCase()
    );
    if (!me) {
      // En jeu mais PUUID introuvable parmi les participants → retourner une valeur truthy
      console.warn(`[live-game] Joueur en jeu mais PUUID non trouvé dans les participants. gameId=${data.gameId}`);
      return 'Unknown';
    }
    // championName présent dans certaines versions, sinon mapper depuis l'ID
    if (me.championName) return me.championName;
    const map = await getChampIdMap();
    return map[me.championId] || `Champ${me.championId}`;
  } catch (err) {
    if (err.message && err.message.includes('404')) return null;
    throw err;
  }
}

/**
 * Rafraîchit le statut "en jeu" pour tous les joueurs trackés.
 * Retourne une map { playerId: { champion, recentLp, lpExpiresAt } }.
 * - champion non-null  → joueur en partie
 * - recentLp non-null  → partie terminée depuis peu, LP delta affiché
 */
async function refreshAllLiveGames(pool, previousCache) {
  const { rows } = await pool.query(
    'SELECT id, riot_puuid, lp, tier, division FROM players WHERE riot_puuid IS NOT NULL'
  );
  const result = {};

  for (const player of rows) {
    const prev = previousCache[player.id] || {};
    try {
      const champion = await fetchLiveChampion(player.riot_puuid);

      if (champion) {
        // En jeu — mémoriser le LPT avant la partie pour calculer le delta à la fin
        const inGameSince  = prev.champion ? (prev.inGameSince  || Date.now()) : Date.now();
        const lpAtGameStart = prev.champion ? prev.lpAtGameStart : calcLpt(player.tier, player.division, player.lp);
        result[player.id] = { champion, recentLp: null, lpExpiresAt: null, inGameSince, errorStreak: 0, lpAtGameStart };
        console.log(`[live-game] Joueur ${player.id} en jeu : ${champion}`);

      } else if (prev.champion) {
        // Fin de partie : comparer le LPT actuel (déjà mis à jour par le sync) avec le LPT avant la partie
        const newLpt = calcLpt(player.tier, player.division, player.lp);
        const recentLp = (prev.lpAtGameStart !== undefined)
          ? newLpt - prev.lpAtGameStart
          : null;
        result[player.id] = {
          champion:    null,
          recentLp:    recentLp !== 0 ? recentLp : null, // 0 = ARAM/custom = pas de LP
          lpExpiresAt: Date.now() + 10 * 60_000,
        };
        if (recentLp) console.log(`[live-game] Joueur ${player.id} fin de game : ${recentLp > 0 ? '+' : ''}${recentLp} LP`);
        else         console.log(`[live-game] Joueur ${player.id} fin de game (pas de LP)`);

      } else if (prev.recentLp !== undefined && prev.lpExpiresAt > Date.now()) {
        // Garder l'affichage LP jusqu'à expiration
        result[player.id] = prev;

      } else {
        result[player.id] = { champion: null, recentLp: null, lpExpiresAt: null };
      }

    } catch (err) {
      console.warn(`[live-game] Erreur joueur ${player.id}: ${err.message}`);
      // Compter les erreurs consécutives — après 3 cycles en erreur sur un joueur "en jeu",
      // l'état est probablement périmé (429 qui bloque la détection de fin de partie)
      const errorStreak = (prev.errorStreak || 0) + 1;
      const MAX_GAME_MS = 90 * 60_000; // filet de sécurité absolu : 90 min
      const stale = prev.champion && (
        errorStreak >= 3 ||
        (prev.inGameSince && (Date.now() - prev.inGameSince) > MAX_GAME_MS)
      );
      if (stale) {
        console.warn(`[live-game] Joueur ${player.id} — état périmé (streak=${errorStreak}), effacement`);
        result[player.id] = { champion: null, recentLp: null, lpExpiresAt: null };
      } else {
        result[player.id] = prev.champion !== undefined
          ? { ...prev, errorStreak }
          : { champion: null, recentLp: null, lpExpiresAt: null };
      }
    }
  }
  return result;
}

module.exports = { syncChallenger, syncSinglePlayer, syncTrackedPlayers, refreshAllLiveGames };
