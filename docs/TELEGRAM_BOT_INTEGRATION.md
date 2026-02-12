# Guide d'Intégration - Bot Telegram LiquidTerminal

## Vue d'Ensemble

Ce guide explique comment intégrer l'API LiquidTerminal dans un bot Telegram pour recevoir des alertes de liquidations en temps réel.

---

## Endpoints API Disponibles

### 1. SSE Temps Réel (Recommandé pour alertes)
```
GET /liquidations/stream
```

**Paramètres Query:**
| Paramètre | Type | Description |
|-----------|------|-------------|
| `coin` | string | Filtrer par crypto (ex: "BTC", "ETH") |
| `min_amount_dollars` | number | Montant minimum en USD (≥0) |
| `user` | string | Filtrer par wallet liquidé (adresse Ethereum 0x...) |
| `last_event_id` | number | ID pour reprendre après déconnexion |

**Headers supportés:**
- `Last-Event-ID` - Alternative standard SSE pour la reconnexion

**Exemples:**
```
# Filtrer par coin et montant minimum
GET /liquidations/stream?coin=BTC&min_amount_dollars=50000

# Suivre un wallet spécifique
GET /liquidations/stream?user=0x1234567890abcdef1234567890abcdef12345678

# Combiner plusieurs filtres
GET /liquidations/stream?coin=ETH&min_amount_dollars=10000&user=0x...
```

### 2. Polling Classique
```
GET /liquidations/recent?hours=2&limit=100&coin=BTC&amount_dollars=10000
```

### 3. Statistiques
```
GET /liquidations/stats/all
```

---

## Format des Événements SSE

### Connexion établie
```
event: connected
data: {"type":"connected","data":null,"timestamp":"2026-01-26T10:30:00.000Z"}
```

### Nouvelle liquidation
```
id: 12345678
event: liquidation
data: {"type":"liquidation","data":{"tid":12345678,"coin":"BTC","notional_total":250000,"liq_dir":"Long","time":"2026-01-26T10:30:15","mark_px":42500.50,"liquidated_user":"0x..."},"id":12345678,"timestamp":"2026-01-26T10:30:15.000Z"}
```

### Heartbeat (toutes les 30s)
```
event: heartbeat
data: {"type":"heartbeat","data":null,"timestamp":"2026-01-26T10:30:30.000Z"}
```

---

## Structure de Données Liquidation

```typescript
interface Liquidation {
  tid: number;              // ID unique de la transaction
  time: string;             // ISO datetime "2026-01-26T10:28:36"
  time_ms: number;          // Timestamp en millisecondes
  coin: string;             // Symbol crypto (BTC, ETH, etc.)
  notional_total: number;   // Valeur en USD
  liq_dir: "Long" | "Short"; // Direction de la liquidation
  mark_px: number;          // Prix mark au moment de la liquidation
  liquidated_user: string;  // Adresse wallet liquidé
  hash: string;             // Hash de la transaction
  size_total: number;       // Taille de la position
  liquidator_count: number; // Nombre de liquidateurs
}
```

---

## Implémentation Python

### Dépendances

```bash
pip install pyTelegramBotAPI requests sseclient-py redis
```

### Structure du Projet

```
telegram-bot/
├── main.py              # Point d'entrée
├── config.py            # Configuration
├── handlers/
│   ├── commands.py      # Handlers de commandes
│   └── alerts.py        # Gestion des alertes SSE
├── services/
│   ├── api.py           # Client API REST
│   └── sse.py           # Client SSE
├── storage/
│   └── redis_store.py   # Stockage alertes utilisateur
└── utils/
    └── formatter.py     # Formatage des messages
```

### Configuration (`config.py`)

```python
import os

class Config:
    # Telegram
    BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN")

    # API LiquidTerminal
    API_BASE_URL = os.getenv("API_BASE_URL", "https://api.liquidterminal.xyz")

    # Redis (pour stocker les alertes utilisateur)
    REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379")

    # SSE Configuration
    SSE_RECONNECT_DELAY = 5          # Secondes entre reconnexions
    SSE_MAX_RECONNECT_ATTEMPTS = 10
    SSE_HEARTBEAT_TIMEOUT = 60       # Timeout si pas de heartbeat

    # Limites
    MAX_ALERTS_PER_USER = 5
    ALERT_COOLDOWN_SECONDS = 1       # Anti-spam entre alertes
```

