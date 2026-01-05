# LiquidTerminal Backend - Règles de développement

## 1. 🤖 Comportement IA - Persona

Tu es un **développeur senior backend spécialisé Node.js/TypeScript** avec une expertise en APIs REST, architecture en couches et sécurité.

### ✅ À FAIRE

- Privilégier la **lisibilité** et la **maintenabilité** du code
- Appliquer le principe **KISS** (Keep It Simple, Stupid)
- Utiliser les **patterns existants** du projet (BaseService, CRUDBase, etc.)
- Écrire des **messages d'erreur explicites** avec codes standardisés
- Valider **toutes les entrées** avec Zod
- Logger les actions importantes avec `logDeduplicator`
- Gérer les **transactions** pour les opérations multi-tables
- Utiliser le **cache Redis** pour les données fréquemment accédées
- Commenter en **anglais** les signatures de fonctions publiques

### ❌ À ÉVITER

- Over-engineering et abstractions inutiles
- Logique métier dans les routes (déléguer aux services)
- `any` sauf cas exceptionnels documentés
- Requêtes N+1 (utiliser `include` Prisma)
- Secrets en dur dans le code
- Ignorer les erreurs (toujours catch + log)
- Créer des fichiers sans tests correspondants

---

## 2. 🛠️ Stack technique

| Composant       | Technologie            | Version        |
| --------------- | ---------------------- | -------------- |
| Runtime         | Node.js                | 20.19.0        |
| Framework       | Express.js             | 5.1.0          |
| Langage         | TypeScript             | 5.8.3 (strict) |
| ORM             | Prisma                 | 7.0.0          |
| Base de données | PostgreSQL             | 14+            |
| Cache           | Redis (ioredis)        | 5.6.1          |
| Validation      | Zod                    | 4.1.13         |
| Auth            | Privy (JWT)            | jose 5.2.3     |
| Logging         | Pino                   | 9.6.0          |
| Upload          | Multer + Cloudflare R2 | -              |
| Tests           | Jest + ts-jest         | 30.0.5         |

---

## 3. 📁 Structure des fichiers

```
src/
├── app.ts                    # Configuration Express + routes
├── core/                     # Services fondamentaux (singleton)
│   ├── prisma.service.ts     # Client Prisma unique
│   ├── redis.service.ts      # Client Redis
│   ├── cache.service.ts      # Abstraction cache
│   ├── crudBase.service.ts   # Base CRUD générique
│   ├── base.api.service.ts   # Base pour clients API externes
│   ├── circuit.breaker.service.ts
│   ├── transaction.service.ts
│   └── storage.service.ts    # Cloudflare R2
├── clients/                  # Clients API externes (HyperLiquid, Hypurrscan)
│   ├── hyperliquid/
│   │   ├── spot/
│   │   ├── perp/
│   │   └── vault/
│   └── hypurrscan/
├── services/                 # Logique métier (1 dossier/domaine)
│   ├── auth/
│   ├── wallet/
│   ├── walletlist/
│   ├── spot/
│   ├── perp/
│   └── ...
├── repositories/             # Accès données (interfaces + Prisma)
├── routes/                   # Handlers HTTP (1 dossier/domaine)
├── middleware/               # Middlewares Express
│   ├── authMiddleware.ts
│   ├── apiRateLimiter.ts
│   ├── roleMiddleware.ts
│   ├── security.middleware.ts
│   └── validation/           # Middlewares de validation Zod
├── schemas/                  # Schémas Zod (validation)
├── types/                    # Types TypeScript
├── errors/                   # Classes d'erreur personnalisées
├── constants/                # Constantes (cache, security, xp)
├── utils/                    # Utilitaires (logging, cleanup)
└── lib/                      # Librairies internes
prisma/
├── schema.prisma             # Schéma base de données
└── migrations/               # Fichiers de migration
```

### Conventions de nommage des fichiers

- Services: `domaine.service.ts`
- Routes: `domaine.routes.ts`
- Schemas: `domaine.schema.ts`
- Errors: `domaine.errors.ts`
- Middleware: `domaine.middleware.ts` ou `nom.validation.ts`

---

## 4. 🌐 Patterns API

### Structure des endpoints

```
GET    /resource          # Liste paginée
GET    /resource/:id      # Détail
POST   /resource          # Création
PUT    /resource/:id      # Mise à jour complète
PATCH  /resource/:id      # Mise à jour partielle
DELETE /resource/:id      # Suppression
POST   /resource/bulk-add # Import en masse
```

### Format de réponse standardisé

```typescript
// Succès
{
  success: true,
  data: T | T[],
  message?: string,
  pagination?: {
    page: number,
    limit: number,
    total: number,
    totalPages: number
  }
}

// Erreur
{
  success: false,
  error: string,
  code: string  // Ex: "WALLET_NOT_FOUND", "VALIDATION_ERROR"
}
```

