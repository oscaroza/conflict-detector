# Conflict Detector Backend (Python + Telegram OSINT)

Backend 100% gratuit/open source pour ingestion terrain en temps réel depuis Telegram + RSS, filtrage par mots-clés, enrichissement IA (Groq), stockage SQLite, API REST + WebSocket.

## Stack

- Python 3.11+
- Telethon (listener Telegram)
- RSS (feedparser)
- Groq (Llama3 8B) pour l'analyse IA structurée
- FastAPI + Uvicorn (API + WebSocket)
- SQLite + aiosqlite

## Arborescence

```
conflict-detector-backend/
├── main.py
├── ai_analyzer.py
├── rss_scraper.py
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
TELEGRAM_SESSION_STRING=
TELEGRAM_BACKFILL_LIMIT=180
TELEGRAM_ENABLE_POLLING=1
TELEGRAM_POLL_SECONDS=30
TELEGRAM_POLL_LIMIT=6
RSS_ENABLE=1
RSS_POLL_SECONDS=120
RSS_ITEMS_PER_FEED=20
RSS_MAX_AGE_HOURS=48
RSS_FEED_URLS=
ALERT_SCORE_THRESHOLD=8
DUPLICATE_WINDOW_SECONDS=45
SIMILARITY_THRESHOLD=0.90
MAX_ALERTS=500
TELEGRAM_CHANNELS=@intelslava,@OSINTdefender,@MiddleEastSpectator
GROQ_API_KEY=
GROQ_MODEL=llama3-8b-8192
GROQ_TIMEOUT_SECONDS=16
AI_CACHE_MAX_ITEMS=2000
```

## 2) Premier lancement (auth Telegram)

```bash
uvicorn main:app --host 0.0.0.0 --port 8000
```

Au premier lancement Telethon peut demander une authentification utilisateur Telegram (code SMS/app).  
Une session locale sera ensuite réutilisée automatiquement.

Pour Render (non interactif), génère une StringSession locale puis colle-la dans `TELEGRAM_SESSION_STRING`:

```bash
python3 - <<'PY'
from telethon.sync import TelegramClient
from telethon.sessions import StringSession

api_id = int(input("API ID: ").strip())
api_hash = input("API HASH: ").strip()

with TelegramClient(StringSession(), api_id, api_hash) as client:
    print("\nSESSION STRING:\n")
    print(client.session.save())
PY
```

## 3) API

### GET `/api/alerts`

- 100 dernières alertes terrain
- filtres combinables:
  - `severity=critique|haute|moyen|faible`
  - `country=Iran`
  - `source_type=telegram|rss`

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

### GET `/api/ai/health`

Vérifie l'état du module IA:

- clé API configurée ou non
- modèle actif
- taille du cache IA mémoire

### GET `/api/countries`

Liste des pays actifs.

### GET `/api/regions`

Liste des régions actives.

### SSE `/api/stream`

Flux temps réel compatible EventSource (`new-alert`).

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
   - `TELEGRAM_SESSION_STRING` (obligatoire en pratique sur Render)
   - `TELEGRAM_BACKFILL_LIMIT` (optionnel, ex. `180`)
   - `TELEGRAM_ENABLE_POLLING` (`1` par defaut)
   - `TELEGRAM_POLL_SECONDS` (optionnel, ex. `30`)
   - `TELEGRAM_POLL_LIMIT` (optionnel, ex. `6`)
   - `ALERT_SCORE_THRESHOLD` (optionnel, ex. `8`)
   - `DUPLICATE_WINDOW_SECONDS` (optionnel, ex. `45`)
   - `SIMILARITY_THRESHOLD` (optionnel, ex. `0.90`)
   - `MAX_ALERTS` (optionnel, ex. `500`)
   - `TELEGRAM_CHANNELS` (optionnel, liste CSV de canaux a ajouter)
   - `RSS_ENABLE` (`1` par defaut)
   - `RSS_POLL_SECONDS` (optionnel, ex. `120`)
   - `RSS_ITEMS_PER_FEED` (optionnel, ex. `20`)
   - `RSS_MAX_AGE_HOURS` (optionnel, ex. `48`)
   - `RSS_FEED_URLS` (optionnel, CSV URL ou `Nom|URL`)
   - `GROQ_API_KEY` (requis pour IA)
   - `GROQ_MODEL` (defaut `llama3-8b-8192`)
   - `GROQ_TIMEOUT_SECONDS` (optionnel, ex. `16`)
   - `AI_CACHE_MAX_ITEMS` (optionnel, ex. `2000`)

## 5) Comportement du pipeline

- Listener Telegram en continu sur:
  - `@intelslava`, `@OSINTdefender`, `@MiddleEastSpectator`, `@GazaWarNews`,
    `@TpyxiAlert`, `@BNONews`, `@sentdefender`, `@WarMonitor3`, `@IntelCrab`,
    `@Faytuks`, `@IntelTower`, `@nexta_live`, `@clashreport`
  - et canaux custom via `TELEGRAM_CHANNELS`
- Polling complementaire:
  - scan periodique des derniers messages par canal (configurable)
  - utile si certains updates temps reel Telegram ne remontent pas
- Scoring mots-clés:
  - `score >= ALERT_SCORE_THRESHOLD` (defaut `8`) => alerte acceptee
  - sinon rejet
- Déduplication:
  - similarite `>= SIMILARITY_THRESHOLD` (defaut `0.90`)
  - fenetre `DUPLICATE_WINDOW_SECONDS` (defaut `45s`)
- Stockage:
  - conservation des 500 dernières alertes
- Enrichissement IA (si `GROQ_API_KEY` configuré):
  - catégorie, sous-catégories, sévérité affinée, score de sévérité, acteurs, pays, résumé factuel, fiabilité, flag conflit
  - fallback neutre si quota/timeouts/erreurs (`ai_analyzed=false`)
  - cache par source (`source_ref`) + cache mémoire pour éviter les ré-analyses
- Logs structurés:
  - `alert_accepted`, `alert_rejected`, `alert_skipped_duplicate`

## 6) Notes opérationnelles

- Aucun service payant utilisé.
- Aucune API LLM externe.
- Si Telegram coupe la connexion, la reconnexion se fait automatiquement (backoff).