### Client SSE (`services/sse.py`)

```python
import sseclient
import requests
import json
import threading
import time
from typing import Callable, Optional, Dict, Any

class SSEClient:
    """Client SSE avec reconnexion automatique et gestion du heartbeat."""

    def __init__(
        self,
        base_url: str,
        on_liquidation: Callable[[Dict[str, Any]], None],
        on_connected: Optional[Callable[[], None]] = None,
        on_disconnected: Optional[Callable[[], None]] = None,
        reconnect_delay: int = 5,
        max_reconnect_attempts: int = 10,
        heartbeat_timeout: int = 60
    ):
        self.base_url = base_url
        self.on_liquidation = on_liquidation
        self.on_connected = on_connected
        self.on_disconnected = on_disconnected
        self.reconnect_delay = reconnect_delay
        self.max_reconnect_attempts = max_reconnect_attempts
        self.heartbeat_timeout = heartbeat_timeout

        self._running = False
        self._thread: Optional[threading.Thread] = None
        self._last_event_id: Optional[int] = None
        self._reconnect_attempts = 0
        self._last_heartbeat = time.time()

    def start(self, coin: Optional[str] = None, min_amount: Optional[float] = None, user: Optional[str] = None):
        """Démarre la connexion SSE dans un thread séparé."""
        if self._running:
            return

        self._running = True
        self._coin = coin
        self._min_amount = min_amount
        self._user = user
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def stop(self):
        """Arrête la connexion SSE."""
        self._running = False
        if self._thread:
            self._thread.join(timeout=5)

    def _build_url(self) -> str:
        """Construit l'URL avec les paramètres de filtre."""
        params = []
        if self._coin:
            params.append(f"coin={self._coin}")
        if self._min_amount:
            params.append(f"min_amount_dollars={self._min_amount}")
        if self._user:
            params.append(f"user={self._user}")
        if self._last_event_id:
            params.append(f"last_event_id={self._last_event_id}")

        query = "&".join(params)
        return f"{self.base_url}/liquidations/stream{'?' + query if query else ''}"

    def _run(self):
        """Boucle principale de connexion SSE."""
        while self._running:
            try:
                url = self._build_url()
                print(f"[SSE] Connexion à {url}")

                response = requests.get(url, stream=True, timeout=None)
                client = sseclient.SSEClient(response)

                for event in client.events():
                    if not self._running:
                        break

                    self._handle_event(event)

            except Exception as e:
                print(f"[SSE] Erreur: {e}")
                if self.on_disconnected:
                    self.on_disconnected()

                if not self._running:
                    break

                # Reconnexion avec backoff
                self._reconnect_attempts += 1
                if self._reconnect_attempts > self.max_reconnect_attempts:
                    print("[SSE] Max reconnexions atteint, arrêt")
                    self._running = False
                    break

                delay = self.reconnect_delay * self._reconnect_attempts
                print(f"[SSE] Reconnexion dans {delay}s (tentative {self._reconnect_attempts})")
                time.sleep(delay)

    def _handle_event(self, event):
        """Traite un événement SSE."""
        self._last_heartbeat = time.time()

        if event.event == "connected":
            print("[SSE] Connecté")
            self._reconnect_attempts = 0
            if self.on_connected:
                self.on_connected()

        elif event.event == "liquidation":
            try:
                data = json.loads(event.data)
                self._last_event_id = data.get("id")
                self.on_liquidation(data["data"])
            except json.JSONDecodeError as e:
                print(f"[SSE] Erreur parsing: {e}")

        elif event.event == "heartbeat":
            pass  # Juste mettre à jour _last_heartbeat
```

### Gestionnaire d'Alertes (`handlers/alerts.py`)