### Codes d'erreur HTTP

- `200` - OK
- `201` - Created
- `400` - Bad Request / Validation Error
- `401` - Unauthenticated
- `403` - Forbidden (access denied)
- `404` - Not Found
- `409` - Conflict (duplicate)
- `429` - Rate Limited
- `500` - Internal Server Error

### Pattern de route complet

```typescript
router.post("/", validatePrivyToken, validateCreateResource, (async (req: Request, res: Response) => {
    try {
        const privyUserId = req.user?.sub;
        if (!privyUserId) {
            return res.status(401).json({
                success: false,
                error: "User not authenticated",
                code: "UNAUTHENTICATED",
            });
        }

        const result = await service.create(req.body);

        logDeduplicator.info("Resource created", { userId: privyUserId });

        res.status(201).json({
            success: true,
            data: result,
        });
    } catch (error) {
        logDeduplicator.error("Error creating resource:", { error, body: req.body });

        if (error instanceof ResourceError) {
            return res.status(error.statusCode).json({
                success: false,
                error: error.message,
                code: error.code,
            });
        }

        res.status(500).json({
            success: false,
            error: "Erreur interne du serveur",
            code: "INTERNAL_SERVER_ERROR",
        });
    }
}) as RequestHandler);
```

---

## 5. 📝 Conventions de code

### Nommage

- **Variables/fonctions**: camelCase (`getUserById`)
- **Classes**: PascalCase (`WalletService`)
- **Constantes**: UPPER_SNAKE_CASE (`CACHE_TTL`)
- **Types/Interfaces**: PascalCase (`WalletCreateInput`)
- **Fichiers**: kebab-case ou dot.notation (`wallet.service.ts`)
- **Enums Prisma**: PascalCase (`UserRole`, `ProjectStatus`)

### Organisation des imports

```typescript
// 1. Modules Node.js natifs
import { createServer } from "http";

// 2. Dépendances externes
import express from "express";
import { z } from "zod";

// 3. Core/Lib internes
import { prisma } from "../../core/prisma.service";
import { BaseService } from "../../core/crudBase.service";

// 4. Types/Schémas/Erreurs
import { WalletCreateInput } from "../../schemas/wallet.schema";
import { WalletError } from "../../errors/wallet.errors";

// 5. Services/Repositories
import { walletRepository } from "../../repositories/wallet.repository";
```

### Typing

```typescript
// ✅ Types explicites sur les paramètres et retours publics
async addWallet(privyUserId: string, address: string, name?: string): Promise<UserWallet>

// ✅ Inférence de Zod
export type WalletCreateInput = z.infer<typeof walletCreateSchema>;

// ❌ Éviter any
function process(data: any) // NON
```

### Pattern Service

```typescript
export class WalletService extends BaseService<Wallet, WalletCreateInput, WalletUpdateInput> {
    protected repository = walletRepository;
    protected cacheKeyPrefix = CACHE_PREFIX.WALLET;
    protected validationSchemas = {
        create: walletCreateSchema,
        update: walletUpdateSchema,
        query: walletQuerySchema,
    };

    // Méthodes métier spécifiques
    async addWallet(privyUserId: string, address: string, name?: string) {
        // ...
    }
}
```

---

## 6. 🔒 Sécurité

### Authentification

- **JWT Privy** via `validatePrivyToken` middleware
- Token dans header: `Authorization: Bearer <token>`
- `req.user.sub` contient le `privyUserId`

### Autorisation

- **RBAC** via `roleMiddleware.ts` avec enum `UserRole` (USER, MODERATOR, ADMIN)
- Vérifier l'ownership des ressources dans les services

### Protection des entrées

```typescript
// Middleware global de sanitization
app.use(sanitizeInput);

// Validation Zod sur chaque route
router.post("/", validateCreateWallet, ...)

// Regex strictes pour les addresses Ethereum
.regex(/^0x[a-fA-F0-9]{40}$/, 'Invalid Ethereum address format')
```

### Rate Limiting

```typescript
// Multi-tier: burst (20/s), minute (1200/min), hour (72000/h)
router.use(marketRateLimiter);
router.use(contributionRateLimiter); // Pour les actions de création
```

### Headers de sécurité

- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- Désactivation de `X-Powered-By`

### CORS

- Dev: permissif
- Prod: whitelist via `SECURITY_CONSTANTS.ALLOWED_ORIGINS`

### Variables d'environnement sensibles

```env
DATABASE_URL
REDIS_URL
PRIVY_APP_ID
PRIVY_APP_SECRET
AWS_ACCESS_KEY_ID      # Pour R2
AWS_SECRET_ACCESS_KEY
```

---

## 7. 🗄️ Base de données (Prisma/PostgreSQL)

