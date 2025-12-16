# 🎮 Système XP/Niveau - Documentation Backend

> **Version:** 2.0  
> **Date:** 2 Décembre 2025  
> **Status:** ✅ Implémenté - Prêt pour production

---

## 📋 Résumé

Le backend expose un système complet de points d'expérience (XP) et de niveaux pour gamifier l'expérience utilisateur. L'XP est attribué automatiquement lors de certaines actions et peut être consulté via des endpoints dédiés.

### 🆕 Nouveautés v2.0
- **Daily Tasks** : 4 tâches quotidiennes à compléter pour de l'XP bonus
- **Weekly Challenges** : 4 défis hebdomadaires avec récompenses XP
- **Daily Caps** : Limites anti-farm sur les actions répétables
- **Nouveaux endpoints** : `/xp/daily-tasks`, `/xp/weekly-challenges`, `/xp/daily-limits`

---

## 🔗 Endpoints XP

### Base URL
```
Production: https://api.votre-domaine.com   
Development: http://localhost:3002
```

---

### 1️⃣ GET /xp/stats
> Récupère les statistiques XP de l'utilisateur connecté

**Authentification:** 🔒 Requise (Bearer Token)

**Response 200:**
```json
{
  "success": true,
  "data": {
    "totalXp": 150,
    "level": 2,
    "currentLevelXp": 100,
    "nextLevelXp": 283,
    "progressPercent": 27,
    "xpToNextLevel": 133,
    "loginStreak": 3,
    "lastLoginAt": "2025-11-27T10:00:00.000Z"
  }
}
```

| Champ | Type | Description |
|-------|------|-------------|
| `totalXp` | number | Total d'XP accumulé |
| `level` | number | Niveau actuel (1+) |
| `currentLevelXp` | number | XP requis pour le niveau actuel |
| `nextLevelXp` | number | XP requis pour le prochain niveau |
| `progressPercent` | number | Progression vers le prochain niveau (0-100) |
| `xpToNextLevel` | number | XP restant pour level up |
| `loginStreak` | number | Jours consécutifs de connexion |
| `lastLoginAt` | string \| null | Date du dernier login |

---

### 2️⃣ POST /xp/daily-login
> Enregistre un login quotidien et attribue l'XP

**Authentification:** 🔒 Requise (Bearer Token)

**Body:** Aucun (vide)

**⚠️ IMPORTANT:** Appeler cet endpoint **une fois par session** lors de la connexion de l'utilisateur.

**Response 200 (XP accordé):**
```json
{
  "success": true,
  "message": "Daily login XP granted",
  "data": {
    "xpGranted": 10,
    "streakBonus": 0,
    "newStreak": 4
  }
}
```