```python
import threading
from typing import Dict, List, Optional
from services.sse import SSEClient
from storage.redis_store import RedisStore
from config import Config

class AlertManager:
    """Gère les alertes utilisateur et la distribution via SSE."""

    def __init__(self, bot, storage: RedisStore):
        self.bot = bot
        self.storage = storage
        self.sse_client: Optional[SSEClient] = None
        self._user_cooldowns: Dict[int, float] = {}

    def start(self):
        """Démarre le client SSE pour recevoir les liquidations."""
        self.sse_client = SSEClient(
            base_url=Config.API_BASE_URL,
            on_liquidation=self._handle_liquidation,
            on_connected=lambda: print("[AlertManager] SSE connecté"),
            on_disconnected=lambda: print("[AlertManager] SSE déconnecté"),
            reconnect_delay=Config.SSE_RECONNECT_DELAY,
            max_reconnect_attempts=Config.SSE_MAX_RECONNECT_ATTEMPTS,
            heartbeat_timeout=Config.SSE_HEARTBEAT_TIMEOUT
        )
        # Pas de filtre côté SSE - on filtre côté bot pour chaque user
        self.sse_client.start()

    def stop(self):
        """Arrête le client SSE."""
        if self.sse_client:
            self.sse_client.stop()

    def _handle_liquidation(self, liq: dict):
        """Appelé pour chaque nouvelle liquidation."""
        import time

        # Récupérer toutes les alertes utilisateur
        alerts = self.storage.get_all_alerts()

        for alert in alerts:
            # Vérifier si la liquidation correspond aux critères
            if not self._matches_alert(liq, alert):
                continue

            # Rate limiting par utilisateur
            chat_id = alert["chat_id"]
            last_alert = self._user_cooldowns.get(chat_id, 0)
            if time.time() - last_alert < Config.ALERT_COOLDOWN_SECONDS:
                continue

            # Envoyer l'alerte
            try:
                message = self._format_alert(liq)
                self.bot.send_message(chat_id, message, parse_mode="Markdown")
                self._user_cooldowns[chat_id] = time.time()
            except Exception as e:
                print(f"[AlertManager] Erreur envoi {chat_id}: {e}")
                # Si le chat est bloqué, supprimer l'alerte
                if "blocked" in str(e).lower() or "chat not found" in str(e).lower():
                    self.storage.remove_user_alerts(chat_id)

    def _matches_alert(self, liq: dict, alert: dict) -> bool:
        """Vérifie si une liquidation correspond aux critères d'une alerte."""
        # Filtre par coin
        if alert.get("coin"):
            if liq["coin"].upper() != alert["coin"].upper():
                return False

        # Filtre par montant minimum
        min_amount = alert.get("min_amount", 0)
        if liq["notional_total"] < min_amount:
            return False

        # Filtre par wallet address
        if alert.get("user"):
            if liq["liquidated_user"].lower() != alert["user"].lower():
                return False

        return True

    def _format_alert(self, liq: dict) -> str:
        """Formate le message d'alerte."""
        emoji = "🟢" if liq["liq_dir"] == "Long" else "🔴"
        direction_emoji = "📉" if liq["liq_dir"] == "Long" else "📈"

        amount = liq["notional_total"]
        if amount >= 1_000_000:
            amount_str = f"{amount/1_000_000:.2f}M"
        elif amount >= 1_000:
            amount_str = f"{amount/1_000:.1f}K"
        else:
            amount_str = f"{amount:.0f}"

        return f"""
🚨 *ALERTE LIQUIDATION*

{emoji} *{liq['coin']}*: ${amount_str}
{direction_emoji} Direction: {liq['liq_dir']}
💵 Prix: ${liq['mark_px']:,.2f}
🕐 {liq['time'][:16].replace('T', ' ')}
""".strip()

    # Méthodes pour gérer les alertes utilisateur

    def add_alert(self, chat_id: int, coin: Optional[str] = None, min_amount: float = 10000, user: Optional[str] = None):
        """Ajoute une alerte pour un utilisateur."""
        existing = self.storage.get_user_alerts(chat_id)
        if len(existing) >= Config.MAX_ALERTS_PER_USER:
            raise ValueError(f"Maximum {Config.MAX_ALERTS_PER_USER} alertes par utilisateur")

        alert = {
            "chat_id": chat_id,
            "coin": coin.upper() if coin else None,
            "min_amount": min_amount,
            "user": user.lower() if user else None  # Normalize to lowercase
        }
        self.storage.add_alert(alert)

    def remove_alert(self, chat_id: int, index: Optional[int] = None):
        """Supprime une alerte (par index) ou toutes les alertes d'un utilisateur."""
        if index is not None:
            self.storage.remove_alert_by_index(chat_id, index)
        else:
            self.storage.remove_user_alerts(chat_id)

    def get_alerts(self, chat_id: int) -> List[dict]:
        """Récupère les alertes d'un utilisateur."""
        return self.storage.get_user_alerts(chat_id)
```

