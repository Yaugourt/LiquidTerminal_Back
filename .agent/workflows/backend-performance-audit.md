---
description: Audit de performance complet du backend Express/Prisma/PostgreSQL/Redis
---

# Backend Performance Audit Workflow

Ce workflow guide l'audit de performance du backend LiquidTerminal. Chaque phase peut être exécutée indépendamment.

---

## Phase 1 : Analyse & Profilage

### 1.1 Audit des requêtes Prisma (N+1, indexes)

1. Lister tous les fichiers repositories et services:
```bash
find src/repositories src/services -name "*.ts" -type f
```

2. Rechercher les patterns problématiques:
```bash
# Requêtes sans select (over-fetching)
grep -rn "findMany\|findFirst\|findUnique" src/ --include="*.ts" | grep -v "select:"

# Boucles avec requêtes (N+1 potentiels)
grep -rn "for.*await.*prisma\|forEach.*await.*prisma" src/ --include="*.ts"

# Requêtes sans pagination
grep -rn "findMany" src/ --include="*.ts" | grep -v "take:\|skip:"
```

3. Analyser le schema Prisma pour les indexes manquants:
```bash
cat prisma/schema.prisma | grep -A5 "model "
```

4. **Critères de détection:**
   - [ ] Requêtes sans `select` explicite (over-fetching)
   - [ ] Boucles faisant des requêtes DB (N+1)
   - [ ] `findMany` sans pagination
   - [ ] Relations chargées sans `include` optimisé
   - [ ] Champs fréquemment filtrés sans `@@index`

---

### 1.2 Audit du cache Redis

1. Analyser l'utilisation actuelle de Redis:
```bash
grep -rn "redis\|Redis\|ioredis" src/ --include="*.ts"
```

2. Identifier les endpoints sans cache qui devraient en avoir:
   - [ ] Données statiques ou rarement modifiées
   - [ ] Endpoints fréquemment appelés
   - [ ] Calculs coûteux répétés

3. Vérifier les TTL des caches existants:
```bash
grep -rn "setex\|expire\|EX\|PX" src/ --include="*.ts"
```

---

### 1.3 Audit des endpoints

1. Lister toutes les routes:
```bash
grep -rn "router\.\(get\|post\|put\|delete\|patch\)" src/routes --include="*.ts"
```

2. Identifier les routes potentiellement lentes:
   - [ ] Routes avec multiples appels DB
   - [ ] Routes sans pagination
   - [ ] Routes avec calculs complexes

3. Vérifier les logs de performance (si disponibles):
```bash
# Analyser les temps de réponse dans les logs
cat logs/*.log | grep -E "duration|ms|latency" | head -50
```

---

### 1.4 Analyse mémoire et async

1. Rechercher les patterns de concurrence:
```bash
# Appels séquentiels qui pourraient être parallèles
grep -rn "await.*\nawait" src/ --include="*.ts" | head -20

# Promise.all existants
grep -rn "Promise\.all" src/ --include="*.ts"
```

2. Rechercher les fuites potentielles:
```bash
# Event listeners non nettoyés
grep -rn "\.on\(.*\)" src/ --include="*.ts" | grep -v "removeListener\|off("

# Intervalles non nettoyés
grep -rn "setInterval" src/ --include="*.ts"
```

---

## Phase 2 : Optimisations Base de Données

### 2.1 Ajouter les indexes manquants

1. Ouvrir `prisma/schema.prisma`
2. Pour chaque champ fréquemment filtré, ajouter un index:
```prisma
model Example {
  id        String   @id
  userId    String
  createdAt DateTime
  
  @@index([userId])
  @@index([createdAt])
}
```

// turbo
3. Générer le client Prisma:
```bash
npx prisma generate
```

4. Créer la migration:
```bash
npx prisma migrate dev --name add_performance_indexes
```

---

### 2.2 Optimiser les requêtes

1. Ajouter `select` explicite aux requêtes:
```typescript
// ❌ Avant
const users = await prisma.user.findMany()

// ✅ Après
const users = await prisma.user.findMany({
  select: { id: true, name: true, email: true }
})
```

2. Remplacer les boucles N+1 par des includes/joins:
```typescript
// ❌ N+1
for (const user of users) {
  const posts = await prisma.post.findMany({ where: { userId: user.id } })
}

// ✅ Include
const users = await prisma.user.findMany({
  include: { posts: true }
})
```

3. Ajouter la pagination partout:
```typescript
const items = await prisma.item.findMany({
  take: limit,
  skip: offset,
  orderBy: { createdAt: 'desc' }
})
```

---

### 2.3 Vérifier le connection pooling

1. Vérifier la config PostgreSQL dans `.env`:
```
DATABASE_URL="postgresql://user:pass@host:5432/db?connection_limit=10"
```

2. Vérifier la création du client Prisma (singleton pattern):
```bash
grep -rn "new PrismaClient" src/ --include="*.ts"
```

---

## Phase 3 : Optimisations Applicatives

### 3.1 Améliorer le caching Redis

1. Template pour ajouter du cache:
```typescript
async function getCachedData<T>(
  key: string,
  fetcher: () => Promise<T>,
  ttlSeconds: number = 300
): Promise<T> {
  const cached = await redis.get(key);
  if (cached) return JSON.parse(cached);
  
  const data = await fetcher();
  await redis.setex(key, ttlSeconds, JSON.stringify(data));
  return data;
}
```

2. Données candidates au cache:
   - Statistiques globales (TTL: 5-15 min)
   - Listes de tokens/projets (TTL: 1-5 min)
   - Données utilisateur (TTL: 1 min, invalidation on write)

---

### 3.2 Paralléliser les appels

1. Identifier les appels séquentiels indépendants et les remplacer:
```typescript
// ❌ Séquentiel
const users = await getUsers();
const stats = await getStats();
const config = await getConfig();

// ✅ Parallèle
const [users, stats, config] = await Promise.all([
  getUsers(),
  getStats(),
  getConfig()
]);
```

---

### 3.3 Activer la compression

1. Vérifier si la compression est activée:
```bash
grep -rn "compression" src/ --include="*.ts"
```

2. Si non, ajouter dans `app.ts`:
```typescript
import compression from 'compression';
app.use(compression());
```

// turbo
3. Installer si nécessaire:
```bash
npm install compression @types/compression
```

---

## Phase 4 : Vérification & Monitoring

### 4.1 Ajouter des métriques de performance

1. Créer un middleware de logging des temps de réponse:
```typescript
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    if (duration > 1000) {
      logger.warn({ path: req.path, duration }, 'Slow request');
    }
  });
  next();
});
```

---

### 4.2 Tester les améliorations

// turbo
1. Build le projet:
```bash
npm run build
```

2. Tester les endpoints critiques avec curl:
```bash
time curl -s http://localhost:3000/api/health
time curl -s http://localhost:3000/api/stats
```

3. Comparer les temps avant/après optimisation

---

## Checklist Finale

- [ ] **Phase 1**: Analyse complète effectuée
- [ ] **Phase 2**: Indexes ajoutés, requêtes optimisées
- [ ] **Phase 3**: Cache implémenté, appels parallélisés
- [ ] **Phase 4**: Métriques ajoutées, tests de performance passés

---

## Notes

- Prioriser les endpoints les plus utilisés
- Documenter les gains de performance mesurés
- Créer des tests de régression pour les optimisations critiques