**Response 200 (déjà connecté aujourd'hui):**
```json
{
  "success": true,
  "message": "Already logged in today",
  "data": {
    "xpGranted": 0,
    "streakBonus": 0,
    "newStreak": 4
  }
}
```

| Champ | Type | Description |
|-------|------|-------------|
| `xpGranted` | number | XP accordé pour le login (10 ou 0) |
| `streakBonus` | number | Bonus streak (50 pour 7j, 200 pour 30j) |
| `newStreak` | number | Nouveau compteur de streak |

---

### 3️⃣ GET /xp/history
> Historique des transactions XP

**Authentification:** 🔒 Requise (Bearer Token)

**Query params:**
| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `page` | number | 1 | Page courante |
| `limit` | number | 20 | Éléments par page (max 100) |
| `actionType` | string | - | Filtre par type d'action |

**Response 200:**
```json
{
  "success": true,
  "data": {
    "transactions": [
      {
        "id": 1,
        "actionType": "REGISTRATION",
        "xpAmount": 100,
        "description": "Welcome bonus for registration",
        "createdAt": "2025-11-27T09:00:00.000Z"
      }
    ],
    "pagination": {
      "page": 1,
      "limit": 20,
      "total": 5,
      "totalPages": 1
    }
  }
}
```

---

### 4️⃣ GET /xp/leaderboard
> Classement des utilisateurs par XP

**Authentification:** 🌐 Optionnelle (si fournie, retourne `userRank`)

**Query params:**
| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `page` | number | 1 | Page courante |
| `limit` | number | 20 | Éléments par page (max 100) |

**Response 200:**
```json
{
  "success": true,
  "data": {
    "leaderboard": [
      { "rank": 1, "userId": 5, "name": "alice", "totalXp": 1500, "level": 8 },
      { "rank": 2, "userId": 12, "name": "bob", "totalXp": 1200, "level": 7 }
    ],
    "userRank": 15,
    "total": 100
  }
}
```

> ℹ️ `userRank` n'est présent que si l'utilisateur est authentifié

---

## 🆕 Daily Tasks (Tâches Quotidiennes)

### 5️⃣ GET /xp/daily-tasks
> Récupère les daily tasks du jour avec leur statut de complétion

**Authentification:** 🔒 Requise (Bearer Token)

**Response 200:**
```json
{
  "success": true,
  "data": {
    "tasks": [
      {
        "type": "LOGIN",
        "description": "Se connecter",
        "xp": 10,
        "completed": true,
        "completedAt": "2025-12-02T10:00:00.000Z"
      },
      {
        "type": "READ_RESOURCE",
        "description": "Lire une ressource",
        "xp": 5,
        "completed": false,
        "completedAt": null
      },
      {
        "type": "ADD_WALLET",
        "description": "Ajouter un wallet à une liste",
        "xp": 5,
        "completed": false,
        "completedAt": null
      },
      {
        "type": "EXPLORE_LEADERBOARD",
        "description": "Explorer le leaderboard",
        "xp": 5,
        "completed": false,
        "completedAt": null
      }
    ],
    "allCompleted": false,
    "bonusXp": 15,
    "bonusClaimed": false
  }
}
```

| Champ | Type | Description |
|-------|------|-------------|
| `tasks` | array | Liste des 4 daily tasks |
| `tasks[].type` | string | Type de la task (LOGIN, READ_RESOURCE, ADD_WALLET, EXPLORE_LEADERBOARD) |
| `tasks[].completed` | boolean | Si la task est complétée aujourd'hui |
| `allCompleted` | boolean | True si toutes les tasks sont complétées |
| `bonusXp` | number | XP bonus si toutes les tasks sont complétées (15) |
| `bonusClaimed` | boolean | True si le bonus a déjà été attribué |

---

### 6️⃣ POST /xp/daily-tasks/:type
> Complète manuellement une daily task

**Authentification:** 🔒 Requise (Bearer Token)

**⚠️ Seules certaines tasks peuvent être complétées manuellement :**
- `EXPLORE_LEADERBOARD` : À appeler quand l'utilisateur visite le leaderboard

Les autres tasks sont complétées **automatiquement** :
- `LOGIN` : Via POST /xp/daily-login
- `READ_RESOURCE` : Quand l'utilisateur marque une ressource comme lue
- `ADD_WALLET` : Quand l'utilisateur ajoute un wallet à une liste

**Response 200:**
```json
{
  "success": true,
  "message": "Daily task completed!",
  "data": {
    "xpGranted": 5,
    "allTasksCompleted": true,
    "bonusGranted": 15
  }
}
```

| Champ | Type | Description |
|-------|------|-------------|
| `xpGranted` | number | XP accordé pour la task (0 si déjà complétée) |
| `allTasksCompleted` | boolean | True si c'était la dernière task |
| `bonusGranted` | number | Bonus XP si toutes les tasks viennent d'être complétées |

---

## 🆕 Weekly Challenges (Défis Hebdomadaires)

### 7️⃣ GET /xp/weekly-challenges
> Récupère les challenges de la semaine en cours

**Authentification:** 🔒 Requise (Bearer Token)

**Response 200:**
```json
{
  "success": true,
  "data": {
    "challenges": [
      {
        "type": "READ_20_RESOURCES",
        "description": "Lire 20 ressources",
        "progress": 7,
        "target": 20,
        "progressPercent": 35,
        "xpReward": 100,
        "completed": false,
        "completedAt": null
      },
      {
        "type": "CREATE_5_READLISTS",
        "description": "Créer 5 readlists",
        "progress": 2,
        "target": 5,
        "progressPercent": 40,
        "xpReward": 75,
        "completed": false,
        "completedAt": null
      },
      {
        "type": "LOGIN_7_DAYS",
        "description": "Se connecter 7 jours",
        "progress": 3,
        "target": 7,
        "progressPercent": 42,
        "xpReward": 100,
        "completed": false,
        "completedAt": null
      },
      {
        "type": "ADD_15_WALLETS",
        "description": "Ajouter 15 wallets",
        "progress": 15,
        "target": 15,
        "progressPercent": 100,
        "xpReward": 100,
        "completed": true,
        "completedAt": "2025-12-01T15:30:00.000Z"
      }
    ],
    "weekStart": "2025-12-02T00:00:00.000Z",
    "weekEnd": "2025-12-08T23:59:59.999Z"
  }
}
```

| Champ | Type | Description |
|-------|------|-------------|
| `challenges` | array | Liste des 4 weekly challenges |
| `challenges[].progress` | number | Progression actuelle |
| `challenges[].target` | number | Objectif à atteindre |
| `challenges[].progressPercent` | number | % de progression (0-100) |
| `challenges[].xpReward` | number | XP attribué à la complétion |
| `weekStart` | string | Date de début de la semaine (lundi) |
| `weekEnd` | string | Date de fin de la semaine (dimanche) |

> ℹ️ Les challenges se réinitialisent automatiquement chaque **lundi à 00:00**  
> ℹ️ La progression est mise à jour automatiquement quand l'utilisateur fait les actions correspondantes

---

## 🆕 Daily Limits (Limites Quotidiennes Anti-Farm)

### 8️⃣ GET /xp/daily-limits
> Récupère les limites quotidiennes restantes pour les actions XP

**Authentification:** 🔒 Requise (Bearer Token)

**Response 200:**
```json
{
  "success": true,
  "data": {
    "limits": [
      {
        "actionType": "CREATE_READLIST",
        "used": 1,
        "max": 3,
        "remaining": 2,
        "xpPerAction": 15
      },
      {
        "actionType": "MARK_RESOURCE_READ",
        "used": 5,
        "max": 10,
        "remaining": 5,
        "xpPerAction": 5
      },
      {
        "actionType": "CREATE_WALLETLIST",
        "used": 0,
        "max": 3,
        "remaining": 3,
        "xpPerAction": 15
      },
      {
        "actionType": "ADD_WALLET_TO_LIST",
        "used": 10,
        "max": 10,
        "remaining": 0,
        "xpPerAction": 10
      },
      {
        "actionType": "COPY_PUBLIC_READLIST",
        "used": 2,
        "max": 5,
        "remaining": 3,
        "xpPerAction": 10
      },
      {
        "actionType": "CREATE_EDUCATIONAL_CATEGORY",
        "used": 0,
        "max": 2,
        "remaining": 2,
        "xpPerAction": 30
      },
      {
        "actionType": "ADD_EDUCATIONAL_RESOURCE",
        "used": 3,
        "max": 5,
        "remaining": 2,
        "xpPerAction": 25
      }
    ]
  }
}
```

| Champ | Type | Description |
|-------|------|-------------|
| `actionType` | string | Type d'action avec limite |
| `used` | number | Nombre d'actions effectuées aujourd'hui |
| `max` | number | Limite quotidienne |
| `remaining` | number | Actions restantes aujourd'hui |
| `xpPerAction` | number | XP par action |

> ⚠️ Une fois la limite atteinte (`remaining: 0`), l'action ne donnera plus d'XP jusqu'au lendemain

---

## 🎁 Endpoints qui retournent `xpGranted`

Les endpoints suivants incluent **automatiquement** un champ `xpGranted` dans leur réponse :

| Endpoint | Méthode | xpGranted | Condition |
|----------|---------|-----------|-----------|
| `/readlists` | POST | 15 | Toujours |
| `/readlists/copy/:id` | POST | 25 | Toujours (copy + create) |
| `/readlists/items/:itemId/read-status` | PATCH | 5 | Seulement si marqué lu pour la 1ère fois |
| `/walletlists` | POST | 15 | Toujours |
| `/walletlists/:id/items` | POST | 10 | Toujours |
| `/xp/daily-login` | POST | 10 | Seulement si pas déjà login aujourd'hui |

**Exemple de réponse avec XP:**
```json
{
  "success": true,
  "data": { ... },
  "xpGranted": 15
}
```

**⚠️ Pour les notifications XP :**
- Vérifier que `xpGranted > 0` avant d'afficher une notification
- Le champ peut être `0` si l'action ne donne pas d'XP (déjà effectuée, etc.)

---

## 📊 Types d'actions XP

### Actions sans limite
| Action | XP | Trigger |
|--------|-----|---------|
| `REGISTRATION` | 100 | Automatique à l'inscription (une fois) |
| `DAILY_LOGIN` | 10 | Via POST /xp/daily-login (1x/jour) |
| `LOGIN_STREAK_7` | 50 | Automatique au 7ème jour consécutif |
| `LOGIN_STREAK_30` | 200 | Automatique au 30ème jour consécutif |
| `REFERRAL_SUCCESS` | 200 | Automatique quand un filleul s'inscrit |
| `SUBMIT_PUBLIC_GOOD` | 100 | Via POST /publicgoods |
| `PUBLIC_GOOD_APPROVED` | 500 | Automatique quand admin approuve |

### Actions avec limite quotidienne (anti-farm)
| Action | XP | Max/jour | XP max/jour | Trigger |
|--------|-----|----------|-------------|---------|
| `CREATE_READLIST` | 15 | 3 | 45 | Via POST /readlists |
| `MARK_RESOURCE_READ` | 5 | 10 | 50 | Via PATCH /readlists/items/:id/read-status |
| `COPY_PUBLIC_READLIST` | 10 | 5 | 50 | Via POST /readlists/copy/:id |
| `CREATE_WALLETLIST` | 15 | 3 | 45 | Via POST /walletlists |
| `ADD_WALLET_TO_LIST` | 10 | 10 | 100 | Via POST /walletlists/:id/items |
| `CREATE_EDUCATIONAL_CATEGORY` | 30 | 2 | 60 | Via POST /educational/categories |
| `ADD_EDUCATIONAL_RESOURCE` | 25 | 5 | 125 | Via POST /educational/resources |

### Daily Tasks XP
| Task | XP | Trigger |
|------|-----|---------|
| `LOGIN` | 10 | Auto via POST /xp/daily-login |
| `READ_RESOURCE` | 5 | Auto quand on marque une ressource lue |
| `ADD_WALLET` | 5 | Auto quand on ajoute un wallet |
| `EXPLORE_LEADERBOARD` | 5 | Manuel via POST /xp/daily-tasks/EXPLORE_LEADERBOARD |
| **Bonus completion** | 15 | Auto si toutes les tasks sont complétées |

### Weekly Challenges XP
| Challenge | Target | XP Reward |
|-----------|--------|-----------|
| `READ_20_RESOURCES` | 20 ressources lues | 100 |
| `CREATE_5_READLISTS` | 5 readlists créées | 75 |
| `LOGIN_7_DAYS` | 7 jours de connexion | 100 |
| `ADD_15_WALLETS` | 15 wallets ajoutés | 100 |

### 📈 XP Maximum par jour
| Source | XP Max |
|--------|--------|
| Daily Tasks (4) + Bonus | 40 |
| Actions limitées | ~475 |
| **Total théorique** | **~515/jour** |
| Weekly Challenges | +375/semaine |

---

## 📈 Formule de niveau

```javascript
// XP requis pour atteindre le niveau N
xpForLevel(N) = 100 × (N - 1)^1.5

// Exemples:
// Niveau 1:  0 XP
// Niveau 2:  100 XP
// Niveau 3:  283 XP
// Niveau 5:  800 XP
// Niveau 10: 2,700 XP
// Niveau 20: 8,500 XP
```

---

## 🔄 Flow d'intégration recommandé

### 1. Au login/refresh de l'app
```typescript
// Appeler une seule fois par session
const loginResult = await api.post('/xp/daily-login');
if (loginResult.data.data.xpGranted > 0) {
  showXpNotification(loginResult.data.data.xpGranted);
  if (loginResult.data.data.streakBonus > 0) {
    showStreakBonus(loginResult.data.data.streakBonus);
  }
}

// Récupérer toutes les données XP en parallèle
const [stats, dailyTasks, weeklyChallenges, limits] = await Promise.all([
  api.get('/xp/stats'),
  api.get('/xp/daily-tasks'),
  api.get('/xp/weekly-challenges'),
  api.get('/xp/daily-limits'),
]);
```

### 2. Afficher le dashboard XP
```typescript
// Page ou modal dédiée aux daily tasks et weekly challenges
const XpDashboard = () => {
  const { data: dailyTasks } = useQuery('/xp/daily-tasks');
  const { data: weeklyChallenges } = useQuery('/xp/weekly-challenges');
  const { data: limits } = useQuery('/xp/daily-limits');
  
  return (
    <>
      {/* Daily Tasks Progress */}
      <DailyTasksList tasks={dailyTasks.tasks} />
      {dailyTasks.allCompleted && !dailyTasks.bonusClaimed && (
        <BonusClaimedBanner xp={dailyTasks.bonusXp} />
      )}
      
      {/* Weekly Challenges */}
      <WeeklyChallengesList challenges={weeklyChallenges.challenges} />
      
      {/* Daily Limits Warning */}
      {limits.limits.some(l => l.remaining === 0) && (
        <LimitsReachedWarning limits={limits.limits} />
      )}
    </>
  );
};
```

### 3. Marquer le leaderboard comme exploré
```typescript
// Quand l'utilisateur visite la page leaderboard
useEffect(() => {
  api.post('/xp/daily-tasks/EXPLORE_LEADERBOARD')
    .then(res => {
      if (res.data.data.xpGranted > 0) {
        showXpNotification(res.data.data.xpGranted);
        if (res.data.data.bonusGranted > 0) {
          showBonusNotification('All daily tasks completed!', res.data.data.bonusGranted);
        }
      }
    });
}, []);
```

### 4. Gérer les notifications XP sur les actions
```typescript
const response = await api.post('/readlists', data);
if (response.data.xpGranted > 0) {
  showXpNotification(response.data.xpGranted);
  // Refetch les données pour mettre à jour les progressions
  refetchXpStats();
  refetchDailyTasks(); // La task READ_RESOURCE peut avoir été complétée
  refetchWeeklyChallenges(); // La progression peut avoir changé
  refetchDailyLimits(); // Les limites ont changé
}
```

### 5. Afficher les limites atteintes
```typescript
// Vérifier avant de faire une action si la limite est atteinte
const limits = await api.get('/xp/daily-limits');
const readListLimit = limits.data.limits.find(l => l.actionType === 'CREATE_READLIST');

if (readListLimit.remaining === 0) {
  showWarning(`Daily limit reached! No more XP for creating readlists today.`);
}
```

---

## ⚠️ Points d'attention

### 1. Idempotence
- `POST /xp/daily-login` est idempotent : plusieurs appels le même jour retournent `xpGranted: 0`
- Les actions avec `referenceId` unique ne donnent l'XP qu'une fois
- `POST /xp/daily-tasks/:type` est idempotent : retourne `xpGranted: 0` si déjà complétée

### 2. Streak
- Le streak se reset à 1 si l'utilisateur ne se connecte pas pendant un jour
- Les bonus streak (7j, 30j) ne sont donnés qu'une seule fois par milestone

### 3. XP conditionnel
- `MARK_RESOURCE_READ` ne donne de l'XP que si la ressource n'était pas déjà lue
- Toujours vérifier `xpGranted > 0` avant d'afficher une notification
- **Vérifier `remaining > 0`** dans `/xp/daily-limits` pour savoir si une action donnera de l'XP

### 4. Erreurs
- Les erreurs d'attribution XP sont silencieuses côté backend (l'action principale réussit quand même)
- Si `xpGranted` est absent de la réponse, considérer comme `0`

