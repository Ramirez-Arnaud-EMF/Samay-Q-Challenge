/**
 * SoloQ Tracker — frontend/script.js
 *
 * Client HTTP : toutes les données proviennent de /api (backend Express + PostgreSQL).
 * Points d'intégration Riot API marqués [RIOT-API] dans backend/index.js.
 */

'use strict';

/* ============================================================
   CONFIG PRÉSENTATION — tiers (pas de données, juste le style)
   ============================================================ */

const TIERS = {
  CHALLENGER:  { label: 'Challenger',  emoji: '🏆', cssKey: 'challenger' },
  GRANDMASTER: { label: 'Grandmaster', emoji: '💎', cssKey: 'grandmaster' },
  MASTER:      { label: 'Master',      emoji: '🔮', cssKey: 'master' },
  DIAMOND:     { label: 'Diamond',     emoji: '💠', cssKey: 'diamond' },
  EMERALD:     { label: 'Emerald',     emoji: '🟢', cssKey: 'emerald' },
  PLATINUM:    { label: 'Platinum',    emoji: '🔷', cssKey: 'platinum' },
  GOLD:        { label: 'Gold',        emoji: '🥇', cssKey: 'gold' },
  SILVER:      { label: 'Silver',      emoji: '🥈', cssKey: 'silver' },
  BRONZE:      { label: 'Bronze',      emoji: '🥉', cssKey: 'bronze' },
  IRON:        { label: 'Iron',        emoji: '⚙',  cssKey: 'iron' },
};

const TIER_BASE = {
  IRON: 0, BRONZE: 400, SILVER: 800, GOLD: 1200,
  PLATINUM: 1600, EMERALD: 2000, DIAMOND: 2400,
  MASTER: 2800, GRANDMASTER: 2800, CHALLENGER: 2800,
};
const DIV_OFFSET = { IV: 0, III: 100, II: 200, I: 300 };

function calcLPT(player) {
  const base = TIER_BASE[player.tier] ?? 0;
  const div  = DIV_OFFSET[player.division] ?? 0;
  return base + div + Number(player.lp);
}



const state = {
  sortKey: 'lp',
  query:   '',
  isAdmin: false,
  teams:       ['Équipe 1', 'Équipe 2', 'Équipe 3'],
  activeTab:   'classement',
  statsLoaded:   false,
  historyLoaded: false,
};

/** Joueur actuellement ouvert dans la modal détail. */
let _currentPlayer = null;
/** Joueur en cours d'édition dans la modal édition. */
let _editingPlayer = null;

/* ============================================================
   UTILITAIRES
   ============================================================ */

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Valide et assainit une URL de profil (bloque les URLs non-http). */
function sanitizeUrl(url) {
  if (!url) return '';
  const u = String(url).trim();
  if (!u.startsWith('https://') && !u.startsWith('http://')) return '';
  return u;
}

/** Classe CSS de couleur d'équipe (stable par nom). */
function teamColorClass(team) {
  if (!team) return 'none';
  let hash = 0;
  for (let i = 0; i < team.length; i++) hash = (hash * 31 + team.charCodeAt(i)) & 0xffff;
  return ['blue', 'red', 'gold'][hash % 3];
}

function rankLabel(p) {
  const tier = TIERS[p.tier] || { label: p.tier };
  return p.division ? `${tier.label} ${p.division}` : tier.label;
}

/* ============================================================
   API — fetch helpers
   ============================================================ */

async function apiFetch(path, options = {}) {
  const res = await fetch(path, options);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
}

/* ============================================================
   RENDU DU TABLEAU
   ============================================================ */

function renderLoading() {
  document.getElementById('leaderboardBody').innerHTML = `
    <tr><td colspan="12" style="text-align:center;padding:48px;color:var(--text-muted)">
      Chargement…
    </td></tr>`;
  document.getElementById('emptyState').hidden = true;
}

function renderError(msg) {
  document.getElementById('leaderboardBody').innerHTML = `
    <tr><td colspan="12" style="text-align:center;padding:48px;color:var(--loss)">
      Erreur : ${escHtml(msg)}
    </td></tr>`;
}

function renderPlayers(list) {
  const tbody      = document.getElementById('leaderboardBody');
  const emptyState = document.getElementById('emptyState');

  tbody.innerHTML = '';

  if (list.length === 0) {
    emptyState.hidden = false;
    return;
  }
  emptyState.hidden = true;

  list.forEach((player, index) => {
    const wr      = Number(player.winrate);
    const rankNum = index + 1;

    let rankClass = '';
    if (rankNum === 1) rankClass = 'top1';
    else if (rankNum === 2) rankClass = 'top2';
    else if (rankNum === 3) rankClass = 'top3';

    const delta    = Number(player.lp_delta);
    let deltaClass = 'zero', deltaText = '\u2014';
    if (delta > 0) { deltaClass = 'pos'; deltaText = `+${delta}`; }
    if (delta < 0) { deltaClass = 'neg'; deltaText = `${delta}`; }

    const avgGain = player.avg_lp_gain != null ? Number(player.avg_lp_gain) : null;
    const avgLoss = player.avg_lp_loss != null ? Number(player.avg_lp_loss) : null;
    let lpPerGameHtml;
    if (avgGain !== null || avgLoss !== null) {
      const gainPart = avgGain !== null ? `<span class="lp-per-win">+${avgGain}</span>` : '';
      const lossPart = avgLoss !== null ? `<span class="lp-per-loss">-${avgLoss}</span>` : '';
      const sep      = gainPart && lossPart ? '<span class="lp-per-sep"> / </span>' : '';
      lpPerGameHtml  = `<div class="lp-per-game">${gainPart}${sep}${lossPart}</div>`;
    } else {
      lpPerGameHtml  = `<span class="delta zero">—</span>`;
    }

    const tier   = TIERS[player.tier] || { cssKey: 'iron', label: player.tier };
    const cssKey = tier.cssKey;

    const avatarSrc  = safeAvatarSrc(player.avatar_custom);
    const displayName = player.display_name || player.name;
    const safeUrl     = sanitizeUrl(player.profile_url);
    const accountText = `${escHtml(player.name)}${escHtml(player.tag)}`;
    const accountCell = safeUrl
      ? `<a href="${escHtml(safeUrl)}" target="_blank" rel="noopener noreferrer" class="account-link" onclick="event.stopPropagation()">${accountText}</a>`
      : `<span class="account-plain">${accountText}</span>`;
    const teamCell = player.team
      ? `<span class="team-badge team-${teamColorClass(player.team)}">${escHtml(player.team)}</span>`
      : `<span class="team-none">—</span>`;

    const tr = document.createElement('tr');
    tr.dataset.id = player.id;
    if (player.team) tr.classList.add(`row-team-${teamColorClass(player.team)}`);

    tr.innerHTML = `
      <td>
        <div class="rank-cell">
          <div class="rank-num ${rankClass}">${rankNum}</div>
          <div class="rank-lpt">${calcLPT(player).toLocaleString()}</div>
        </div>
      </td>
      <td>
        <div class="player-cell">
          <div class="player-avatar">${avatarSrc ? `<img src="${avatarSrc}" alt="" />` : escHtml(player.avatar || '\ud83c\udfae')}</div>
          <div class="player-name">${escHtml(displayName)}</div>
        </div>
      </td>
      <td class="account-cell">${accountCell}</td>
      <td class="team-cell">${teamCell}</td>
      <td>
        <div class="tier-badge">
          <span class="tier-dot dot-${cssKey}"></span>
          <span class="tier-${cssKey}">${rankLabel(player)}</span>
        </div>
      </td>
      <td class="lp-value">${Number(player.lp).toLocaleString()} LP</td>
      <td class="lpt-value">${calcLPT(player).toLocaleString()}</td>
      <td>${lpPerGameHtml}</td>
      <td class="games-value">${player.wins + player.losses}</td>
      <td class="wl-cell">
        <span class="wl-w">${player.wins}V</span>
        <span class="wl-sep">/</span>
        <span class="wl-l">${player.losses}D</span>
      </td>
      <td class="wr-cell">
        <div class="wr-value" style="color:${wr >= 55 ? 'var(--win)' : wr < 45 ? 'var(--loss)' : 'var(--text-primary)'}">${wr}%</div>
        <div class="wr-bar-wrap">
          <div class="wr-bar" style="width:${wr}%; background:${wr >= 55 ? 'var(--win)' : wr < 45 ? 'var(--loss)' : 'var(--neutral)'}"></div>
        </div>
      </td>
      <td class="streak-cell" data-id="${player.id}"><span class="streak-loading">…</span></td>
      <td class="live-cell" data-id="${player.id}"><span class="live-dash">—</span></td>
    `;

    tr.addEventListener('click', () => openModal(player));
    tbody.appendChild(tr);
  });
}

