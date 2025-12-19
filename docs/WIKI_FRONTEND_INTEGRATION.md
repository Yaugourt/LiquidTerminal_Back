# Wiki Contribution System - Frontend Integration Guide

## Overview

Le backend a été mis à jour pour permettre à **tous les utilisateurs connectés** de soumettre des ressources au wiki. Les soumissions passent par une queue de modération avant d'être publiques.

---

## Nouveaux Endpoints API

### Base URL: `/api/educational/resources`

---

## 1. Soumettre une Ressource (Utilisateur)

**Endpoint:** `POST /api/educational/resources`  
**Auth:** Token Privy requis  
**Role:** Tout utilisateur connecté (USER, MODERATOR, ADMIN)  
**Rate Limit:** 5 soumissions par jour par utilisateur

### Request
```typescript
interface SubmitResourceRequest {
  url: string;          // URL de la ressource (HTTPS requis)
  categoryIds?: number[]; // IDs des catégories (optionnel)
}
```

### Response (201 Created)
```typescript
interface SubmitResourceResponse {
  success: true;
  message: "Resource submitted successfully. It will be reviewed by a moderator.";
  data: EducationalResource;
}
```

### Possible Errors
| Code | Status | Description |
|------|--------|-------------|
| `RATE_LIMIT_EXCEEDED` | 429 | Limite de 5 soumissions/jour atteinte |
| `CONTENT_FILTERED` | 400 | URL bloquée (domaine blacklisté, pattern malveillant) |
| `EDUCATIONAL_INVALID_URL` | 400 | URL invalide ou non-HTTPS |
| `EDUCATIONAL_RESOURCE_ALREADY_EXISTS` | 400 | URL déjà soumise |

### Headers de réponse
```
X-RateLimit-Limit: 5
X-RateLimit-Remaining: 4
```

---

## 2. Signaler une Ressource (Utilisateur)

**Endpoint:** `POST /api/educational/resources/:id/report`  
**Auth:** Token Privy requis  
**Role:** Tout utilisateur connecté

### Request
```typescript
interface ReportResourceRequest {
  reason: string;  // 1-500 caractères
}
```

### Response (201 Created)
```typescript
interface ReportResponse {
  success: true;
  message: "Report submitted successfully";
  data: {
    id: number;
    resourceId: number;
    reportedBy: number;
    reason: string;
    createdAt: string;
  };
}
```

### Possible Errors
| Code | Status | Description |
|------|--------|-------------|
| `DUPLICATE_REPORT` | 409 | L'utilisateur a déjà signalé cette ressource |
| `REPORT_REASON_REQUIRED` | 400 | Raison manquante |
| `REPORT_REASON_TOO_LONG` | 400 | Raison > 500 caractères |

---

## 3. Modération - Ressources en Attente

**Endpoint:** `GET /api/educational/resources/moderation/pending`  
**Auth:** Token Privy requis  
**Role:** MODERATOR, ADMIN uniquement

### Query Parameters
```
?page=1&limit=20
```

### Response
```typescript
interface PendingResourcesResponse {
  success: true;
  data: EducationalResource[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
    hasNext: boolean;
    hasPrevious: boolean;
  };
}
```

---

## 4. Modération - Compter les Ressources en Attente

**Endpoint:** `GET /api/educational/resources/moderation/pending/count`  
**Auth:** Token Privy requis  
**Role:** MODERATOR, ADMIN

### Response
```typescript
{
  success: true;
  data: { count: number };
}
```

---

## 5. Approuver une Ressource

**Endpoint:** `PATCH /api/educational/resources/:id/approve`  
**Auth:** Token Privy requis  
**Role:** MODERATOR, ADMIN

### Request
```typescript
interface ApproveRequest {
  notes?: string;  // Note optionnelle du modérateur
}
```

### Response
```typescript
{
  success: true;
  message: "Resource approved successfully";
  data: EducationalResource;
}
```

---

## 6. Rejeter une Ressource

**Endpoint:** `PATCH /api/educational/resources/:id/reject`  
**Auth:** Token Privy requis  
**Role:** MODERATOR, ADMIN

### Request
```typescript
interface RejectRequest {
  notes: string;  // Raison du rejet (OBLIGATOIRE)
}
```

