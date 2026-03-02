# Conflict Detector Backend (Python + Telegram OSINT)

Backend 100% gratuit/open source pour ingestion terrain en temps réel depuis Telegram, filtrage par mots-clés, stockage SQLite, API REST + WebSocket.

## Stack

- Python 3.11+
- Telethon (listener Telegram)
- FastAPI + Uvicorn (API + WebSocket)
- SQLite + aiosqlite

## Arborescence

```
conflict-detector-backend/
├── main.py
├── telegram_scraper.py
├── keyword_filter.py
├── location_resolver.py
├── database.py
├── defcon.py
├── requirements.txt
├── .env.example
└── README.md
```

## 1) Installation locale

```bash
cd conflict-detector-backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
```

Renseigne ensuite dans `.env`:

```env
TELEGRAM_API_ID=123456
TELEGRAM_API_HASH=abcdef123456...
```

## 2) Premier lancement (auth Telegram)

```bash
uvicorn main:app --host 0.0.0.0 --port 8000
```

Au premier lancement Telethon peut demander une authentification utilisateur Telegram (code SMS/app).  
Une session locale sera ensuite réutilisée automatiquement.

## 3) API

### GET `/api/alerts`

- 100 dernières alertes terrain
- filtres combinables:
  - `severity=critique|haute|moyen|faible`
  - `country=Iran`

Exemple:

```bash
curl "http://localhost:8000/api/alerts?severity=critique&country=Iran"
```

### GET `/api/stats`

Retourne:

- DEFCON auto (fenêtre 2h)
- compteurs par sévérité
- top pays actifs
- top canaux

### WebSocket `/ws`

Push temps réel:

```json
{
  "type": "new_alert",
  "alert": {
    "id": 42,
    "timestamp": "2026-03-02T10:45:00+00:00",
    "title": "...",
    "country": "Iran",
    "severity": "haute"
  }
}
```

## 4) Déploiement Render

1. Crée un nouveau **Web Service** depuis ton repo.
2. Root Directory: `conflict-detector-backend`
3. Build Command:

```bash
pip install -r requirements.txt
```

4. Start Command:

```bash
uvicorn main:app --host 0.0.0.0 --port $PORT
```

5. Variables d’environnement Render:
   - `TELEGRAM_API_ID`
   - `TELEGRAM_API_HASH`

## 5) Comportement du pipeline

- Listener Telegram en continu sur:
  - `@intelslava`, `@OSINTdefender`, `@MiddleEastSpectator`, `@GazaWarNews`,
    `@TpyxiAlert`, `@BNONews`, `@sentdefender`, `@WarMonitor3`, `@IntelCrab`
- Scoring mots-clés:
  - `score >= 10` => alert terrain acceptée
  - sinon rejet
- Déduplication:
  - similarité `> 80%` dans les 60 sec => ignoré
- Stockage:
  - conservation des 500 dernières alertes
- Logs structurés:
  - `alert_accepted`, `alert_rejected`, `alert_skipped_duplicate`

## 6) Notes opérationnelles

- Aucun service payant utilisé.
- Aucune API LLM externe.
- Si Telegram coupe la connexion, la reconnexion se fait automatiquement (backoff).