/* ============================================================
   STREAK — colonne des 10 dernières parties
   ============================================================ */

async function loadStreaks() {
  try {
    const data = await apiFetch('/api/players/streaks');
    Object.entries(data).forEach(([id, matches]) => {
      document.querySelectorAll(`.streak-cell[data-id="${id}"]`).forEach((cell) => {
        if (!matches || matches.length === 0) {
          cell.innerHTML = '<span class="live-dash">—</span>';
          return;
        }
        cell.innerHTML = `<div class="streak-icons">${matches.map((m) => `
          <div class="streak-icon-wrap ${m.result === 'win' ? 'streak-win' : 'streak-loss'}">
            <img
              class="streak-champ-img"
              src="${champImgUrl(m.champion)}"
              alt="${escHtml(m.champion)}"
              title="${escHtml(m.champion)}"
              onerror="this.style.visibility='hidden'"
            />
          </div>`).join('')}
        </div>`;
      });
    });
  } catch { /* silencieux — feature optionnelle */ }
}

/* ============================================================
   LIVE GAME — colonne "en jeu"
   ============================================================ */

async function loadLiveGames() {
  try {
    const data = await apiFetch('/api/live');
    Object.entries(data).forEach(([id, info]) => {
      const champion = info?.champion ?? null;
      const recentLp = info?.recentLp ?? null;

      document.querySelectorAll(`.live-cell[data-id="${id}"]`).forEach((cell) => {
        if (champion) {
          cell.innerHTML = `
            <div class="live-badge">
              <img
                class="live-champ-img"
                src="${champImgUrl(champion)}"
                alt="${escHtml(champion)}"
                title="${escHtml(champion)}"
                onerror="this.style.visibility='hidden'"
              />
              <span class="live-dot"></span>
            </div>`;
        } else if (recentLp !== null && recentLp !== 0) {
          const cls  = recentLp > 0 ? 'pos' : 'neg';
          const text = recentLp > 0 ? `+${recentLp}` : `${recentLp}`;
          cell.innerHTML = `<span class="live-lp-change ${cls}">${text} LP</span>`;
        } else {
          cell.innerHTML = '<span class="live-dash">—</span>';
        }
      });
    });
  } catch { /* silencieux — feature optionnelle */ }
}

/* ============================================================
   FETCH + RENDER PLAYERS
   ============================================================ */

async function loadPlayers() {
  renderLoading();
  try {
    const params  = new URLSearchParams({ sort: state.sortKey, search: state.query });
    const players = await apiFetch(`/api/players?${params}`);
    renderPlayers(players);
    loadLiveGames();
    loadStreaks();
  } catch (err) {
    renderError(err.message);
  }
}

/* ============================================================
   MODAL — FICHE DÉTAILLÉE
   ============================================================ */

