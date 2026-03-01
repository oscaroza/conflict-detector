# Conflict Detector Backend (Python, 100% gratuit)

Backend asynchrone temps réel basé sur `Telethon + FastAPI + SQLite`.
Aucune API payante, aucun LLM externe.

## Structure

```text
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

## Fonctionnalités

- Listener Telegram temps réel sur canaux OSINT terrain.
- Scoring mots-clés (acceptation si score >= 10).
- Sévérité automatique (`critique`, `haute`, `moyen`, `faible`).
- Confiance automatique (0-100) selon règles statiques.
- Résolution de localisation offline (liste statique pays/villes + coords).
- Déduplication (similarité > 80% sur 60 secondes, `difflib`).
- Stockage SQLite, conservation automatique des 500 dernières alertes.
- API REST et WebSocket temps réel.
- DEFCON auto basé sur les alertes des 2 dernières heures.

## Installation locale

```bash
cd conflict-detector-backend
python3.11 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
```

Renseigne `.env` avec tes identifiants Telegram (`my.telegram.org`).

## Authentification Telegram (premier lancement)

Le code utilise une session Telethon persistante (`conflict_detector.session`) ou une session string si la variable d'environnement `TELEGRAM_SESSION` existe.

Si tu n'as pas encore de session, fais un login une fois en local pour générer la session:

```python
# run once in a Python shell from conflict-detector-backend/
from telethon import TelegramClient
import os

api_id = int(os.getenv("TELEGRAM_API_ID"))
api_hash = os.getenv("TELEGRAM_API_HASH")

with TelegramClient("conflict_detector", api_id, api_hash) as client:
    print("Session Telegram créée")
```

## Lancement

```bash
uvicorn main:app --host 0.0.0.0 --port 8000
```

## API

- `GET /api/alerts`
- `GET /api/alerts?severity=critique&country=Iran`
- `GET /api/stats`
- `GET /health`
- `WS /ws`

## Déploiement Render.com (free tier)

1. Crée un nouveau **Web Service** relié à ton repo.
2. `Root Directory`: `conflict-detector-backend`
3. `Build Command`:
   ```bash
   pip install -r requirements.txt
   ```
4. `Start Command`:
   ```bash
   uvicorn main:app --host 0.0.0.0 --port $PORT
   ```
5. Variables d'environnement minimales:
   - `TELEGRAM_API_ID`
   - `TELEGRAM_API_HASH`

Option recommandé pour éviter la perte de session après redéploiement: ajouter `TELEGRAM_SESSION` (StringSession Telethon exportée).

## Logs

Chaque message entrant est loggé avec état:
- `alert_accepted ...`
- `alert_rejected ...`
- `alert_duplicate ...`

Format: timestamp + niveau + message structuré.