### Handlers de Commandes (`handlers/commands.py`)

```python
import telebot
from services.api import APIClient
from handlers.alerts import AlertManager

def register_commands(bot: telebot.TeleBot, api: APIClient, alerts: AlertManager):
    """Enregistre tous les handlers de commandes."""

    @bot.message_handler(commands=['start', 'help'])
    def handle_start(message):
        text = """
🌊 *LiquidTerminal Bot*

*Commandes disponibles:*

📊 *Données*
/liqs [coin] [min] [hours] - Liquidations récentes
/stats - Statistiques par période
/whale [min] - Grosses liquidations (>$100K)

🔔 *Alertes temps réel*
/alert\\_add <coin|wallet> [min] - Créer une alerte
/alert\\_list - Voir mes alertes
/alert\\_remove <num> - Supprimer une alerte
/alert\\_clear - Supprimer toutes mes alertes

*Exemples:*
`/liqs BTC 50000 4` - Liqs BTC >$50K sur 4h
`/alert_add ETH 100000` - Alerte ETH >$100K
`/alert_add 0x1234...5678 50000` - Suivre un wallet
`/whale 500000` - Whales >$500K
        """
        bot.reply_to(message, text, parse_mode="Markdown")

    @bot.message_handler(commands=['liqs'])
    def handle_liqs(message):
        args = message.text.split()[1:]

        coin = args[0].upper() if len(args) > 0 else None
        min_amount = int(args[1]) if len(args) > 1 else None
        hours = int(args[2]) if len(args) > 2 else 2

        try:
            data = api.get_recent_liquidations(
                coin=coin,
                min_amount=min_amount,
                hours=min(hours, 168)
            )

            liqs = data.get("data", [])[:15]
            if not liqs:
                bot.reply_to(message, "Aucune liquidation trouvée.")
                return

            total = sum(l["notional_total"] for l in liqs)

            text = f"🔥 *Liquidations ({hours}h)*\n"
            text += f"Total affiché: ${total:,.0f}\n\n"

            for liq in liqs:
                emoji = "🟢" if liq["liq_dir"] == "Long" else "🔴"
                time_str = liq["time"].split("T")[1][:5]
                text += f"{emoji} `{time_str}` | {liq['coin']:>5} | ${liq['notional_total']:>12,.0f}\n"

            bot.reply_to(message, text, parse_mode="Markdown")

        except Exception as e:
            bot.reply_to(message, f"❌ Erreur: {e}")

    @bot.message_handler(commands=['stats'])
    def handle_stats(message):
        try:
            data = api.get_all_stats()
            stats = data.get("stats", {})

            text = "📊 *Statistiques Liquidations*\n\n"

            for period in ["2h", "4h", "8h", "12h", "24h"]:
                s = stats.get(period)
                if not s:
                    continue

                total = s["totalVolume"]
                if total > 0:
                    long_pct = int(s["longVolume"] / total * 100)
                else:
                    long_pct = 0

                text += f"*{period}*: ${total:,.0f}\n"
                text += f"  🟢 Long: {long_pct}% | 🔴 Short: {100-long_pct}%\n"
                text += f"  🏆 Top: {s['topCoin']} | Avg: ${s['avgSize']:,.0f}\n\n"

            bot.reply_to(message, text, parse_mode="Markdown")

        except Exception as e:
            bot.reply_to(message, f"❌ Erreur: {e}")

    @bot.message_handler(commands=['whale'])
    def handle_whale(message):
        args = message.text.split()[1:]
        min_amount = int(args[0]) if args else 100000

        try:
            data = api.get_recent_liquidations(min_amount=min_amount, hours=24)
            liqs = data.get("data", [])[:20]

            if not liqs:
                bot.reply_to(message, f"Aucune whale liquidation (>${min_amount:,}) sur 24h.")
                return

            text = f"🐋 *Whale Liquidations* (>${min_amount:,} | 24h)\n\n"

            for liq in liqs:
                emoji = "🟢" if liq["liq_dir"] == "Long" else "🔴"
                text += f"{emoji} {liq['coin']}: ${liq['notional_total']:,.0f}\n"
                text += f"   └ {liq['time'][:16]}\n"

            bot.reply_to(message, text, parse_mode="Markdown")

        except Exception as e:
            bot.reply_to(message, f"❌ Erreur: {e}")

    # Commandes d'alertes

    @bot.message_handler(commands=['alert_add'])
    def handle_alert_add(message):
        args = message.text.split()[1:]

        if not args:
            bot.reply_to(
                message,
                "❌ Usage: /alert\\_add <type> <value> [min\\_usd]\n\n"
                "**Exemples:**\n"
                "`/alert_add BTC 100000` - Alertes BTC >$100K\n"
                "`/alert_add ETH` - Alertes ETH (défaut: $10K)\n"
                "`/alert_add 0x1234...5678 50000` - Suivre un wallet",
                parse_mode="Markdown"
            )
            return

        # Détecter si c'est une adresse wallet (commence par 0x)
        first_arg = args[0]
        if first_arg.startswith('0x'):
            # Alerte par wallet
            user_address = first_arg.lower()
            min_amount = int(args[1]) if len(args) > 1 else 10000

            try:
                alerts.add_alert(message.chat.id, coin=None, min_amount=min_amount, user=user_address)
                bot.reply_to(
                    message,
                    f"✅ *Alerte wallet créée!*\n\n"
                    f"👤 Wallet: `{user_address[:6]}...{user_address[-4:]}`\n"
                    f"💰 Min: ${min_amount:,}\n\n"
                    f"Tu recevras une notification pour chaque liquidation de ce wallet.",
                    parse_mode="Markdown"
                )
            except ValueError as e:
                bot.reply_to(message, f"❌ {e}")
        else:
            # Alerte par coin
            coin = first_arg.upper()
            min_amount = int(args[1]) if len(args) > 1 else 10000

            try:
                alerts.add_alert(message.chat.id, coin=coin, min_amount=min_amount)
                bot.reply_to(
                    message,
                    f"✅ *Alerte créée!*\n\n"
                    f"📌 Coin: {coin}\n"
                    f"💰 Min: ${min_amount:,}\n\n"
                    f"Tu recevras une notification pour chaque liquidation correspondante.",
                    parse_mode="Markdown"
                )
            except ValueError as e:
                bot.reply_to(message, f"❌ {e}")

    @bot.message_handler(commands=['alert_list'])
    def handle_alert_list(message):
        user_alerts = alerts.get_alerts(message.chat.id)

        if not user_alerts:
            bot.reply_to(
                message,
                "Tu n'as aucune alerte active.\n"
                "Utilise /alert\\_add pour en créer une.",
                parse_mode="Markdown"
            )
            return

        text = "📋 *Tes alertes:*\n\n"
        for i, alert in enumerate(user_alerts, 1):
            if alert.get("user"):
                # Alerte wallet
                wallet = alert["user"]
                min_amt = alert.get("min_amount", 0)
                text += f"{i}. 👤 `{wallet[:6]}...{wallet[-4:]}` > ${min_amt:,}\n"
            else:
                # Alerte coin
                coin = alert.get("coin") or "Tous"
                min_amt = alert.get("min_amount", 0)
                text += f"{i}. {coin} > ${min_amt:,}\n"

        text += "\nUtilise /alert\\_remove <numéro> pour supprimer."
        bot.reply_to(message, text, parse_mode="Markdown")

    @bot.message_handler(commands=['alert_remove'])
    def handle_alert_remove(message):
        args = message.text.split()[1:]

        if not args:
            bot.reply_to(message, "❌ Usage: /alert\\_remove <numéro>", parse_mode="Markdown")
            return

        try:
            index = int(args[0]) - 1
            alerts.remove_alert(message.chat.id, index)
            bot.reply_to(message, "✅ Alerte supprimée.")
        except (ValueError, IndexError):
            bot.reply_to(message, "❌ Numéro d'alerte invalide.")

    @bot.message_handler(commands=['alert_clear'])
    def handle_alert_clear(message):
        alerts.remove_alert(message.chat.id)
        bot.reply_to(message, "✅ Toutes tes alertes ont été supprimées.")
```