async function openModal(player) {
  _currentPlayer = player;
  const tier    = TIERS[player.tier] || { emoji: '🎮', label: player.tier, cssKey: 'iron' };
  const wr      = Number(player.winrate);
  const delta   = Number(player.lp_delta);
  const deltaStr = delta > 0 ? `+${delta}` : delta === 0 ? '—' : `${delta}`;
  const deltaCol = delta > 0 ? 'var(--win)' : delta < 0 ? 'var(--loss)' : 'var(--text-muted)';

  const displayName = player.display_name || player.name;
  const safeUrl     = sanitizeUrl(player.profile_url);
  const accountHtml = safeUrl
    ? `<a href="${escHtml(safeUrl)}" target="_blank" rel="noopener noreferrer" style="color:var(--blue-team);text-decoration:none">${escHtml(player.name)}${escHtml(player.tag)}</a>`
    : `${escHtml(player.name)}${escHtml(player.tag)}`;

  const avatarSrc = safeAvatarSrc(player.avatar_custom);
  if (avatarSrc) {
    document.getElementById('modalRankBadge').innerHTML =
      `<img src="${avatarSrc}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:50%;" />`;
  } else {
    document.getElementById('modalRankBadge').textContent = tier.emoji;
  }
  document.getElementById('modalName').textContent = displayName;
  document.getElementById('modalTier').innerHTML =
    `<span class="tier-${tier.cssKey}">${rankLabel(player)}</span>`;

  document.getElementById('modalStats').innerHTML = `
    <div class="modal-stat">
      <span class="modal-stat-label">Compte</span>
      <span class="modal-stat-value" style="font-family:monospace;font-size:13px">${accountHtml}</span>
    </div>
    <div class="modal-stat">
      <span class="modal-stat-label">LP</span>
      <span class="modal-stat-value">${Number(player.lp).toLocaleString()}</span>
    </div>
    <div class="modal-stat">
      <span class="modal-stat-label">Variation</span>
      <span class="modal-stat-value" style="color:${deltaCol}">${deltaStr}</span>
    </div>
    <div class="modal-stat">
      <span class="modal-stat-label">Victoires</span>
      <span class="modal-stat-value" style="color:var(--win)">${player.wins}</span>
    </div>
    <div class="modal-stat">
      <span class="modal-stat-label">Défaites</span>
      <span class="modal-stat-value" style="color:var(--loss)">${player.losses}</span>
    </div>
    <div class="modal-stat">
      <span class="modal-stat-label">Winrate</span>
      <span class="modal-stat-value" style="color:${wr >= 55 ? 'var(--win)' : wr < 45 ? 'var(--loss)' : 'var(--text-primary)'}">${wr}%</span>
    </div>
    ${player.team ? `
    <div class="modal-stat">
      <span class="modal-stat-label">Équipe</span>
      <span class="modal-stat-value"><span class="team-badge team-${teamColorClass(player.team)}">${escHtml(player.team)}</span></span>
    </div>` : ''}
  `;

  // Afficher la modal avec état de chargement pour l'historique
  const historyList = document.getElementById('historyList');
  const deleteBtn   = document.getElementById('modalDeleteBtn');
  historyList.innerHTML = `<li style="padding:24px;text-align:center;color:var(--text-muted)">Chargement…</li>`;

  // Bouton supprimer / footer admin
  deleteBtn.dataset.id = player.id;
  deleteBtn.disabled = false;
  deleteBtn.textContent = '🗑 Supprimer';
  document.getElementById('modalEditBtn').dataset.id = player.id;
  document.getElementById('modalFooter').hidden = !state.isAdmin;

  document.getElementById('modalOverlay').hidden = false;
  document.getElementById('modalOverlay').scrollTop = 0;
  document.body.style.overflow = 'hidden';

  // Charger l'historique des matchs depuis l'API
  try {
    const matches = await apiFetch(`/api/players/${player.id}/matches`);
    historyList.innerHTML = matches.length === 0
      ? `<li style="padding:24px;text-align:center;color:var(--text-muted)">Aucune partie enregistrée.</li>`
      : matches.map((m) => `
        <li class="history-item ${m.result}">
          <span class="history-result">${m.result === 'win' ? 'Vic.' : 'Déf.'}</span>
          <div class="history-champ-info">
            <img
              class="history-champ-img"
              src="${champImgUrl(m.champion)}"
              alt="${escHtml(m.champion)}"
              onerror="this.style.visibility='hidden'"
            />
            <div>
              <div class="history-champ">${escHtml(m.champion)}</div>
              <div class="history-champ-role">${escHtml(m.role)}</div>
            </div>
          </div>
          <span class="history-kda">${m.kills}/${m.deaths}/${m.assists}</span>
          <span class="history-cs">${m.cs} CS</span>
          <span class="history-duration">${escHtml(m.duration)}</span>
          <span class="history-lp-change ${m.lp_change != null ? (m.lp_change > 0 ? 'pos' : 'neg') : 'zero'}">${m.lp_change != null ? (m.lp_change > 0 ? '+' : '') + m.lp_change + ' LP' : ''}</span>
        </li>
      `).join('');
  } catch (err) {
    historyList.innerHTML = `<li style="padding:24px;text-align:center;color:var(--loss)">Erreur : ${escHtml(err.message)}</li>`;
  }
}

function closeModal() {
  document.getElementById('modalOverlay').hidden = true;
  document.body.style.overflow = '';
}

/* ============================================================
   ADMIN — authentification
   ============================================================ */

function updateAdminUI() {
  const adminBtn   = document.getElementById('adminBtn');
  const addBtn     = document.getElementById('addPlayerBtn');
  const label      = document.getElementById('adminBtnLabel');

  if (state.isAdmin) {
    adminBtn.classList.add('admin-active');
    label.textContent = '✓ Admin';
    addBtn.hidden = false;
  } else {
    adminBtn.classList.remove('admin-active');
    label.textContent = '⚙ Admin';
    addBtn.hidden = true;
    document.getElementById('adminDropdown').hidden = true;
    if (!document.getElementById('modalOverlay').hidden) {
      document.getElementById('modalFooter').hidden = true;
    }
  }
}

/* ============================================================
   ÉQUIPES — chargement et mise à jour des selects
   ============================================================ */

async function loadTeams() {
  try {
    const data = await apiFetch('/api/teams');
    state.teams = [data.team1, data.team2, data.team3];
    updateTeamSelects();
  } catch { /* garde les valeurs par défaut */ }
}

function updateTeamSelects() {
  ['addTeamSelect', 'editTeamSelect'].forEach(id => {
    const sel = document.getElementById(id);
    if (!sel) return;
    const current = sel.value;
    // Garder uniquement l'option "aucune équipe", reconstruire le reste
    while (sel.options.length > 1) sel.remove(1);
    state.teams.forEach(name => {
      if (!name) return;
      const opt = document.createElement('option');
      opt.value       = name;
      opt.textContent = name;
      sel.appendChild(opt);
    });
    sel.value = current; // restaurer la sélection précédente si toujours valide
  });
}

function openTeamsModal() {
  document.getElementById('adminDropdown').hidden = true;
  document.getElementById('teamName1Input').value = state.teams[0] || '';
  document.getElementById('teamName2Input').value = state.teams[1] || '';
  document.getElementById('teamName3Input').value = state.teams[2] || '';
  document.getElementById('teamsError').hidden     = true;
  document.getElementById('teamsSubmitBtn').disabled   = false;
  document.getElementById('teamsSubmitBtn').textContent = 'Enregistrer';
  document.getElementById('teamsModalOverlay').hidden = false;
  document.body.style.overflow = 'hidden';
  setTimeout(() => document.getElementById('teamName1Input').focus(), 50);
}

function closeTeamsModal() {
  document.getElementById('teamsModalOverlay').hidden = true;
  document.body.style.overflow = '';
}

async function submitTeams() {
  const btn    = document.getElementById('teamsSubmitBtn');
  const errEl  = document.getElementById('teamsError');
  const t1 = document.getElementById('teamName1Input').value.trim();
  const t2 = document.getElementById('teamName2Input').value.trim();
  const t3 = document.getElementById('teamName3Input').value.trim();

  if (!t1 || !t2 || !t3) {
    errEl.textContent = 'Les 3 noms sont requis.';
    errEl.hidden = false;
    return;
  }

  btn.disabled   = true;
  btn.textContent = 'Enregistrement…';
  errEl.hidden = true;

  try {
    await apiFetch('/api/teams', {
      method:  'PUT',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ team1: t1, team2: t2, team3: t3 }),
    });
    state.teams = [t1, t2, t3];
    updateTeamSelects();
    closeTeamsModal();
    loadPlayers(); // rafraîchir (les noms d'équipes dans le tableau peuvent avoir changé)
  } catch (err) {
    errEl.textContent    = err.message;
    errEl.hidden         = false;
    btn.disabled         = false;
    btn.textContent      = 'Enregistrer';
  }
}

function openAdminLogin() {
  document.getElementById('adminPasswordInput').value = '';
  document.getElementById('adminLoginError').hidden   = true;
  document.getElementById('adminLoginOverlay').hidden = false;
  document.body.style.overflow = 'hidden';
  setTimeout(() => document.getElementById('adminPasswordInput').focus(), 50);
}

function closeAdminLogin() {
  document.getElementById('adminLoginOverlay').hidden = true;
  document.body.style.overflow = '';
}

function submitAdminPassword() {
  const pwd = document.getElementById('adminPasswordInput').value;
  if (pwd === 'SMCmdpmdr') {
    state.isAdmin = true;
    closeAdminLogin();
    updateAdminUI();
  } else {
    document.getElementById('adminLoginError').hidden = false;
    document.getElementById('adminPasswordInput').value = '';
    document.getElementById('adminPasswordInput').focus();
  }
}