### 5. 🆕 Daily Tasks
- Les tasks LOGIN, READ_RESOURCE, ADD_WALLET se complètent **automatiquement**
- Seule `EXPLORE_LEADERBOARD` doit être appelée manuellement via POST
- Le bonus de completion (15 XP) est attribué automatiquement quand la dernière task est complétée
- Les tasks se réinitialisent à **minuit (timezone serveur)**

### 6. 🆕 Weekly Challenges
- Les challenges se réinitialisent chaque **lundi à 00:00**
- La progression est mise à jour automatiquement quand l'utilisateur fait les actions correspondantes
- L'XP du challenge est attribué automatiquement à la complétion

### 7. 🆕 Daily Limits (Anti-Farm)
- Une fois la limite atteinte, l'action réussit mais **ne donne plus d'XP**
- Les limites se réinitialisent à **minuit (timezone serveur)**
- Afficher un warning à l'utilisateur quand `remaining === 0`

---

## 🧪 Tester l'intégration

### Via cURL
```bash
# Leaderboard (public)
curl http://localhost:3002/xp/leaderboard

# Stats (auth required)
curl http://localhost:3002/xp/stats \
  -H "Authorization: Bearer YOUR_TOKEN"

# Daily login (auth required)
curl -X POST http://localhost:3002/xp/daily-login \
  -H "Authorization: Bearer YOUR_TOKEN"
```

