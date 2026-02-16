interface RateLimitConfig {
  maxWeightPerMinute: number;
  requestWeight: number;
}

export class RateLimiterService {
  private static instances = new Map<string, RateLimiterService>();
  private static readonly CLEANUP_INTERVAL_MS = 60000;
  private static readonly MAX_IPS = 10000;

  private readonly config: RateLimitConfig;
  private requestWeights: Map<string, { weight: number; timestamp: number }[]>;
  private cleanupTimer: NodeJS.Timeout;

  private constructor(config: RateLimitConfig) {
    this.config = config;
    this.requestWeights = new Map();
    this.cleanupTimer = setInterval(() => this.cleanupAllStaleEntries(), RateLimiterService.CLEANUP_INTERVAL_MS);
  }

  public static getInstance(serviceName: string, config: RateLimitConfig): RateLimiterService {
    if (!RateLimiterService.instances.has(serviceName)) {
      RateLimiterService.instances.set(serviceName, new RateLimiterService(config));
    }
    return RateLimiterService.instances.get(serviceName)!;
  }

  public checkRateLimit(ip: string): boolean {
    this.cleanupOldEntries(ip);
    const totalWeight = this.getTotalWeight(ip);

    if (totalWeight + this.config.requestWeight > this.config.maxWeightPerMinute) {
      return false;
    }

    this.addRequest(ip);
    return true;
  }

  public getCurrentWeight(ip: string): number {
    this.cleanupOldEntries(ip);
    return this.getTotalWeight(ip);
  }

  private cleanupOldEntries(ip: string): void {
    const now = Date.now();
    const entries = this.requestWeights.get(ip) || [];
    const recentEntries = entries.filter(entry => now - entry.timestamp < 60000);
    if (recentEntries.length === 0) {
      this.requestWeights.delete(ip);
    } else {
      this.requestWeights.set(ip, recentEntries);
    }
  }

  private cleanupAllStaleEntries(): void {
    const now = Date.now();
    for (const [ip, entries] of this.requestWeights) {
      const recentEntries = entries.filter(entry => now - entry.timestamp < 60000);
      if (recentEntries.length === 0) {
        this.requestWeights.delete(ip);
      } else {
        this.requestWeights.set(ip, recentEntries);
      }
    }
  }

  private evictOldestIp(): void {
    let oldestIp: string | null = null;
    let oldestTimestamp = Infinity;

    for (const [ip, entries] of this.requestWeights) {
      const latestEntry = entries[entries.length - 1];
      if (latestEntry && latestEntry.timestamp < oldestTimestamp) {
        oldestTimestamp = latestEntry.timestamp;
        oldestIp = ip;
      }
    }

    if (oldestIp) {
      this.requestWeights.delete(oldestIp);
    }
  }

  private getTotalWeight(ip: string): number {
    const entries = this.requestWeights.get(ip) || [];
    return entries.reduce((total, entry) => total + entry.weight, 0);
  }

  private addRequest(ip: string): void {
    if (!this.requestWeights.has(ip) && this.requestWeights.size >= RateLimiterService.MAX_IPS) {
      this.evictOldestIp();
    }
    const entries = this.requestWeights.get(ip) || [];
    entries.push({ weight: this.config.requestWeight, timestamp: Date.now() });
    this.requestWeights.set(ip, entries);
  }

  public destroy(): void {
    clearInterval(this.cleanupTimer);
    this.requestWeights.clear();
  }

  public static destroyAll(): void {
    for (const instance of RateLimiterService.instances.values()) {
      instance.destroy();
    }
    RateLimiterService.instances.clear();
  }
} 