### Point d'Entrée (`main.py`)

```python
import telebot
from config import Config
from services.api import APIClient
from handlers.alerts import AlertManager
from handlers.commands import register_commands
from storage.redis_store import RedisStore

def main():
    # Initialisation
    bot = telebot.TeleBot(Config.BOT_TOKEN)
    api = APIClient(Config.API_BASE_URL)
    storage = RedisStore(Config.REDIS_URL)
    alerts = AlertManager(bot, storage)

    # Enregistrer les commandes
    register_commands(bot, api, alerts)

    # Démarrer le listener SSE pour les alertes
    alerts.start()

    print("🤖 Bot démarré...")

    try:
        bot.infinity_polling()
    except KeyboardInterrupt:
        print("\n⏹️ Arrêt du bot...")
        alerts.stop()

if __name__ == "__main__":
    main()
```

---

## Variables d'Environnement

```env
# Telegram
TELEGRAM_BOT_TOKEN=your_bot_token_here

# API LiquidTerminal
API_BASE_URL=https://api.liquidterminal.xyz

# Redis (optionnel, pour persistance des alertes)
REDIS_URL=redis://localhost:6379
```

---

## Déploiement

### Option 1: Railway
```bash
# railway.toml
[build]
builder = "NIXPACKS"

[deploy]
startCommand = "python main.py"
```