/* ============================================================
   EDIT PLAYER MODAL
   ============================================================ */

function openEditModal(player) {
  _editingPlayer = player;

  document.getElementById('editDisplayNameInput').value = player.display_name || player.name || '';

  // Compte Riot (pré-rempli mais modifiable)
  const tag = player.tag || '';
  document.getElementById('editRiotIdInput').value = player.name
    ? `${player.name}${tag}`
    : '';

  document.getElementById('editProfileUrlInput').value = player.profile_url || '';
  document.getElementById('editTeamSelect').value      = player.team || '';

  // Avatar actuel
  const preview     = document.getElementById('editAvatarPreview');
  const placeholder = document.getElementById('editAvatarPlaceholder');
  const avatarSrc   = safeAvatarSrc(player.avatar_custom);
  if (avatarSrc) {
    preview.src    = avatarSrc;
    preview.hidden = false;
    placeholder.hidden = true;
  } else {
    preview.src    = '';
    preview.hidden = true;
    placeholder.hidden = false;
  }

  document.getElementById('editAvatarInput').value    = '';
  document.getElementById('editClearAvatar').checked  = false;
  document.getElementById('editError').hidden         = true;
  document.getElementById('editSubmitBtn').disabled   = false;
  document.getElementById('editSubmitBtn').textContent = 'Enregistrer';

  document.getElementById('editModalOverlay').hidden = false;
  document.body.style.overflow = 'hidden';
  setTimeout(() => document.getElementById('editDisplayNameInput').focus(), 50);
}

function closeEditModal() {
  document.getElementById('editModalOverlay').hidden = true;
  document.body.style.overflow = '';
  _editingPlayer = null;
}

async function submitEditPlayer() {
  if (!_editingPlayer) return;

  const submitBtn   = document.getElementById('editSubmitBtn');
  const errorEl     = document.getElementById('editError');
  const displayName = document.getElementById('editDisplayNameInput').value.trim();
  const riotIdRaw   = document.getElementById('editRiotIdInput').value.trim();
  const profileUrl  = document.getElementById('editProfileUrlInput').value.trim();
  const team        = document.getElementById('editTeamSelect').value;
  const clearAvatar = document.getElementById('editClearAvatar').checked;

  if (!displayName) {
    errorEl.textContent = 'Le nom affiché est requis.';
    errorEl.hidden = false;
    return;
  }
  if (profileUrl && !profileUrl.startsWith('http')) {
    errorEl.textContent = 'Le lien du profil doit commencer par https://';
    errorEl.hidden = false;
    return;
  }

  // Compte Riot (optionnel — si modifié)
  let riotName = null, riotTag = null;
  if (riotIdRaw) {
    const sep = riotIdRaw.lastIndexOf('#');
    if (sep < 1) {
      errorEl.textContent = 'Format compte invalide. Attendu : Nom#TAG';
      errorEl.hidden = false;
      return;
    }
    riotName = riotIdRaw.slice(0, sep).trim();
    riotTag  = riotIdRaw.slice(sep + 1).trim();
    if (!riotName || !riotTag) {
      errorEl.textContent = 'Format compte invalide. Attendu : Nom#TAG';
      errorEl.hidden = false;
      return;
    }
  }

  const body = { displayName, profileUrl, team };
  if (riotName) { body.riotName = riotName; body.riotTag = riotTag; }

  if (clearAvatar) {
    body.clearAvatar = true;
  } else {
    const file = document.getElementById('editAvatarInput').files[0];
    if (file) {
      try {
        body.avatarCustom = await readImageAsBase64(file);
      } catch (e) {
        errorEl.textContent = `Erreur image : ${e.message}`;
        errorEl.hidden = false;
        return;
      }
    }
  }

  submitBtn.disabled   = true;
  submitBtn.textContent = 'Enregistrement…';
  errorEl.hidden = true;

  try {
    await apiFetch(`/api/players/${_editingPlayer.id}`, {
      method:  'PUT',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    });
    closeEditModal();
    loadPlayers();
  } catch (err) {
    errorEl.textContent    = err.message;
    errorEl.hidden         = false;
    submitBtn.disabled     = false;
    submitBtn.textContent  = 'Enregistrer';
  }
}

/* ============================================================
   ADD PLAYER MODAL
   ============================================================ */

function openAddModal() {
  document.getElementById('addDisplayNameInput').value = '';
  document.getElementById('addRiotIdInput').value      = '';
  document.getElementById('addProfileUrlInput').value  = '';
  document.getElementById('addTeamSelect').value       = '';
  document.getElementById('addAvatarInput').value      = '';
  document.getElementById('avatarPreview').hidden      = true;
  document.getElementById('avatarPreview').src         = '';
  document.getElementById('avatarUploadPlaceholder').hidden = false;
  document.getElementById('addError').hidden           = true;
  document.getElementById('addSubmitBtn').disabled     = false;
  document.getElementById('addSubmitBtn').textContent  = 'Ajouter';
  document.getElementById('addModalOverlay').hidden    = false;
  document.body.style.overflow = 'hidden';
  setTimeout(() => document.getElementById('addDisplayNameInput').focus(), 50);
}

function closeAddModal() {
  document.getElementById('addModalOverlay').hidden = true;
  document.body.style.overflow = '';
}

async function submitAddPlayer() {
  const submitBtn   = document.getElementById('addSubmitBtn');
  const errorEl     = document.getElementById('addError');
  const displayName = document.getElementById('addDisplayNameInput').value.trim();
  const riotId      = document.getElementById('addRiotIdInput').value.trim();
  const profileUrl  = document.getElementById('addProfileUrlInput').value.trim();
  const team        = document.getElementById('addTeamSelect').value;

  let avatarCustom = null;
  const avatarFile  = document.getElementById('addAvatarInput').files[0];
  if (avatarFile) {
    try {
      avatarCustom = await readImageAsBase64(avatarFile);
    } catch (e) {
      errorEl.textContent = `Erreur image : ${e.message}`;
      errorEl.hidden = false;
      return;
    }
  }

  if (!displayName) {
    errorEl.textContent = 'Le nom affiché est requis.';
    errorEl.hidden = false;
    return;
  }
  if (!riotId.includes('#')) {
    errorEl.textContent = 'Format compte invalide. Attendu : Nom#TAG (ex : pzzzang3#2173)';
    errorEl.hidden = false;
    return;
  }
  if (profileUrl && !profileUrl.startsWith('http')) {
    errorEl.textContent = 'Le lien du profil doit commencer par https://';
    errorEl.hidden = false;
    return;
  }

  submitBtn.disabled = true;
  submitBtn.textContent = 'Ajout en cours…';
  errorEl.hidden = true;

  try {
    await apiFetch('/api/players/add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ riotId, displayName, profileUrl, team, avatarCustom }),
    });
    closeAddModal();
    loadPlayers();
  } catch (err) {
    errorEl.textContent = err.message.includes('404')
      ? `Compte "${riotId}" introuvable. Vérifie le nom et le TAG.`
      : err.message;
    errorEl.hidden = false;
    submitBtn.disabled = false;
    submitBtn.textContent = 'Ajouter';
  }
}