### Response
```typescript
{
  success: true;
  message: "Resource rejected successfully";
  data: EducationalResource;
}
```

### Possible Errors
| Code | Status | Description |
|------|--------|-------------|
| `REJECTION_REASON_REQUIRED` | 400 | Raison de rejet obligatoire |
| `RESOURCE_ALREADY_REVIEWED` | 400 | Ressource déjà approuvée/rejetée |

---

## 7. Voir les Signalements (Modérateurs)

**Endpoint:** `GET /api/educational/resources/moderation/reports`  
**Auth:** Token Privy requis  
**Role:** MODERATOR, ADMIN

### Query Parameters
```
?page=1&limit=20&resourceId=123  // resourceId optionnel pour filtrer
```

---

## 8. Signalements d'une Ressource Spécifique

**Endpoint:** `GET /api/educational/resources/:id/reports`  
**Auth:** Token Privy requis  
**Role:** MODERATOR, ADMIN

---

## Types Mis à Jour

### EducationalResource (avec nouveaux champs)

```typescript
interface EducationalResource {
  id: number;
  url: string;
  createdAt: string;
  addedBy: number;
  linkPreviewId?: string;
  
  // NOUVEAUX CHAMPS
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  reviewedAt?: string;
  reviewedBy?: number;
  reviewNotes?: string;
  reviewer?: {
    id: number;
    name: string | null;
  } | null;
  
  creator: {
    id: number;
    name: string | null;
    email: string | null;
  };
  categories: EducationalResourceCategory[];
}
```

---

## Changements de Comportement

### Affichage Public
- **Avant:** Toutes les ressources étaient affichées
- **Maintenant:** Seules les ressources avec `status: 'APPROVED'` doivent être affichées publiquement

### Soumission
- **Avant:** Seuls les modérateurs pouvaient créer des ressources
- **Maintenant:** Tous les utilisateurs connectés peuvent soumettre, mais c'est en `PENDING`

---

## UI Suggestions

### Formulaire de Soumission
1. Montrer le nombre de soumissions restantes (header `X-RateLimit-Remaining`)
2. Afficher un message de succès expliquant que la ressource sera modérée
3. Gérer les erreurs de filtrage avec messages explicites

### Liste des Ressources
1. Ajouter un badge de statut (Pending 🟡, Approved ✅, Rejected 🔴)
2. Permettre aux utilisateurs de voir leurs propres soumissions en attente
3. Ajouter un bouton "Signaler" sur chaque ressource

### Dashboard Modération (Nouveauté)
1. Afficher le compteur de ressources en attente
2. Liste des ressources pending avec actions Approve/Reject
3. Liste des signalements avec lien vers la ressource concernée

---

## Erreurs de Filtrage de Contenu

Quand une URL est rejetée par le filtre, le code d'erreur est `CONTENT_FILTERED` avec ces raisons possibles:

| Reason | Description | Message Suggéré |
|--------|-------------|-----------------|
| `BLACKLISTED_DOMAIN` | Domaine non autorisé | "Ce domaine n'est pas autorisé (ex: raccourcisseur d'URL)" |
| `BLOCKED_EXTENSION` | Extension de fichier bloquée | "Les téléchargements directs ne sont pas autorisés" |
| `MALWARE_PATTERN` | Pattern suspect détecté | "Cette URL contient des éléments suspects" |
| `INJECTION_DETECTED` | Tentative d'injection | "URL invalide" |
| `URL_MANIPULATION` | Manipulation d'URL | "Cette URL semble manipulée" |
| `PUNYCODE_DETECTED` | Caractères Punycode | "Domaine avec caractères spéciaux non autorisé" |
| `HOMOGRAPH_DETECTED` | Caractères lookalike | "URL invalide - caractères suspects" |
| `HTTPS_REQUIRED` | HTTP non autorisé | "Seules les URLs HTTPS sont acceptées" |

---

## Questions pour l'équipe Front

1. Voulez-vous que les utilisateurs voient leurs propres soumissions en attente dans une section dédiée ?
2. Comment gérer la notification aux utilisateurs quand leur soumission est approuvée/rejetée ?
3. Faut-il limiter visuellement le formulaire quand le rate limit est atteint ?