### Via Postman
1. Importer la collection
2. Configurer la variable `{{token}}` avec un JWT Privy valide
3. Tester les endpoints dans l'ordre : daily-login → stats → history

---

## 📝 Changelog

### v2.0 (02/12/2025) - 🆕 Anti-Farm & Engagement System
- ✅ **Daily Tasks** : 4 tâches quotidiennes (LOGIN, READ_RESOURCE, ADD_WALLET, EXPLORE_LEADERBOARD)
- ✅ **Daily Completion Bonus** : +15 XP si toutes les daily tasks sont complétées
- ✅ **Weekly Challenges** : 4 défis hebdomadaires avec progression automatique
- ✅ **Daily Caps** : Limites quotidiennes sur les actions répétables (anti-farm)
- ✅ **Nouveaux endpoints** : 
  - `GET /xp/daily-tasks` - État des daily tasks
  - `POST /xp/daily-tasks/:type` - Compléter manuellement une task
  - `GET /xp/weekly-challenges` - État des challenges hebdo
  - `GET /xp/daily-limits` - Limites quotidiennes restantes
- ✅ **Auto-completion** : Les daily tasks READ_RESOURCE et ADD_WALLET se complètent automatiquement
- ✅ **Fix Dockerfile** : Les migrations Prisma s'appliquent maintenant au démarrage