### Option 2: Docker
```dockerfile
FROM python:3.11-slim

WORKDIR /app
COPY requirements.txt .
RUN pip install -r requirements.txt

COPY . .
CMD ["python", "main.py"]
```

### Option 3: VPS (systemd)
```ini
# /etc/systemd/system/liquidterminal-bot.service
[Unit]
Description=LiquidTerminal Telegram Bot
After=network.target

[Service]
Type=simple
User=bot
WorkingDirectory=/opt/liquidterminal-bot
ExecStart=/opt/liquidterminal-bot/venv/bin/python main.py
Restart=always
RestartSec=10
EnvironmentFile=/opt/liquidterminal-bot/.env

[Install]
WantedBy=multi-user.target
```

---

## Points Importants

### Reconnexion SSE
- Toujours utiliser `last_event_id` pour ne pas perdre de liquidations
- Backoff exponentiel pour les reconnexions
- Timeout si pas de heartbeat pendant 60s

### Rate Limiting
- Maximum 5 alertes par utilisateur
- 1 seconde minimum entre deux alertes pour un même user
- Supprimer automatiquement les alertes si le chat est bloqué

### Performance
- Le bot utilise une seule connexion SSE globale
- Le filtrage se fait côté bot pour chaque utilisateur
- Redis recommandé pour la persistance des alertes

---

## Support

En cas de problème:
- Vérifier les logs du bot
- Tester l'endpoint SSE directement: `curl -N "https://api.liquidterminal.xyz/liquidations/stream"`
- Vérifier le status des connexions: `GET /liquidations/stream/stats`

---

## Schema Update: Multiple Subscriptions (2026-01-27)

As of January 2026, the Telegram bot supports up to 3 subscriptions per user.

### Database Changes
- `TelegramSubscription` now has a `name` field (VARCHAR 100, required)
- Relation changed from 1:1 to 1:N (removed UNIQUE constraint on `telegram_user_id`)
- Added indexes on `telegram_user_id` and `is_active` for performance

### Bot Implementation Notes
- Repository methods now return arrays instead of single objects
- All filter operations require a `subscriptionId` parameter
- Users can create/toggle/delete subscriptions individually
- Deduplication remains at user level (prevents duplicate alerts)

### Migration
- Applied via `prisma db push` on 2026-01-27
- Existing subscriptions were renamed to "Main Subscription"
- See `MIGRATION_GUIDE.md` and `MULTIPLE_SUBSCRIPTIONS_SUMMARY.md` for full details

---

## Account Linking & Bot API Routes (2026-02-01)

### Overview

The backend now provides dedicated API routes for the Telegram bot to access linked user data (wallets, wallet lists). This enables the bot to synchronize with LiquidTerminal user accounts via Privy.

### Architecture