async function deletePlayer(id) {
  if (!state.isAdmin) return;
  const btn = document.getElementById('modalDeleteBtn');
  btn.disabled = true;
  btn.textContent = 'Suppression…';
  try {
    await apiFetch(`/api/players/${id}`, { method: 'DELETE' });
    closeModal();
    loadPlayers();
  } catch (err) {
    btn.disabled = false;
    btn.textContent = '🗑 Supprimer ce joueur';
    alert(`Erreur : ${err.message}`);
  }
}

/* ============================================================
   ÉVÉNEMENTS
   ============================================================ */

function initEvents() {
  // Navigation par onglets
  document.querySelectorAll('.nav-item[data-tab]').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.preventDefault();
      switchTab(el.dataset.tab);
    });
  });

  // Recherche avec debounce
  let searchTimer;
  document.getElementById('searchInput').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.query = e.target.value;
      loadPlayers();
    }, 250);
  });

  // Boutons de tri
  document.querySelectorAll('.sort-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.sort-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      state.sortKey = btn.dataset.sort;
      loadPlayers();
    });
  });

  // Fermeture modal joueur
  document.getElementById('modalClose').addEventListener('click', closeModal);
  document.getElementById('modalOverlay').addEventListener('click', (e) => {
    if (e.target === document.getElementById('modalOverlay')) closeModal();
  });

  // Bouton modifier (admin)
  document.getElementById('modalEditBtn').addEventListener('click', () => {
    if (!state.isAdmin || !_currentPlayer) return;
    closeModal();
    openEditModal(_currentPlayer);
  });

  // Suppression joueur (admin)
  document.getElementById('modalDeleteBtn').addEventListener('click', (e) => {
    if (!state.isAdmin) return;
    const id = e.currentTarget.dataset.id;
    if (id && confirm('Supprimer ce joueur du suivi ?')) deletePlayer(id);
  });

  // Ouverture modal ajout (admin requis)
  document.getElementById('addPlayerBtn').addEventListener('click', openAddModal);
  document.getElementById('addModalClose').addEventListener('click', closeAddModal);
  document.getElementById('addModalOverlay').addEventListener('click', (e) => {
    if (e.target === document.getElementById('addModalOverlay')) closeAddModal();
  });
  document.getElementById('addSubmitBtn').addEventListener('click', submitAddPlayer);
  document.getElementById('addRiotIdInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submitAddPlayer();
  });

  // Prévisualisation avatar (ajout)
  document.getElementById('addAvatarInput').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const preview     = document.getElementById('avatarPreview');
    const placeholder = document.getElementById('avatarUploadPlaceholder');
    preview.src    = URL.createObjectURL(file);
    preview.hidden = false;
    placeholder.hidden = true;
  });

  // Prévisualisation avatar (édition)
  document.getElementById('editAvatarInput').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const preview     = document.getElementById('editAvatarPreview');
    const placeholder = document.getElementById('editAvatarPlaceholder');
    preview.src    = URL.createObjectURL(file);
    preview.hidden = false;
    placeholder.hidden = true;
    // Désactiver "supprimer" si on upload une nouvelle photo
    document.getElementById('editClearAvatar').checked = false;
  });

  // Modal édition
  document.getElementById('editModalClose').addEventListener('click', closeEditModal);
  document.getElementById('editModalOverlay').addEventListener('click', (e) => {
    if (e.target === document.getElementById('editModalOverlay')) closeEditModal();
  });
  document.getElementById('editSubmitBtn').addEventListener('click', submitEditPlayer);

  // Bouton Admin dans la navbar
  document.getElementById('adminBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    if (state.isAdmin) {
      // Basculer le dropdown
      const dd = document.getElementById('adminDropdown');
      dd.hidden = !dd.hidden;
    } else {
      openAdminLogin();
    }
  });

  // Dropdown admin : gérer les équipes
  document.getElementById('adminTeamsBtn').addEventListener('click', openTeamsModal);

  // Dropdown admin : déconnexion
  document.getElementById('adminLogoutBtn').addEventListener('click', () => {
    state.isAdmin = false;
    updateAdminUI();
  });

  // Fermer le dropdown si clic en dehors
  document.addEventListener('click', () => {
    const dd = document.getElementById('adminDropdown');
    if (!dd.hidden) dd.hidden = true;
  });

  // Modal équipes
  document.getElementById('teamsModalClose').addEventListener('click', closeTeamsModal);
  document.getElementById('teamsModalOverlay').addEventListener('click', (e) => {
    if (e.target === document.getElementById('teamsModalOverlay')) closeTeamsModal();
  });
  document.getElementById('teamsSubmitBtn').addEventListener('click', submitTeams);

  // Modal login admin
  document.getElementById('adminLoginClose').addEventListener('click', closeAdminLogin);
  document.getElementById('adminLoginOverlay').addEventListener('click', (e) => {
    if (e.target === document.getElementById('adminLoginOverlay')) closeAdminLogin();
  });
  document.getElementById('adminLoginSubmit').addEventListener('click', submitAdminPassword);
  document.getElementById('adminPasswordInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submitAdminPassword();
  });

  // Escape ferme n'importe quelle modal ouverte
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const dd = document.getElementById('adminDropdown');
    if (!dd.hidden) { dd.hidden = true; return; }
    if (!document.getElementById('teamsModalOverlay').hidden)  { closeTeamsModal();  return; }
    if (!document.getElementById('adminLoginOverlay').hidden)  { closeAdminLogin();  return; }
    if (!document.getElementById('editModalOverlay').hidden)   { closeEditModal();   return; }
    if (!document.getElementById('modalOverlay').hidden)       closeModal();
    if (!document.getElementById('addModalOverlay').hidden)    closeAddModal();
  });
}

/* ============================================================
   NAVIGATION PAR ONGLETS
   ============================================================ */

function switchTab(tab) {
  document.querySelectorAll('.nav-item[data-tab]').forEach((el) => {
    el.classList.toggle('nav-active', el.dataset.tab === tab);
  });
  document.querySelectorAll('.tab-panel').forEach((el) => {
    el.hidden = (el.id !== `tab-${tab}`);
  });
  state.activeTab = tab;
  if (tab === 'stats' && !state.statsLoaded) {
    loadStats();
  }
  if (tab === 'historique' && !state.historyLoaded) {
    loadHistory();
  }
}

/* ============================================================
   HISTORIQUE GLOBAL
   ============================================================ */

function formatRelativeDate(isoStr) {
  if (!isoStr) return '';
  const d = new Date(isoStr);
  if (isNaN(d)) return '';
  const diff = Date.now() - d.getTime();
  const mins  = Math.floor(diff / 60_000);
  const hours = Math.floor(diff / 3_600_000);
  const days  = Math.floor(diff / 86_400_000);
  if (mins < 1)   return 'À l\'instant';
  if (mins < 60)  return `Il y a ${mins} min`;
  if (hours < 24) return `Il y a ${hours}h`;
  if (days < 7)   return `Il y a ${days}j`;
  return d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' });
}

