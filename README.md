# ⚔ SMC SoloQ Challenge Tracker

A web application to track and display a **SoloQ Challenge** between friends, inspired by the challenge format popularized by streamer Traiton. The goal is purely for fun — no commercial purpose whatsoever.

---

## What is it?

The **SMC SoloQ Challenge** is a League of Legends competition between roughly 10 friends, split into two teams. Each player climbs the solo queue ranked ladder independently, and the website aggregates their progress into a live leaderboard with team scores.

The application automatically fetches data from the **Riot Games API** to keep everything up to date: rank, LP, wins, losses, recent match history, and even live game status.

### Key features

- **Live leaderboard** — ranks all participants by LP (or winrate / number of wins), with their current tier, LP delta, and team color
- **Team scores** — the cumulative LP of each team is calculated and displayed so you always know who's winning the challenge
- **Live game detection** — shows which players are currently in a ranked game
- **Match history** — full history of ranked games per player (champion, role, KDA, CS, duration, LP change)
- **Statistics page** — highlights such as most wins, best winrate, most first bloods, most pings, and more
- **Admin panel** — add/edit players, link Riot accounts, assign teams, trigger manual syncs
- **Auto-sync** — the backend periodically polls the Riot API (every 30 min by default) to refresh all tracked players

---

## Tech Stack

| Layer    | Technology                        |
|----------|-----------------------------------|
| Frontend | Vanilla HTML / CSS / JavaScript   |
| Backend  | Node.js + Express                 |
| Database | PostgreSQL 16                     |
| Proxy    | nginx                             |
| Deploy   | Docker Compose                    |
| Data     | Riot Games API (League of Legends)|

---

## Screenshots

### Leaderboard (Classement)

> _Main page — full player ranking with tier badges, LP, wins/losses, live game indicator, and team scores._

<!-- Add your screenshot here -->
![Leaderboard](docs/screenshots/leaderboard.png)

---

### Match History (Historique)

> _Per-player match history — champion, role, KDA, CS, duration, LP change, and result._

<!-- Add your screenshot here -->
![Match History](docs/screenshots/history.png)

---

### Statistics (Statistiques)

> _Fun stats panel — top performers across categories like most wins, best winrate, most first bloods, most pings, and more._

<!-- Add your screenshot here -->
![Statistics](docs/screenshots/statistics.png)

---

### Player Detail Modal

> _Click on any player to see their full profile: rank progression, recent games, and personal stats._

<!-- Add your screenshot here -->
![Player Detail](docs/screenshots/player-detail.png)

---

## Getting Started

### Prerequisites

- [Docker](https://www.docker.com/) and Docker Compose
- A [Riot Games API key](https://developer.riotgames.com/) (dev key is valid for 24h; apply for a production key for long-term use)

### Setup

1. **Clone the repository**

   ```bash
   git clone <repo-url>
   cd soloq
   ```

2. **Create a `.env` file** at the root with your Riot API key:

   ```env
   RIOT_API_KEY=RGAPI-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
   RIOT_PLATFORM=euw1        # euw1 | na1 | kr | eun1 ...
   RIOT_REGION=europe        # europe | americas | asia
   ```

3. **Start the stack**

   ```bash
   docker compose up -d
   ```

4. **Open the app** at [http://localhost:8080](http://localhost:8080)

   The backend API is available at [http://localhost:3000/api](http://localhost:3000/api/health).

---

## API Endpoints

| Method | Route                        | Description                        |
|--------|------------------------------|------------------------------------|
| GET    | `/api/health`                | Health check                       |
| GET    | `/api/players`               | List all players (supports `sort`, `search`) |
| GET    | `/api/players/:id/matches`   | Match history for a player         |
| GET    | `/api/matches?limit=500`     | All recent matches                 |

---

## Environment Variables

| Variable                 | Default     | Description                                      |
|--------------------------|-------------|--------------------------------------------------|
| `RIOT_API_KEY`           | _(required)_| Your Riot Games API key                          |
| `RIOT_PLATFORM`          | `euw1`      | Platform routing (server region)                 |
| `RIOT_REGION`            | `europe`    | Regional routing (for match/account endpoints)   |
| `RIOT_TOP_N`             | `10`        | Number of players to sync                        |
| `RIOT_DELAY_MS`          | `1300`      | Delay between API calls (ms) to respect rate limits |
| `RIOT_SYNC_INTERVAL_MS`  | `1800000`   | Auto-sync interval (default: 30 minutes)         |

---

## Project Structure

```
soloq/
├── backend/          # Express API + Riot API client
│   ├── index.js      # REST routes, DB migrations
│   └── riot.js       # Riot API integration
├── frontend/         # Static website served by nginx
│   ├── index.html
│   ├── script.js
│   └── style.css
├── db/
│   └── init.sql      # Database schema
├── data/postgres/    # PostgreSQL data volume (auto-generated)
├── docker-compose.yml
└── .env              # Your secrets (not committed)
```

---
