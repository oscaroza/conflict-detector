# Conflict Detector - Dashboard de veille geopolitique

Application web interactive inspiree d'un tableau de bord de veille geopolitique type Conflictly.

## Ce que fait ce projet

- Carte mondiale interactive (Leaflet) avec zoom et clic sur pays.
- Detection automatique d'evenements via des flux RSS reels axes conflits (BBC, Al Jazeera, The Guardian, Google News conflict signals).
- Alertes en temps reel:
  - popup visuelle
  - son de notification
  - ajout instantane dans le fil d'alertes
- Filtres par:
  - type (geopolitique)
  - pays
  - region
  - gravite
  - lu/non lu
- Historique persistant en MongoDB (les alertes restent apres redemarrage).
- Actions sur alertes:
  - marquer lu/non lu
  - supprimer
  - ouvrir la source officielle
- Parametres detection:
  - pause/reprise
  - frequence de polling
  - mots-cles
  - pays cibles
- Statistiques simples (types, pays, alertes non lues).

## Stack technique

- Frontend: HTML, CSS, JavaScript (vanilla), Bootstrap, Leaflet, Chart.js
- Backend: Node.js + Express
- Base de donnees: MongoDB + Mongoose
- Flux data: RSS publics (pas de donnees fictives)

## Prerequis (simple)

1. **Node.js 18+** (verifier avec `node -v`)
2. **npm** (verifier avec `npm -v`)
3. **MongoDB** (local, Docker, ou Atlas)

---

## Installation pas a pas (niveau debutant)

### Etape 1 - Installer les dependances Node.js

Dans le dossier du projet:

```bash
npm install
```

Attendu: un dossier `node_modules` est cree.

### Etape 2 - Demarrer MongoDB

Vous avez 2 options. Prenez **Option A (Docker)** si possible, c'est le plus simple.

#### Option A - MongoDB avec Docker (recommande)

1. Verifiez Docker Desktop lance.
2. Dans le dossier du projet:

```bash
docker compose up -d
```

3. Verifiez que MongoDB tourne:

```bash
docker ps
```

Vous devez voir un conteneur `conflict-detector-mongo`.

#### Option B - MongoDB Atlas (cloud)

1. Creer un compte Atlas gratuit.
2. Creer un cluster gratuit.
3. Autoriser votre IP.
4. Creer un utilisateur base de donnees.
5. Recuperer l'URI de connexion.

---

### Etape 3 - Configurer les variables d'environnement

1. Dupliquez le fichier exemple:

```bash
cp .env.example .env
```

2. Ouvrez `.env` et adaptez:

```env
PORT=3000
MONGODB_URI=mongodb://127.0.0.1:27017/conflict_detector
POLL_INTERVAL_SECONDS=300
```

Si Atlas: remplacez `MONGODB_URI` par votre URI Atlas.

### Etape 4 - Lancer l'application

Mode developpement (redemarrage auto):

```bash
npm run dev
```

Mode normal:

```bash
npm start
```

Attendu dans le terminal: serveur actif sur `http://localhost:3000`.

### Etape 5 - Ouvrir le dashboard

- Ouvrez Chrome/Edge/Firefox.
- Allez sur `http://localhost:3000`.

---

## Utilisation pas a pas du dashboard

### 1) Lire les alertes

- Le panneau gauche affiche les alertes recentes.
- Chaque carte montre:
  - titre
  - type
  - gravite
  - pays
  - date
  - source

### 2) Voir le detail complet

- Cliquez sur une alerte.
- Le panneau droit affiche:
  - resume
  - source
  - horodatage
  - lien article officiel

### 3) Filtrer

Dans le panneau gauche, changez:
- Type
- Pays
- Region
- Gravite
- Lu / Non lu

Le resultat se met a jour automatiquement.

### 4) Interaction carte

- Zoomez/dezoomez sur la carte.
- Cliquez un pays pour filtrer les alertes sur ce pays.
- Les points rouges animes indiquent les alertes non lues.

### 5) Gestions alertes

Sur chaque alerte:
- `Marquer lu/non lu`
- `Supprimer`

### 6) Detection automatique

En haut:
- `Pause/Reprendre` pour stopper/reprendre la detection.
- `Frequence` pour choisir l'intervalle de mise a jour.
- `Analyser maintenant` pour forcer une detection immediate.

### 7) Alertes personnalisees (bonus)

- Entrez des mots-cles (ex: `ceasefire, missile, ukraine`).
- Selectionnez des pays cibles.
- Cliquez `Enregistrer ces preferences`.

Seules les nouvelles alertes correspondant a ces preferences seront ingerees.

---

## Sources de donnees publiques utilisees

- BBC World RSS
- Al Jazeera RSS
- The Guardian World RSS
- Google News (requetes geopolitique et signaux de conflit)

## Structure des fichiers

- `server.js`: entree backend
- `src/config/db.js`: connexion MongoDB
- `src/models/`: modeles Mongoose (`Alert`, `Settings`, `User`)
- `src/services/feedService.js`: ingestion RSS + classification + scheduler
- `src/routes/api.js`: API REST + SSE
- `public/index.html`: UI
- `public/styles.css`: design responsive
- `public/app.js`: logique frontend (map, filtres, notifications)

## API principale

- `GET /api/alerts`
- `GET /api/alerts/:id`
- `PATCH /api/alerts/:id/read`
- `DELETE /api/alerts/:id`
- `GET /api/settings`
- `PATCH /api/settings`
- `POST /api/detect/now`
- `GET /api/stats`
- `GET /api/stream` (SSE)

## Troubleshooting rapide

1. Erreur MongoDB connexion
- Verifiez `MONGODB_URI`
- Verifiez que MongoDB tourne

2. Aucune alerte nouvelle
- Cliquez `Analyser maintenant`
- Regardez les logs terminal (erreurs feed)
- Verifiez votre connexion internet

3. Pas de son notification
- Cliquez une fois dans la page pour autoriser l'audio navigateur

4. Port deja pris
- Modifiez `PORT` dans `.env` (ex: 3001)

## Compatibilite

- Chrome
- Edge
- Firefox

## Limites connues

- La detection du pays est basee sur analyse de texte (heuristique), donc pas parfaite.
- Certains flux RSS peuvent etre temporairement indisponibles.

---

## Commandes utiles

```bash
npm install
npm run dev
npm start
docker compose up -d
docker compose down
```