function renderHistory(matches) {
  const container = document.getElementById('historyTabContent');
  if (matches.length === 0) {
    container.innerHTML = `<div style="text-align:center;padding:64px;color:var(--text-muted)">Aucune partie enregistrée.</div>`;
    return;
  }

  const items = matches.map((m) => {
    const avatarSrc = safeAvatarSrc(m.avatar_custom);
    const avatarHtml = avatarSrc
      ? `<img class="history-player-avatar" src="${avatarSrc}" alt="" />`
      : `<div class="history-player-avatar-emoji">🎮</div>`;

    const lpClass = m.lp_change != null ? (m.lp_change > 0 ? 'pos' : 'neg') : 'zero';
    const lpText  = m.lp_change != null ? (m.lp_change > 0 ? '+' : '') + m.lp_change + ' LP' : '';

    return `
      <li class="history-item history-item-global ${escHtml(m.result)}">
        <div class="history-player-cell">
          ${avatarHtml}
          <span class="history-player-name">${escHtml(m.player_name)}</span>
        </div>
        <span class="history-result">${m.result === 'win' ? 'Vic.' : 'Déf.'}</span>
        <div class="history-champ-info">
          <img
            class="history-champ-img"
            src="${champImgUrl(m.champion)}"
            alt="${escHtml(m.champion)}"
            onerror="this.style.visibility='hidden'"
          />
          <div>
            <div class="history-champ">${escHtml(m.champion)}</div>
            <div class="history-champ-role">${escHtml(m.role)}</div>
          </div>
        </div>
        <span class="history-kda">${m.kills}/${m.deaths}/${m.assists}</span>
        <span class="history-cs">${m.cs} CS</span>
        <span class="history-duration">${escHtml(m.duration)}</span>
        <span class="history-lp-change ${lpClass}">${lpText}</span>
        <span class="history-date">${formatRelativeDate(m.played_at)}</span>
      </li>`;
  }).join('');

  container.innerHTML = `
    <div class="history-tab-header">
      <span class="history-tab-title">Historique des parties</span>
      <span class="history-tab-count">${matches.length} partie${matches.length > 1 ? 's' : ''}</span>
    </div>
    <ul class="history-tab-list">${items}</ul>`;
}

async function loadHistory() {
  const container = document.getElementById('historyTabContent');
  container.innerHTML = `<div style="text-align:center;padding:64px;color:var(--text-muted)">Chargement…</div>`;
  try {
    const matches = await apiFetch('/api/matches?limit=1000');
    renderHistory(matches);
    state.historyLoaded = true;
  } catch (err) {
    container.innerHTML = `<div style="text-align:center;padding:64px;color:var(--loss)">Erreur : ${escHtml(err.message)}</div>`;
  }
}

/* ============================================================
   STATISTIQUES
   ============================================================ */

const _charts = {};

function destroyChart(id) {
  if (_charts[id]) { _charts[id].destroy(); delete _charts[id]; }
}

function makeChart(id, config) {
  destroyChart(id);
  const canvas = document.getElementById(id);
  if (!canvas) return;
  _charts[id] = new Chart(canvas.getContext('2d'), config);
}

const LP_LINE_COLORS = [
  { line: '#4a9eff' },
  { line: '#e84057' },
  { line: '#3dd68c' },
  { line: '#f0c040' },
  { line: '#c084fc' },
  { line: '#fb923c' },
];

function renderLpChart(mode, lpData) {
  const canvas = document.getElementById('chartLpProgression');
  if (!canvas) return;
  const source = mode === 'team' ? lpData.byTeam : lpData.byPlayer;
  if (!source || source.length === 0) {
    destroyChart('chartLpProgression');
    const wrap = document.querySelector('.lp-chart-container');
    if (wrap) wrap.innerHTML = '<div class="lp-no-data">Pas encore de données LP trackées.</div>';
    return;
  }

  const byDay = mode === 'team';

  let labels, datasets;

  if (byDay) {
    // Mode équipe : une colonne par jour
    const dateSet = new Set();
    source.forEach(item => item.data.forEach(d => dateSet.add(d.date)));
    const allDates = [...dateSet].sort();

    labels = allDates.map(d => { const [, m, day] = d.split('-'); return `${day}/${m}`; });

    datasets = source.map((item, i) => {
      const byDate = Object.fromEntries(item.data.map(d => [d.date, d.lp]));
      let last = null;
      const pts = allDates.map(date => {
        if (byDate[date] !== undefined) last = byDate[date];
        return last;
      });
      const col = LP_LINE_COLORS[i % LP_LINE_COLORS.length];
      return {
        label: item.name, data: pts,
        borderColor: col.line, backgroundColor: 'transparent',
        borderWidth: 2, pointRadius: 3, pointBackgroundColor: '#fff',
        pointBorderColor: col.line, pointBorderWidth: 2,
        tension: 0.3, fill: false, spanGaps: true,
      };
    });
  } else {
    // Mode joueur : une colonne par partie
    let maxLen = 0;
    source.forEach(item => { maxLen = Math.max(maxLen, item.data.length); });
    labels = Array.from({ length: maxLen }, (_, i) => i);

    datasets = source.map((item, i) => {
      const col = LP_LINE_COLORS[i % LP_LINE_COLORS.length];
      return {
        label: item.name, data: item.data,
        borderColor: col.line, backgroundColor: 'transparent',
        borderWidth: 2, pointRadius: 3, pointBackgroundColor: '#fff',
        pointBorderColor: col.line, pointBorderWidth: 2,
        tension: 0.3, fill: false,
      };
    });
  }

  makeChart('chartLpProgression', {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#0c1020', titleColor: '#dce0f0',
          bodyColor: '#6880a0', borderColor: '#263650', borderWidth: 1,
          callbacks: {
            title: (ctx) => byDay ? ctx[0].label : `Partie ${ctx[0].label}`,
            label: (ctx) => ctx.raw != null ? ` ${ctx.dataset.label}: ${ctx.raw} LPT` : null,
          },
        },
      },
      scales: {
        x: {
          ticks: { color: '#6880a0', font: { family: "'Barlow', sans-serif", size: 11 }, maxTicksLimit: byDay ? 999 : 15, maxRotation: byDay ? 45 : 0 },
          grid: { color: '#141c2e' },
        },
        y: {
          ticks: { color: '#6880a0', font: { family: "'Barlow', sans-serif", size: 11 }, callback: (v) => `${v}` },
          grid: { color: '#141c2e' },
        },
      },
    },
  });

  // Légende HTML custom
  const legendEl = document.getElementById('lpLegend');
  if (legendEl) {
    legendEl.innerHTML = datasets.map((ds, i) => `
      <button class="lp-legend-item" data-index="${i}">
        <span class="lp-legend-dot" style="background:${ds.borderColor};box-shadow:0 0 0 2px #000,0 0 0 3px ${ds.borderColor}"></span>
        <span class="lp-legend-name">${escHtml(ds.label)}</span>
      </button>`).join('');
    legendEl.querySelectorAll('.lp-legend-item').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.dataset.index, 10);
        const chart = _charts['chartLpProgression'];
        if (!chart) return;
        const meta = chart.getDatasetMeta(idx);
        meta.hidden = !meta.hidden;
        chart.update();
        btn.classList.toggle('lp-legend-hidden', meta.hidden);
      });
    });
  }
}