### v1.1 (29/11/2025)
- 🐛 Fix: Routes XP utilisaient `req.currentUser` qui n'était jamais défini
- ✅ Ajout helper `getUserFromRequest()` pour récupérer l'utilisateur depuis le token Privy
- ✅ Toutes les routes XP fonctionnent maintenant correctement avec l'authentification

### v1.0 (27/11/2025)
- ✅ Implémentation initiale du système XP
- ✅ Endpoints /xp/stats, /xp/daily-login, /xp/history, /xp/leaderboard
- ✅ Attribution automatique d'XP sur les actions existantes
- ✅ Champ `xpGranted` ajouté aux réponses des endpoints concernés
- ✅ Système de streak avec bonus 7j et 30j

---

## 🗂️ Fichiers du système XP

```
src/
├── constants/
│   └── xp.constants.ts        # Config XP rewards + formules niveau
├── types/
│   └── xp.types.ts            # Types TypeScript
├── repositories/
│   └── xp.repository.ts       # Accès base de données
├── services/
│   └── xp/
│       └── xp.service.ts      # Logique métier XP
├── routes/
│   └── xp/
│       └── xp.routes.ts       # Endpoints API
└── prisma/
    └── schema.prisma          # Modèles User (champs XP) + XpTransaction
```

---

## 🆘 Support

Pour toute question sur l'intégration, contacter l'équipe backend ou ouvrir une issue.