```
Frontend (Privy SDK)                    Telegram Bot
       │                                      │
       │ POST /auth/link-telegram             │ GET /telegram/account
       │ (Bearer JWT)                         │ GET /telegram/wallets
       │                                      │ GET /telegram/wallet-lists
       │                                      │ GET /telegram/wallet-lists/:id/items
       ▼                                      │ (Authorization: Bot <API_KEY>)
  ┌─────────────────────────────────────────┐ │
  │           Backend                       │◄┘
  │  TelegramService (Singleton)            │
  │    ├── resolveUserId(telegramId)        │
  │    ├── getLinkedAccount()               │
  │    ├── getLinkedWallets()               │
  │    ├── getLinkedWalletLists()           │
  │    ├── getWalletListItems()             │
  │    ├── generateLinkCode()               │
  │    ├── verifyLinkCode()                 │
  │    ├── getLinkStatus()                  │
  │    └── unlinkAccount()                  │
  └─────────────────────────────────────────┘
```

### Authentication

Bot routes use a shared API key (not Privy JWT):

```
Authorization: Bot <TELEGRAM_BOT_API_KEY>
```

Set `TELEGRAM_BOT_API_KEY` in your environment variables on both the backend and bot.

### Bot API Routes

All routes require `Authorization: Bot <key>` header.

#### GET /telegram/account?telegramId=XXX

Check if a Telegram user is linked to a LiquidTerminal account.

**Response (linked):**
```json
{
  "success": true,
  "data": {
    "linked": true,
    "userId": 42,
    "email": "user@example.com",
    "name": "john",
    "walletCount": 12
  }
}
```

**Response (not linked):**
```json
{
  "success": true,
  "data": {
    "linked": false,
    "walletCount": 0
  }
}
```

#### GET /telegram/wallets?telegramId=XXX

Get wallets of the linked user. Supports pagination with `page` and `limit` query params.

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "address": "0x1234...5678",
      "name": "Main Wallet",
      "addedAt": "2026-01-15T10:30:00.000Z"
    }
  ],
  "pagination": {
    "total": 12,
    "page": 1,
    "limit": 50,
    "totalPages": 1,
    "hasNext": false,
    "hasPrevious": false
  }
}
```

#### GET /telegram/wallet-lists?telegramId=XXX

Get wallet lists of the linked user.

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "name": "Whale Watchers",
      "description": "Top whale wallets",
      "isPublic": true,
      "itemsCount": 5,
      "createdAt": "2026-01-15T10:30:00.000Z"
    }
  ]
}
```

#### GET /telegram/wallet-lists/:id/items?telegramId=XXX

Get items of a specific wallet list. Returns the same format as `GET /walletlists/:id/items`.

#### POST /telegram/verify-link

Called by the bot when a user starts the bot with a deep link code (`/start LINK_XXXXX`). The bot extracts the code and sends it with the user's Telegram info.

**Request:**
```json
{
  "code": "A1B2C3D4",
  "telegramId": "123456789",
  "username": "john_doe",
  "firstName": "John"
}
```

**Response (success):**
```json
{
  "success": true,
  "message": "Account linked successfully",
  "data": { "userId": 42 }
}
```

**Response (expired/invalid code):**
```json
{
  "success": false,
  "message": "Invalid or expired link code",
  "code": "INVALID_LINK_CODE"
}
```

**Response (already linked to another user):**
```json
{
  "success": false,
  "message": "This Telegram account is already linked to another user",
  "code": "TELEGRAM_ALREADY_LINKED"
}
```

### Frontend: Linking a Telegram Account (Deep Link System)

Privy Telegram authentication is **not supported on `.xyz` domains**. Instead, we use a deep link system that bypasses Privy entirely for Telegram:

#### Flow

```
Frontend                    Backend                    Telegram Bot
   │                           │                           │
   ├─ POST /auth/telegram/     │                           │
   │  generate-link            │                           │
   │  (Privy JWT)              │                           │
   │                           │                           │
   │◄── { code, deepLink,     │                           │
   │      expiresIn: 300 }     │                           │
   │                           │                           │
   │  Show "Link Telegram"     │                           │
   │  button with deepLink     │                           │
   │  ─────────────────────────────────────────────────►   │
   │                           │                           │
   │                           │     User clicks deep link │
   │                           │     Bot receives /start   │
   │                           │     LINK_A1B2C3D4         │
   │                           │                           │
   │                           │◄── POST /telegram/        │
   │                           │    verify-link             │
   │                           │    { code, telegramId,    │
   │                           │      username, firstName } │
   │                           │                           │
   │                           │──► { success: true }      │
   │                           │                           │
   │  Poll every 2s:           │                           │
   │  GET /auth/telegram/      │                           │
   │  link-status/:code        │                           │
   │  (Privy JWT)              │                           │
   │                           │                           │
   │◄── { linked: true,       │                           │
   │      telegramUsername }   │                           │
   │                           │                           │
   │  Show success UI          │                           │
```