function rankCard(icon, title, sorted, valueFn, colorClass) {
  const items = sorted.map((p, i) => `
    <li class="srank-item ${i === 0 ? 'srank-first' : ''}">
      <span class="srank-num">${i + 1}</span>
      <span class="srank-name">${escHtml(p.display_name)}</span>
      <span class="srank-val ${colorClass}">${valueFn(p)}</span>
    </li>`).join('');
  return `
    <div class="stat-card">
      <div class="stat-card-hd">
        <span class="stat-card-icon">${icon}</span>
        <span class="stat-card-title">${title}</span>
      </div>
      <ol class="srank-list">${items}</ol>
    </div>`;
}

function teamStatCard(t) {
  const wr = t.winrate;
  const col = wr >= 55 ? 'var(--win)' : wr < 45 ? 'var(--loss)' : 'var(--text-primary)';
  return `
    <div class="stat-team-card">
      <div class="stat-team-name team-${teamColorClass(t.name)}">${escHtml(t.name)}</div>
      <div class="stat-team-row">
        <div class="stat-team-stat">
          <span class="stat-team-val" style="color:var(--win)">${t.wins}</span>
          <span class="stat-team-lbl">Victoires</span>
        </div>
        <div class="stat-team-stat">
          <span class="stat-team-val" style="color:var(--loss)">${t.losses}</span>
          <span class="stat-team-lbl">Défaites</span>
        </div>
        <div class="stat-team-stat">
          <span class="stat-team-val" style="color:${col}">${wr}%</span>
          <span class="stat-team-lbl">Winrate</span>
        </div>
        <div class="stat-team-stat">
          <span class="stat-team-val">${t.games}</span>
          <span class="stat-team-lbl">Parties</span>
        </div>
      </div>
      <div class="stat-team-players">${escHtml(t.players.join(' · '))}</div>
    </div>`;
}

function renderStats(data, lpData) {
  const { global: g, players, teams } = data;

  const byKillsTotal  = [...players].sort((a, b) => Number(b.total_kills)      - Number(a.total_kills));
  const byKillsAvg    = [...players].filter(p => Number(p.games) > 0).sort((a, b) => Number(b.avg_kills)    - Number(a.avg_kills));
  const byKdaAvg      = [...players].filter(p => Number(p.match_count) > 0).sort((a, b) => Number(b.avg_kda) - Number(a.avg_kda));
  const byDeathsTotal = [...players].sort((a, b) => Number(b.total_deaths)     - Number(a.total_deaths));
  const byDeathsAvgAsc= [...players].filter(p => Number(p.games) > 0).sort((a, b) => Number(a.avg_deaths)   - Number(b.avg_deaths));
  const byFirstBloods = [...players].sort((a, b) => Number(b.first_bloods)     - Number(a.first_bloods));
  const byPings       = [...players].sort((a, b) => Number(b.avg_pings)        - Number(a.avg_pings));
  const byFF          = [...players].sort((a, b) => Number(b.surrendered_games)- Number(a.surrendered_games));
  const byGames       = [...players].sort((a, b) => Number(b.games)            - Number(a.games));

  const teamsSection = teams.length > 0 ? `
    <div class="stats-section-title">PAR ÉQUIPE</div>
    <div class="stats-teams-grid">${teams.map(teamStatCard).join('')}</div>` : '';

  document.getElementById('statsContent').innerHTML = `
    <!-- Compteurs globaux -->
    <div class="stats-globals">
      <div class="stats-global-card">
        <div class="stats-global-icon">🎮</div>
        <div class="stats-global-val">${Number(g.totalGames).toLocaleString()}</div>
        <div class="stats-global-lbl">Parties (total ranked)</div>
      </div>
      <div class="stats-global-card">
        <div class="stats-global-icon">⚔️</div>
        <div class="stats-global-val">${Number(g.totalKills).toLocaleString()}</div>
        <div class="stats-global-lbl">Kills au total</div>
      </div>
      <div class="stats-global-card">
        <div class="stats-global-icon">🎯</div>
        <div class="stats-global-val">${g.avgKillsGlobal}</div>
        <div class="stats-global-lbl">Kills / partie (moy.)</div>
      </div>
      <div class="stats-global-card">
        <div class="stats-global-icon">📈</div>
        <div class="stats-global-val">${g.avgKdaGlobal}</div>
        <div class="stats-global-lbl">KDA (moy.)</div>
      </div>
    </div>

    <!-- Rankings -->
    <div class="stats-section-title">CLASSEMENTS INDIVIDUELS</div>
    <div class="stats-rankings-grid">
      ${rankCard('⚔️', 'Plus de kills',       byKillsTotal,   p => `${p.total_kills}`, 'pos')}
      ${rankCard('🎯', 'Kills / partie',       byKillsAvg,     p => `${Number(p.avg_kills).toFixed(1)}/g`, 'pos')}
      ${rankCard('📈', 'Meilleur KDA',         byKdaAvg,       p => `${Number(p.avg_kda).toFixed(2)}`, 'pos')}
      ${rankCard('💀', 'Plus de morts',        byDeathsTotal,  p => `${p.total_deaths}`, 'neg')}
      ${rankCard('😇', 'Moins de morts/g',     byDeathsAvgAsc, p => `${Number(p.avg_deaths).toFixed(1)}/g`, 'pos')}
      ${rankCard('🩸', 'First Bloods',          byFirstBloods,  p => `${p.first_bloods} FB`, 'pos')}
      ${rankCard('🔔', 'Plus de pings/g',      byPings,        p => `${p.avg_pings}/g`, 'neutral')}
      ${rankCard('🏳️', 'Plus de FF',            byFF,           p => `${p.surrendered_games} FF`, 'neg')}
      ${rankCard('🎮', 'Plus de parties',       byGames,        p => `${p.games} parties`, 'neutral')}
    </div>

    ${teamsSection}

    <!-- Progression LP -->
    <div class="stats-section-title">PROGRESSION LP</div>
    <div class="lp-progression-wrap">
      <div class="lp-mode-btns">
        <button class="lp-mode-btn lp-mode-active" data-mode="team">Par équipe</button>
        <button class="lp-mode-btn" data-mode="player">Par joueur</button>
      </div>
      <div id="lpLegend" class="lp-legend"></div>
      <div class="lp-chart-container">
        <canvas id="chartLpProgression"></canvas>
      </div>
    </div>

    <!-- Hall of Fame -->
    <div class="stats-section-title">HALL OF FAME — RECORDS EN 1 PARTIE</div>
    <div class="hof-grid" id="hofGrid">
      <div style="color:var(--text-muted);font-size:13px;padding:12px">Chargement…</div>
    </div>
  `;

  requestAnimationFrame(() => {
    renderLpChart('team', lpData);
    document.querySelectorAll('.lp-mode-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.lp-mode-btn').forEach(b => b.classList.remove('lp-mode-active'));
        btn.classList.add('lp-mode-active');
        renderLpChart(btn.dataset.mode, lpData);
      });
    });
  });
}

