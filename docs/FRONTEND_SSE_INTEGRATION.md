# Frontend SSE Integration - LiquidTerminal

Guide d'intégration des Server-Sent Events (SSE) pour le flux temps réel des liquidations dans une application React/Next.js.

---

## Table des Matières

1. [Vue d'ensemble](#vue-densemble)
2. [Différences avec le Polling](#différences-avec-le-polling)
3. [Configuration de base](#configuration-de-base)
4. [Hook React personnalisé](#hook-react-personnalisé)
5. [Store Zustand](#store-zustand)
6. [Composants React](#composants-react)
7. [Gestion de la connexion](#gestion-de-la-connexion)
8. [Animations et UX](#animations-et-ux)
9. [Bonnes pratiques](#bonnes-pratiques)

---

## Vue d'ensemble

### Qu'est-ce que SSE ?

Les **Server-Sent Events** permettent au serveur de pousser des données vers le client en temps réel via une connexion HTTP persistante. Contrairement au polling, le client n'a pas besoin de demander les données - elles arrivent automatiquement.

### Avantages pour le Frontend

| Aspect | Polling | SSE |
|--------|---------|-----|
| Latence | 30s max | < 1s |
| Requêtes | 120/heure | 1 connexion |
| Batterie (mobile) | Drain important | Minimal |
| Données temps réel | Non | Oui |

---

## Différences avec le Polling

### Avant (Polling)

```tsx
// Ancienne approche - polling toutes les 30s
useEffect(() => {
  const fetchLiquidations = async () => {
    const res = await fetch('/liquidations/recent?hours=1');
    const data = await res.json();
    setLiquidations(data.data);
  };

  fetchLiquidations();
  const interval = setInterval(fetchLiquidations, 30000);

  return () => clearInterval(interval);
}, []);
```

### Après (SSE)

```tsx
// Nouvelle approche - temps réel via SSE
useEffect(() => {
  const eventSource = new EventSource('/liquidations/stream');

  eventSource.addEventListener('liquidation', (e) => {
    const data = JSON.parse(e.data);
    setLiquidations(prev => [data.data, ...prev]);
  });

  return () => eventSource.close();
}, []);
```

---

## Configuration de base

### Variables d'environnement

```env
# .env.local
NEXT_PUBLIC_API_URL=https://api.liquidterminal.xyz
```

### Types TypeScript

```typescript
// types/liquidations.ts

export interface Liquidation {
  tid: number;
  time: string;
  coin: string;
  liq_dir: 'Long' | 'Short';
  mark_px: number;
  notional_total: number;
  volume_usd: number;
}

export interface SSELiquidationEvent {
  type: 'liquidation' | 'heartbeat' | 'connected' | 'error';
  data: Liquidation | null;
  id?: number;
  timestamp: string;
}

export type SSEConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'error';

export interface SSEFilters {
  coin?: string;
  minAmountDollars?: number;
  user?: string; // Wallet address (0x...)
}
```

---

## Hook React personnalisé

### useLiquidationsSSE

```typescript
// hooks/useLiquidationsSSE.ts

import { useEffect, useRef, useState, useCallback } from 'react';
import type { Liquidation, SSELiquidationEvent, SSEConnectionStatus, SSEFilters } from '@/types/liquidations';

interface UseLiquidationsSSEOptions {
  filters?: SSEFilters;
  maxItems?: number;
  onLiquidation?: (liquidation: Liquidation) => void;
  autoReconnect?: boolean;
  reconnectDelay?: number;
}

interface UseLiquidationsSSEReturn {
  liquidations: Liquidation[];
  status: SSEConnectionStatus;
  error: string | null;
  connect: () => void;
  disconnect: () => void;
  clearLiquidations: () => void;
}

export function useLiquidationsSSE(options: UseLiquidationsSSEOptions = {}): UseLiquidationsSSEReturn {
  const {
    filters = {},
    maxItems = 100,
    onLiquidation,
    autoReconnect = true,
    reconnectDelay = 3000,
  } = options;

  const [liquidations, setLiquidations] = useState<Liquidation[]>([]);
  const [status, setStatus] = useState<SSEConnectionStatus>('disconnected');
  const [error, setError] = useState<string | null>(null);

  const eventSourceRef = useRef<EventSource | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const lastEventIdRef = useRef<number | null>(null);

  const buildUrl = useCallback(() => {
    const baseUrl = `${process.env.NEXT_PUBLIC_API_URL}/liquidations/stream`;
    const params = new URLSearchParams();

    if (filters.coin) {
      params.set('coin', filters.coin.toUpperCase());
    }
    if (filters.minAmountDollars) {
      params.set('min_amount_dollars', filters.minAmountDollars.toString());
    }
    if (filters.user) {
      params.set('user', filters.user.toLowerCase());
    }
    if (lastEventIdRef.current) {
      params.set('last_event_id', lastEventIdRef.current.toString());
    }

    const queryString = params.toString();
    return queryString ? `${baseUrl}?${queryString}` : baseUrl;
  }, [filters.coin, filters.minAmountDollars]);

  const connect = useCallback(() => {
    // Nettoyer la connexion existante
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
    }
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
    }

    setStatus('connecting');
    setError(null);

    const url = buildUrl();
    const eventSource = new EventSource(url);
    eventSourceRef.current = eventSource;

    // Connexion établie
    eventSource.addEventListener('connected', () => {
      setStatus('connected');
      setError(null);
    });

    // Nouvelle liquidation
    eventSource.addEventListener('liquidation', (event) => {
      try {
        const data: SSELiquidationEvent = JSON.parse(event.data);
        const liquidation = data.data as Liquidation;

        // Sauvegarder le dernier ID pour la reconnexion
        if (data.id) {
          lastEventIdRef.current = data.id;
        }

        setLiquidations(prev => {
          // Éviter les doublons
          if (prev.some(l => l.tid === liquidation.tid)) {
            return prev;
          }
          // Limiter le nombre d'items
          const updated = [liquidation, ...prev];
          return updated.slice(0, maxItems);
        });

        // Callback externe
        onLiquidation?.(liquidation);
      } catch (e) {
        console.error('Failed to parse liquidation event:', e);
      }
    });

    // Heartbeat (keep-alive)
    eventSource.addEventListener('heartbeat', () => {
      // Connexion toujours active
      if (status !== 'connected') {
        setStatus('connected');
      }
    });

    // Erreur
    eventSource.addEventListener('error', () => {
      setStatus('error');
      setError('Connection lost');
      eventSource.close();

      // Reconnexion automatique
      if (autoReconnect) {
        reconnectTimeoutRef.current = setTimeout(() => {
          connect();
        }, reconnectDelay);
      }
    });

    // Erreur générique EventSource
    eventSource.onerror = () => {
      if (eventSource.readyState === EventSource.CLOSED) {
        setStatus('disconnected');

        if (autoReconnect) {
          reconnectTimeoutRef.current = setTimeout(() => {
            connect();
          }, reconnectDelay);
        }
      }
    };
  }, [buildUrl, maxItems, onLiquidation, autoReconnect, reconnectDelay, status]);

  const disconnect = useCallback(() => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
    }
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
    setStatus('disconnected');
  }, []);

  const clearLiquidations = useCallback(() => {
    setLiquidations([]);
  }, []);

  // Connexion automatique au montage
  useEffect(() => {
    connect();

    return () => {
      disconnect();
    };
  }, [connect, disconnect]);

  // Reconnecter si les filtres changent
  useEffect(() => {
    if (status === 'connected') {
      disconnect();
      connect();
    }
  }, [filters.coin, filters.minAmountDollars]);

  return {
    liquidations,
    status,
    error,
    connect,
    disconnect,
    clearLiquidations,
  };
}
```

---

## Store Zustand

Pour une gestion d'état globale plus robuste:

```typescript
// store/liquidationsStore.ts

import { create } from 'zustand';
import type { Liquidation, SSEConnectionStatus, SSEFilters } from '@/types/liquidations';

interface LiquidationsState {
  // État
  liquidations: Liquidation[];
  status: SSEConnectionStatus;
  error: string | null;
  filters: SSEFilters;
  eventSource: EventSource | null;

  // Actions
  setFilters: (filters: SSEFilters) => void;
  addLiquidation: (liquidation: Liquidation) => void;
  clearLiquidations: () => void;
  connect: () => void;
  disconnect: () => void;

  // Stats calculées
  totalVolume24h: () => number;
  longShortRatio: () => { long: number; short: number };
}

const MAX_ITEMS = 500;

export const useLiquidationsStore = create<LiquidationsState>((set, get) => ({
  liquidations: [],
  status: 'disconnected',
  error: null,
  filters: {},
  eventSource: null,

  setFilters: (filters) => {
    set({ filters });
    // Reconnecter avec les nouveaux filtres
    const { disconnect, connect } = get();
    disconnect();
    connect();
  },

  addLiquidation: (liquidation) => {
    set((state) => {
      // Éviter les doublons
      if (state.liquidations.some(l => l.tid === liquidation.tid)) {
        return state;
      }
      return {
        liquidations: [liquidation, ...state.liquidations].slice(0, MAX_ITEMS),
      };
    });
  },

  clearLiquidations: () => set({ liquidations: [] }),

  connect: () => {
    const { filters, eventSource: existingSource } = get();

    // Fermer la connexion existante
    if (existingSource) {
      existingSource.close();
    }

    set({ status: 'connecting', error: null });

    const params = new URLSearchParams();
    if (filters.coin) params.set('coin', filters.coin);
    if (filters.minAmountDollars) params.set('min_amount_dollars', filters.minAmountDollars.toString());
    if (filters.user) params.set('user', filters.user);

    const url = `${process.env.NEXT_PUBLIC_API_URL}/liquidations/stream${params.toString() ? '?' + params.toString() : ''}`;
    const eventSource = new EventSource(url);

    eventSource.addEventListener('connected', () => {
      set({ status: 'connected', error: null });
    });

    eventSource.addEventListener('liquidation', (e) => {
      try {
        const data = JSON.parse(e.data);
        get().addLiquidation(data.data);
      } catch (err) {
        console.error('Parse error:', err);
      }
    });

    eventSource.addEventListener('heartbeat', () => {
      set({ status: 'connected' });
    });

    eventSource.onerror = () => {
      set({ status: 'error', error: 'Connection lost' });

      // Reconnexion automatique après 3s
      setTimeout(() => {
        if (get().status === 'error') {
          get().connect();
        }
      }, 3000);
    };

    set({ eventSource });
  },

  disconnect: () => {
    const { eventSource } = get();
    if (eventSource) {
      eventSource.close();
    }
    set({ eventSource: null, status: 'disconnected' });
  },

  totalVolume24h: () => {
    const { liquidations } = get();
    const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
    return liquidations
      .filter(l => new Date(l.time).getTime() > oneDayAgo)
      .reduce((sum, l) => sum + l.notional_total, 0);
  },

  longShortRatio: () => {
    const { liquidations } = get();
    const longs = liquidations.filter(l => l.liq_dir === 'Long');
    const shorts = liquidations.filter(l => l.liq_dir === 'Short');
    const total = liquidations.length || 1;
    return {
      long: (longs.length / total) * 100,
      short: (shorts.length / total) * 100,
    };
  },
}));
```

---

## Composants React

### Indicateur de connexion

```tsx
// components/SSEConnectionStatus.tsx

import { useLiquidationsSSE } from '@/hooks/useLiquidationsSSE';

const statusConfig = {
  connecting: { color: 'bg-yellow-500', text: 'Connecting...', pulse: true },
  connected: { color: 'bg-green-500', text: 'Live', pulse: false },
  disconnected: { color: 'bg-gray-500', text: 'Disconnected', pulse: false },
  error: { color: 'bg-red-500', text: 'Error', pulse: true },
};

export function SSEConnectionStatus({ status }: { status: string }) {
  const config = statusConfig[status as keyof typeof statusConfig] || statusConfig.disconnected;

  return (
    <div className="flex items-center gap-2">
      <span className={`relative flex h-3 w-3`}>
        {config.pulse && (
          <span className={`animate-ping absolute inline-flex h-full w-full rounded-full ${config.color} opacity-75`} />
        )}
        <span className={`relative inline-flex rounded-full h-3 w-3 ${config.color}`} />
      </span>
      <span className="text-sm text-gray-400">{config.text}</span>
    </div>
  );
}
```

### Liste de liquidations avec animations

```tsx
// components/LiquidationsFeed.tsx

import { motion, AnimatePresence } from 'framer-motion';
import { useLiquidationsSSE } from '@/hooks/useLiquidationsSSE';
import { SSEConnectionStatus } from './SSEConnectionStatus';
import type { Liquidation } from '@/types/liquidations';

function formatAmount(amount: number): string {
  if (amount >= 1_000_000) return `$${(amount / 1_000_000).toFixed(2)}M`;
  if (amount >= 1_000) return `$${(amount / 1_000).toFixed(0)}K`;
  return `$${amount.toFixed(0)}`;
}

function LiquidationRow({ liquidation }: { liquidation: Liquidation }) {
  const isLong = liquidation.liq_dir === 'Long';
  const isWhale = liquidation.notional_total >= 100_000;

  return (
    <motion.div
      initial={{ opacity: 0, x: -20, scale: 0.95 }}
      animate={{ opacity: 1, x: 0, scale: 1 }}
      exit={{ opacity: 0, x: 20, scale: 0.95 }}
      transition={{ duration: 0.3 }}
      className={`
        flex items-center justify-between p-3 rounded-lg
        ${isWhale ? 'bg-yellow-500/10 border border-yellow-500/30' : 'bg-gray-800/50'}
        ${isLong ? 'border-l-4 border-l-green-500' : 'border-l-4 border-l-red-500'}
      `}
    >
      <div className="flex items-center gap-3">
        {/* Direction emoji */}
        <span className="text-xl">
          {isLong ? '🟢' : '🔴'}
        </span>

        {/* Coin */}
        <span className="font-mono font-bold text-white">
          {liquidation.coin}
        </span>

        {/* Direction text */}
        <span className={`text-sm ${isLong ? 'text-green-400' : 'text-red-400'}`}>
          {liquidation.liq_dir}
        </span>
      </div>

      <div className="flex items-center gap-4">
        {/* Amount */}
        <span className={`font-mono font-bold ${isWhale ? 'text-yellow-400' : 'text-white'}`}>
          {formatAmount(liquidation.notional_total)}
        </span>

        {/* Price */}
        <span className="text-gray-400 text-sm font-mono">
          @${liquidation.mark_px.toLocaleString()}
        </span>

        {/* Time */}
        <span className="text-gray-500 text-xs">
          {new Date(liquidation.time).toLocaleTimeString()}
        </span>

        {/* Whale indicator */}
        {isWhale && <span className="text-xl">🐋</span>}
      </div>
    </motion.div>
  );
}

export function LiquidationsFeed() {
  const { liquidations, status, error, connect, disconnect } = useLiquidationsSSE({
    maxItems: 50,
    onLiquidation: (liq) => {
      // Notification pour les grosses liquidations
      if (liq.notional_total >= 500_000) {
        // Déclencher toast/notification
        console.log('Whale alert!', liq);
      }
    },
  });

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold text-white">Live Liquidations</h2>
        <div className="flex items-center gap-4">
          <SSEConnectionStatus status={status} />
          {status === 'disconnected' && (
            <button
              onClick={connect}
              className="px-3 py-1 bg-blue-600 text-white text-sm rounded hover:bg-blue-700"
            >
              Connect
            </button>
          )}
        </div>
      </div>

      {/* Error message */}
      {error && (
        <div className="bg-red-500/10 border border-red-500/30 p-3 rounded text-red-400 text-sm">
          {error} - Reconnecting...
        </div>
      )}

      {/* Liquidations list */}
      <div className="space-y-2 max-h-[600px] overflow-y-auto">
        <AnimatePresence mode="popLayout">
          {liquidations.map((liq) => (
            <LiquidationRow key={liq.tid} liquidation={liq} />
          ))}
        </AnimatePresence>

        {liquidations.length === 0 && status === 'connected' && (
          <div className="text-center text-gray-500 py-8">
            Waiting for liquidations...
          </div>
        )}
      </div>
    </div>
  );
}
```

### Filtres

```tsx
// components/LiquidationFilters.tsx

import { useState } from 'react';
import type { SSEFilters } from '@/types/liquidations';

interface Props {
  filters: SSEFilters;
  onFiltersChange: (filters: SSEFilters) => void;
}

const POPULAR_COINS = ['BTC', 'ETH', 'SOL', 'HYPE', 'DOGE', 'PEPE'];
const MIN_AMOUNTS = [
  { label: 'All', value: undefined },
  { label: '$10K+', value: 10_000 },
  { label: '$50K+', value: 50_000 },
  { label: '$100K+', value: 100_000 },
  { label: '$500K+', value: 500_000 },
];

export function LiquidationFilters({ filters, onFiltersChange }: Props) {
  return (
    <div className="flex flex-wrap gap-4 p-4 bg-gray-800/50 rounded-lg">
      {/* Coin filter */}
      <div className="flex flex-col gap-2">
        <label className="text-sm text-gray-400">Coin</label>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => onFiltersChange({ ...filters, coin: undefined })}
            className={`px-3 py-1 rounded text-sm ${
              !filters.coin ? 'bg-blue-600 text-white' : 'bg-gray-700 text-gray-300'
            }`}
          >
            All
          </button>
          {POPULAR_COINS.map((coin) => (
            <button
              key={coin}
              onClick={() => onFiltersChange({ ...filters, coin })}
              className={`px-3 py-1 rounded text-sm ${
                filters.coin === coin ? 'bg-blue-600 text-white' : 'bg-gray-700 text-gray-300'
              }`}
            >
              {coin}
            </button>
          ))}
        </div>
      </div>

      {/* Min amount filter */}
      <div className="flex flex-col gap-2">
        <label className="text-sm text-gray-400">Min Amount</label>
        <div className="flex flex-wrap gap-2">
          {MIN_AMOUNTS.map(({ label, value }) => (
            <button
              key={label}
              onClick={() => onFiltersChange({ ...filters, minAmountDollars: value })}
              className={`px-3 py-1 rounded text-sm ${
                filters.minAmountDollars === value ? 'bg-blue-600 text-white' : 'bg-gray-700 text-gray-300'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
```

### Toast notifications pour whales

```tsx
// components/WhaleToast.tsx

import { useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useLiquidationsSSE } from '@/hooks/useLiquidationsSSE';

export function useWhaleNotifications(minAmount = 500_000) {
  const [toasts, setToasts] = useState<Liquidation[]>([]);

  const { liquidations } = useLiquidationsSSE({
    minAmountDollars: minAmount,
    onLiquidation: (liq) => {
      setToasts(prev => [...prev, liq]);

      // Auto-remove after 5s
      setTimeout(() => {
        setToasts(prev => prev.filter(t => t.tid !== liq.tid));
      }, 5000);
    },
  });

  return toasts;
}

export function WhaleToastContainer() {
  const toasts = useWhaleNotifications(500_000);

  return (
    <div className="fixed bottom-4 right-4 z-50 space-y-2">
      <AnimatePresence>
        {toasts.map((liq) => (
          <motion.div
            key={liq.tid}
            initial={{ opacity: 0, y: 50, scale: 0.8 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, x: 100 }}
            className="bg-yellow-500/90 text-black p-4 rounded-lg shadow-lg max-w-sm"
          >
            <div className="flex items-center gap-2">
              <span className="text-2xl">🐋</span>
              <div>
                <p className="font-bold">Whale Liquidation!</p>
                <p>
                  {liq.coin} {liq.liq_dir}: ${(liq.notional_total / 1_000_000).toFixed(2)}M
                </p>
              </div>
            </div>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
```

---

## Gestion de la connexion

### Reconnexion automatique

Le hook `useLiquidationsSSE` gère automatiquement:
- Reconnexion après une erreur (délai configurable)
- Reprise des événements manqués via `Last-Event-ID`
- État de connexion exposé pour l'UI

### Nettoyage à la déconnexion

```tsx
// Important: toujours fermer la connexion au démontage
useEffect(() => {
  connect();

  return () => {
    disconnect(); // Ferme EventSource et nettoie les timeouts
  };
}, []);
```

### Gestion du focus de l'onglet

```tsx
// hooks/usePageVisibility.ts

export function usePageVisibility(onVisible: () => void, onHidden: () => void) {
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.hidden) {
        onHidden();
      } else {
        onVisible();
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [onVisible, onHidden]);
}

// Usage dans le composant
usePageVisibility(
  () => connect(),    // Reconnecter quand l'onglet redevient visible
  () => disconnect()  // Déconnecter quand l'onglet est caché (économie de ressources)
);
```

---

## Animations et UX

### Dépendances recommandées

```bash
npm install framer-motion
```

### Variantes d'animation

```tsx
// animations/liquidations.ts

export const liquidationVariants = {
  initial: {
    opacity: 0,
    x: -20,
    scale: 0.95
  },
  animate: {
    opacity: 1,
    x: 0,
    scale: 1,
    transition: { duration: 0.3 }
  },
  exit: {
    opacity: 0,
    x: 20,
    scale: 0.95,
    transition: { duration: 0.2 }
  },
};

export const whaleVariants = {
  initial: {
    opacity: 0,
    scale: 1.5,
    rotate: -10
  },
  animate: {
    opacity: 1,
    scale: 1,
    rotate: 0,
    transition: {
      type: "spring",
      stiffness: 200,
      damping: 20
    }
  },
};
```

### Effets sonores (optionnel)

```tsx
// hooks/useSoundEffects.ts

export function useLiquidationSounds() {
  const playWhaleSound = useCallback(() => {
    const audio = new Audio('/sounds/whale.mp3');
    audio.volume = 0.5;
    audio.play().catch(() => {}); // Ignore autoplay restrictions
  }, []);

  const playLiquidationSound = useCallback(() => {
    const audio = new Audio('/sounds/liquidation.mp3');
    audio.volume = 0.3;
    audio.play().catch(() => {});
  }, []);

  return { playWhaleSound, playLiquidationSound };
}
```

---

## Bonnes pratiques

### 1. Limiter le nombre d'items affichés

```tsx
// Garder seulement les 100 dernières liquidations
const MAX_ITEMS = 100;
setLiquidations(prev => [newLiq, ...prev].slice(0, MAX_ITEMS));
```

### 2. Dédoublonner par `tid`

```tsx
setLiquidations(prev => {
  if (prev.some(l => l.tid === newLiq.tid)) {
    return prev; // Déjà présent
  }
  return [newLiq, ...prev];
});
```

### 3. Utiliser `AnimatePresence` avec `mode="popLayout"`

```tsx
<AnimatePresence mode="popLayout">
  {items.map(item => (
    <motion.div key={item.tid} layout {...variants}>
      ...
    </motion.div>
  ))}
</AnimatePresence>
```

### 4. Débouncer les changements de filtres

```tsx
import { useDebouncedCallback } from 'use-debounce';

const debouncedSetFilters = useDebouncedCallback((filters) => {
  setFilters(filters);
}, 500);
```

### 5. Mémoriser les callbacks

```tsx
const handleLiquidation = useCallback((liq: Liquidation) => {
  if (liq.notional_total >= 500_000) {
    showToast(liq);
  }
}, [showToast]);
```

---

## Exemple complet - Page Liquidations

```tsx
// pages/liquidations.tsx

'use client';

import { useState } from 'react';
import { LiquidationsFeed } from '@/components/LiquidationsFeed';
import { LiquidationFilters } from '@/components/LiquidationFilters';
import { WhaleToastContainer } from '@/components/WhaleToast';
import { useLiquidationsSSE } from '@/hooks/useLiquidationsSSE';
import { SSEConnectionStatus } from '@/components/SSEConnectionStatus';
import type { SSEFilters } from '@/types/liquidations';

export default function LiquidationsPage() {
  const [filters, setFilters] = useState<SSEFilters>({});

  const { liquidations, status, error } = useLiquidationsSSE({
    filters,
    maxItems: 100,
  });

  // Stats en temps réel
  const totalVolume = liquidations.reduce((sum, l) => sum + l.notional_total, 0);
  const longCount = liquidations.filter(l => l.liq_dir === 'Long').length;
  const shortCount = liquidations.filter(l => l.liq_dir === 'Short').length;

  return (
    <div className="min-h-screen bg-gray-900 text-white p-6">
      <div className="max-w-6xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <h1 className="text-3xl font-bold">Live Liquidations</h1>
          <SSEConnectionStatus status={status} />
        </div>

        {/* Stats cards */}
        <div className="grid grid-cols-4 gap-4">
          <div className="bg-gray-800 p-4 rounded-lg">
            <p className="text-gray-400 text-sm">Total Volume</p>
            <p className="text-2xl font-bold">${(totalVolume / 1_000_000).toFixed(2)}M</p>
          </div>
          <div className="bg-gray-800 p-4 rounded-lg">
            <p className="text-gray-400 text-sm">Liquidations</p>
            <p className="text-2xl font-bold">{liquidations.length}</p>
          </div>
          <div className="bg-gray-800 p-4 rounded-lg">
            <p className="text-gray-400 text-sm">Longs</p>
            <p className="text-2xl font-bold text-green-400">{longCount}</p>
          </div>
          <div className="bg-gray-800 p-4 rounded-lg">
            <p className="text-gray-400 text-sm">Shorts</p>
            <p className="text-2xl font-bold text-red-400">{shortCount}</p>
          </div>
        </div>

        {/* Filters */}
        <LiquidationFilters filters={filters} onFiltersChange={setFilters} />

        {/* Feed */}
        <LiquidationsFeed />
      </div>

      {/* Toast notifications */}
      <WhaleToastContainer />
    </div>
  );
}
```

---

## Dépannage

### La connexion se ferme immédiatement

- Vérifier que l'URL de l'API est correcte
- Vérifier les CORS (l'API doit autoriser votre domaine)
- Vérifier qu'il n'y a pas de proxy/reverse-proxy qui bufferise les réponses

### Les événements n'arrivent pas

- Vérifier dans l'onglet Network que la requête SSE est bien établie
- Vérifier que le Content-Type est `text/event-stream`
- Attendre qu'une liquidation se produise (ou vérifier les heartbeats toutes les 30s)

### Trop de reconnexions

- Augmenter `reconnectDelay` (par défaut 3000ms)
- Vérifier la stabilité de la connexion réseau
- Implémenter un backoff exponentiel pour les reconnexions

---

## Ressources

- [MDN - Server-Sent Events](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events)
- [Framer Motion](https://www.framer.com/motion/)
- [Zustand](https://github.com/pmndrs/zustand)