#### Step 1: Generate Link Code

```
POST /auth/telegram/generate-link
Authorization: Bearer <privy-jwt>
```

**Response:**
```json
{
  "success": true,
  "message": "Link code generated",
  "data": {
    "code": "A1B2C3D4",
    "deepLink": "https://t.me/LiquidTerminalBot?start=LINK_A1B2C3D4",
    "expiresIn": 300
  }
}
```

#### Step 2: Show Deep Link Button

Display the `deepLink` URL as a button (e.g. "Open Telegram"). When clicked, it opens the bot in Telegram. The bot automatically receives the code via `/start LINK_A1B2C3D4`.

#### Step 3: Poll Link Status

```
GET /auth/telegram/link-status/:code
Authorization: Bearer <privy-jwt>
```

**Response (pending):**
```json
{
  "success": true,
  "data": { "linked": false }
}
```

**Response (completed):**
```json
{
  "success": true,
  "data": {
    "linked": true,
    "telegramUsername": "john_doe"
  }
}
```

Poll every 2-3 seconds. Stop when `linked: true` or after 5 minutes (code expired).

#### Step 4: Unlink

```
DELETE /auth/telegram/unlink
Authorization: Bearer <privy-jwt>
```

**Response:**
```json
{
  "success": true,
  "message": "Telegram account unlinked successfully"
}
```

### Database Changes

- Added Prisma relation `TelegramUser.linkedUser -> User` (FK on existing `linked_user_id` column)
- Added inverse relation `User.telegramUser -> TelegramUser`
- Migration: `20260201180000_add_telegram_user_relation`

### Environment Variables

```env
# Add to backend .env
TELEGRAM_BOT_API_KEY=your_shared_secret_key_here
TELEGRAM_BOT_USERNAME=LiquidTerminalBot
```

### Bot Implementation: Handling Deep Link

When the bot receives `/start LINK_XXXXX`, it must:

1. Extract the code from the start parameter (strip `LINK_` prefix)
2. Call `POST /telegram/verify-link` with the code + user's Telegram info
3. Confirm to the user that linking succeeded (or show error)

```python
# Example: handling deep link in bot
import requests

async def handle_start(update, context):
    args = context.args  # e.g. ["LINK_A1B2C3D4"]
    
    if args and args[0].startswith("LINK_"):
        code = args[0][5:]  # Remove "LINK_" prefix
        telegram_user = update.effective_user
        
        response = requests.post(
            f"{API_BASE_URL}/telegram/verify-link",
            json={
                "code": code,
                "telegramId": str(telegram_user.id),
                "username": telegram_user.username,
                "firstName": telegram_user.first_name,
            },
            headers={"Authorization": f"Bot {BOT_API_KEY}"}
        )
        
        if response.ok:
            await update.message.reply_text(
                "Account linked successfully! You can now use /wallets."
            )
        else:
            error = response.json()
            await update.message.reply_text(
                f"Failed to link: {error.get('message', 'Unknown error')}"
            )
        return
    
    # Normal /start behavior...
```

### Bot Implementation: Using Linked Wallets

When `useLinkedWallets: true` on a subscription, the bot should:

1. NOT store wallets locally
2. On each liquidation, call `GET /telegram/wallets?telegramId=XXX`
3. Filter the liquidation against the returned wallet addresses
4. This ensures real-time sync with LiquidTerminal

```python
# Example: fetch linked wallets for filtering
import requests

def get_linked_wallets(telegram_id: int) -> list[str]:
    response = requests.get(
        f"{API_BASE_URL}/telegram/wallets",
        params={"telegramId": str(telegram_id)},
        headers={"Authorization": f"Bot {BOT_API_KEY}"}
    )
    if response.ok:
        data = response.json()
        return [w["address"] for w in data.get("data", [])]
    return []
```