function renderHallOfFame(records) {
  const grid = document.getElementById('hofGrid');
  if (!grid) return;
  if (!records.length) {
    grid.innerHTML = `<div style="color:var(--text-muted);font-size:13px;padding:12px">Aucune donnée.</div>`;
    return;
  }
  grid.innerHTML = records.map(r => {
    const m = r.match;
    const isWin = m.result === 'win';
    const resultCol = isWin ? 'var(--win)' : 'var(--loss)';
    const resultLbl = isWin ? 'VIC.' : 'DÉF.';
    const lpStr = m.lp_change != null
      ? `<span class="hof-lp ${m.lp_change > 0 ? 'pos' : m.lp_change < 0 ? 'neg' : 'zero'}">${m.lp_change > 0 ? '+' : ''}${m.lp_change} LP</span>`
      : '';
    const kdaStr = m.deaths === 0
      ? `<span style="color:var(--gold-light)">${m.kills}/${m.deaths}/${m.assists}</span>`
      : `${m.kills}/${m.deaths}/${m.assists}`;
    return `
      <div class="hof-card" data-player-id="${m.player_id}">
        <div class="hof-card-hd">
          <span class="hof-icon">${r.icon}</span>
          <span class="hof-label">${escHtml(r.label)}</span>
        </div>
        <div class="hof-body" style="border-left:3px solid ${resultCol}">
          <img class="hof-champ-img" src="${champImgUrl(m.champion)}" alt="${escHtml(m.champion)}" onerror="this.style.visibility='hidden'" />
          <div class="hof-info">
            <div class="hof-champ-name">${escHtml(m.champion)}</div>
            <div class="hof-champ-role">${escHtml(m.role || '')}</div>
            <div class="hof-stats-row">
              <span class="hof-kda">${kdaStr}</span>
              ${m.cs ? `<span class="hof-sep">·</span><span class="hof-stat">${m.cs} CS</span>` : ''}
              ${m.duration ? `<span class="hof-sep">·</span><span class="hof-stat">${escHtml(m.duration)}</span>` : ''}
            </div>
          </div>
          <div class="hof-right">
            <span class="hof-result" style="color:${resultCol}">${resultLbl}</span>
            ${lpStr}
          </div>
        </div>
        <div class="hof-player">— ${escHtml(m.player_name)}</div>
      </div>`;
  }).join('');

  grid.querySelectorAll('.hof-card').forEach(card => {
    card.addEventListener('click', () => {
      const pid = parseInt(card.dataset.playerId, 10);
      const player = (state.players || []).find(p => p.id === pid);
      if (player) openModal(player);
    });
  });
}

async function loadStats() {
  const container = document.getElementById('statsContent');
  container.innerHTML = `<div style="text-align:center;padding:64px;color:var(--text-muted)">Chargement…</div>`;
  try {
    const [data, lpData] = await Promise.all([
      apiFetch('/api/stats'),
      apiFetch('/api/stats/lp-progression').catch(() => ({ byTeam: [], byPlayer: [] })),
    ]);
    renderStats(data, lpData);
    state.statsLoaded = true;
    // Charger le Hall of Fame après le rendu
    apiFetch('/api/hall-of-fame').then(renderHallOfFame).catch(() => {});
  } catch (err) {
    container.innerHTML = `<div style="text-align:center;padding:64px;color:var(--loss)">Erreur : ${escHtml(err.message)}</div>`;
  }
}

/* ============================================================
   INITIALISATION
   ============================================================ */

/* ============================================================
   IMAGE AVATAR — recadrage client 100×100 JPEG via canvas
   ============================================================ */

function readImageAsBase64(file) {
  return new Promise((resolve, reject) => {
    if (!file || !file.type.startsWith('image/')) {
      return reject(new Error('Fichier invalide'));
    }
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      try {
        const SIZE   = 100;
        const canvas = document.createElement('canvas');
        canvas.width = SIZE; canvas.height = SIZE;
        const ctx = canvas.getContext('2d');
        const min = Math.min(img.width, img.height);
        const sx  = (img.width  - min) / 2;
        const sy  = (img.height - min) / 2;
        ctx.drawImage(img, sx, sy, min, min, 0, 0, SIZE, SIZE);
        URL.revokeObjectURL(url);
        resolve(canvas.toDataURL('image/jpeg', 0.75));
      } catch (e) { URL.revokeObjectURL(url); reject(e); }
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Image invalide')); };
    img.src = url;
  });
}

function safeAvatarSrc(src) {
  if (typeof src === 'string' && src.startsWith('data:image/')) return src;
  return '';
}

/* ============================================================
   DATA DRAGON — images de champion
   ============================================================ */

let ddVersion = '15.1.1'; // version de repli
/** Map : nom normalisé (lowercase, sans espaces) → clé exacte Data Dragon */
const champKeyMap = new Map();

async function loadDDVersion() {
  try {
    const res  = await fetch('https://ddragon.leagueoflegends.com/api/versions.json');
    const data = await res.json();
    ddVersion  = data[0];
  } catch { /* garde la version de repli */ }

  // Charger la liste des champions pour construire le mapping de casse
  try {
    const res  = await fetch(`https://ddragon.leagueoflegends.com/cdn/${ddVersion}/data/fr_FR/champion.json`);
    const data = await res.json();
    for (const key of Object.keys(data.data)) {
      // Normalise : lowercase + sans espaces + sans apostrophes
      const normalized = key.toLowerCase().replace(/[\s']/g, '');
      champKeyMap.set(normalized, key);
    }
  } catch { /* le mapping restera vide, fallback sur le nom brut */ }
}

function champImgUrl(name) {
  const normalized = String(name).toLowerCase().replace(/[\s']/g, '');
  const key = champKeyMap.get(normalized) || name;
  return `https://ddragon.leagueoflegends.com/cdn/${ddVersion}/img/champion/${encodeURIComponent(key)}.png`;
}

document.addEventListener('DOMContentLoaded', async () => {
  initEvents();
  await loadDDVersion(); // attendre le mapping de champions avant de rendre le tableau
  loadTeams();
  loadPlayers();
  loadStatus();
  setInterval(loadStatus, 60_000);
  setInterval(loadLiveGames, 70_000); // légèrement décalé après le sync backend (60s)
});

async function loadStatus() {
  try {
    const s   = await apiFetch('/api/status');
    const el  = document.getElementById('lastSyncLabel');
    if (!el) return;
    if (s.syncRunning) {
      el.textContent = 'Sync en cours…';
    } else if (s.lastSync) {
      const d = new Date(s.lastSync);
      el.textContent = `Mis à jour ${d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`;
    } else {
      el.textContent = 'Jamais synchronisé';
    }
  } catch {
    // silently ignore status errors
  }
}