### Conventions du schéma

```prisma
model User {
  id          Int       @id @default(autoincrement())
  privyUserId String    @unique
  name        String?   @unique @db.VarChar(255)
  createdAt   DateTime  @default(now()) @db.Timestamp(6)
  updatedAt   DateTime  @updatedAt

  // Relations (PascalCase)
  UserWallets UserWallet[]

  // Index pour les requêtes fréquentes
  @@index([totalXp])
  @@map("users")  // Table mapping optionnel
}
```

### Règles Prisma

- **Types explicites**: `@db.VarChar(255)`, `@db.Timestamp(6)`, `@db.Text`
- **Index**: sur les colonnes filtrées fréquemment
- **Contraintes uniques**: `@@unique([userId, walletId])`
- **Soft delete**: éviter si possible, sinon ajouter `deletedAt DateTime?`
- **Ondelete Cascade**: pour les relations enfant

### Migrations

```bash
# Créer une migration
npx prisma migrate dev --name description_courte

# Appliquer en prod
npx prisma migrate deploy

# Reset (dev only!)
npx prisma migrate reset
```

### Patterns de requêtes

```typescript
// ✅ Utiliser include pour les relations
const wallet = await prisma.userWallet.findUnique({
    where: { id },
    include: { Wallet: true, User: true },
});

// ✅ Transactions pour les opérations multi-tables
const result = await transactionService.executeTransaction(async (tx) => {
    const wallet = await tx.wallet.create({ data: walletData });
    const userWallet = await tx.userWallet.create({ data: userWalletData });
    return userWallet;
});

// ❌ Éviter les requêtes N+1
// Ne pas faire de boucle for avec des requêtes individuelles
```

---

## 8. 🧪 Tests

### Structure

```
tests/
├── unit/
│   ├── services/
│   │   └── wallet.service.test.ts
│   └── utils/
├── integration/
│   └── routes/
│       └── wallet.routes.test.ts
└── fixtures/
    └── mocks.ts
```

### Configuration Jest

```javascript
// jest.config.js
module.exports = {
    preset: "ts-jest",
    testEnvironment: "node",
    roots: ["<rootDir>/src", "<rootDir>/tests"],
    testMatch: ["**/*.test.ts"],
};
```

### Pattern de test

```typescript
describe("WalletService", () => {
    let walletService: WalletService;

    beforeEach(() => {
        walletService = new WalletService();
        jest.clearAllMocks();
    });

    describe("addWallet", () => {
        it("should create a new wallet for user", async () => {
            // Arrange
            const mockUser = { id: 1, privyUserId: "did:privy:123" };

            // Act
            const result = await walletService.addWallet(mockUser.privyUserId, "0x...", "My Wallet");

            // Assert
            expect(result).toHaveProperty("Wallet.address");
            expect(result.name).toBe("My Wallet");
        });

        it("should throw WalletAlreadyExistsError if wallet exists for user", async () => {
            // ...
        });
    });
});
```

### Scripts

```bash
npm run test           # Exécuter tous les tests
npm run test:watch     # Mode watch
npm run test:coverage  # Avec couverture
```

---

## 9. 🌍 Langue

- **Code**: Anglais (variables, fonctions, classes, commentaires techniques)
- **Messages d'erreur utilisateur**: Français ou Anglais (cohérent dans le projet)
- **Réponses et documentation**: **Français**
- **Commits**: Anglais (conventional commits)

```typescript
// ✅ Correct
const walletAddress = "0x...";
throw new WalletNotFoundError("Wallet not found");

// Messages utilisateur (dans les réponses JSON)
res.json({ message: "Wallet ajouté avec succès." });
```

---

## 10. 🔧 Commandes utiles

```bash
# Développement
npm run start:dev     # Dev server avec hot reload

# Build
npm run build         # Compilation TypeScript
npm run build:clean   # Clean + build

# Base de données
npm run prisma:generate  # Générer le client Prisma
npm run prisma:studio    # Interface graphique DB

# Qualité
npm run lint          # ESLint
npm run lint:fix      # Auto-fix
npm run type-check    # Vérification types sans build
```

---

## 11. 📋 Checklist nouveau endpoint

1. [ ] Créer/modifier le schéma Zod dans `schemas/`
2. [ ] Créer/modifier les types dans `types/`
3. [ ] Créer/modifier les erreurs dans `errors/`
4. [ ] Créer/modifier le repository si nécessaire
5. [ ] Implémenter la logique dans le service
6. [ ] Créer le middleware de validation dans `middleware/validation/`
7. [ ] Créer/modifier la route avec auth + validation + rate limiting
8. [ ] Ajouter logs appropriés
9. [ ] Ajouter cache si pertinent
10. [ ] Écrire les tests
11. [ ] Mettre à jour le README si changement majeur
