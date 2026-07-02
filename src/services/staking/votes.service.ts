import {
  ValidatorL1Vote,
  ValidatorSummary,
  ValidatorVoteInfo,
  ValidatorVotesStats,
  VoteParticipant
} from '../../types/staking.types';
import { redisService } from '../../core/redis.service';
import { ValidatorVotesError } from '../../errors/staking.errors';
import { isFoundationValidator } from '../../constants/staking.constants';
import { logDeduplicator } from '../../utils/logDeduplicator';

const WEI_PER_HYPE = 100000000; // 10^8

/**
 * Joins the pending L1 votes snapshot (validatorL1Votes) against the validator
 * summaries cache to produce governance-ready metrics: participation, stake
 * weight, and a single-sourced Foundation split (community-only view).
 *
 * Reads two caches written by their respective HL clients; never calls HL
 * directly. Mirrors ValidatorSummariesService (cache + channel subscription).
 */
export class ValidatorVotesService {
  private static instance: ValidatorVotesService;
  private readonly VOTES_CACHE_KEY = 'staking:validators:votes:raw_data';
  private readonly VALIDATORS_CACHE_KEY = 'staking:validators:raw_data';
  private readonly UPDATE_CHANNEL = 'staking:validators:votes:updated';
  private lastUpdate: number = 0;

  private constructor() {
    this.setupSubscriptions();
  }

  private setupSubscriptions(): void {
    redisService.subscribe(this.UPDATE_CHANNEL, async (message) => {
      try {
        const { type, timestamp } = JSON.parse(message);
        if (type === 'DATA_UPDATED') {
          this.lastUpdate = timestamp;
          logDeduplicator.info('Validator votes data updated', { timestamp });
        }
      } catch (error) {
        logDeduplicator.error('Error processing votes cache update:', { error: error instanceof Error ? error.message : String(error) });
      }
    });
  }

  public static getInstance(): ValidatorVotesService {
    if (!ValidatorVotesService.instance) {
      ValidatorVotesService.instance = new ValidatorVotesService();
    }
    return ValidatorVotesService.instance;
  }

  /**
   * Best-effort label + human summary for a polymorphic L1 action.
   * Shape observed in the wild: { O: { <actionType>: { details?: string, ... } } }.
   */
  private extractActionMeta(action: Record<string, unknown>): { actionType: string; summary: string | null } {
    let actionType = 'unknown';
    try {
      const outer = action ? Object.values(action)[0] : undefined;
      const inner = outer && typeof outer === 'object' ? (outer as Record<string, unknown>) : action;
      const key = inner ? Object.keys(inner)[0] : undefined;
      if (key) {
        actionType = key;
      }
    } catch {
      // keep default label
    }
    return { actionType, summary: this.findDetails(action) };
  }

  /** Recursively find the first string `details` field inside the action union. */
  private findDetails(value: unknown): string | null {
    if (!value || typeof value !== 'object') {
      return null;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = this.findDetails(item);
        if (found) {
          return found;
        }
      }
      return null;
    }
    const obj = value as Record<string, unknown>;
    if (typeof obj.details === 'string') {
      return obj.details;
    }
    for (const v of Object.values(obj)) {
      const found = this.findDetails(v);
      if (found) {
        return found;
      }
    }
    return null;
  }

  private async readCaches(): Promise<{ votes: ValidatorL1Vote[]; validators: ValidatorSummary[] }> {
    const [votesRaw, validatorsRaw] = await Promise.all([
      redisService.get(this.VOTES_CACHE_KEY),
      redisService.get(this.VALIDATORS_CACHE_KEY)
    ]);

    if (!validatorsRaw) {
      throw new ValidatorVotesError('No validator data available in cache');
    }

    // Votes snapshot can legitimately be empty (no pending proposals).
    const votes = votesRaw ? (JSON.parse(votesRaw) as ValidatorL1Vote[]) : [];
    const validators = JSON.parse(validatorsRaw) as ValidatorSummary[];
    return { votes, validators };
  }

  /**
   * Returns the pending votes joined to validator stake + Foundation flag,
   * plus an overall snapshot context. Empty snapshot → empty data, valid stats.
   */
  public async getValidatorVotes(): Promise<{ votes: ValidatorVoteInfo[]; stats: ValidatorVotesStats }> {
    try {
      const { votes, validators } = await this.readCaches();

      // Index validators by address for the join (votes[] carry `validator`).
      const byAddress = new Map<string, ValidatorSummary>();
      for (const v of validators) {
        byAddress.set(v.validator.toLowerCase(), v);
      }

      const stakeOf = (v: ValidatorSummary): number => Number(v.stake) / WEI_PER_HYPE;
      const totalStake = validators.reduce((sum, v) => sum + stakeOf(v), 0);
      const foundationStake = validators
        .filter((v) => isFoundationValidator(v.name))
        .reduce((sum, v) => sum + stakeOf(v), 0);
      const communityStake = totalStake - foundationStake;
      const totalValidators = validators.length;

      const formatted: ValidatorVoteInfo[] = votes.map((vote, index) => {
        const { actionType, summary } = this.extractActionMeta(vote.action);

        const voters: VoteParticipant[] = (vote.votes || [])
          .map((addr) => byAddress.get(addr.toLowerCase()))
          .filter((v): v is ValidatorSummary => Boolean(v))
          .map((v) => ({
            validator: v.validator,
            name: v.name,
            stake: stakeOf(v),
            isFoundation: isFoundationValidator(v.name)
          }));

        const votingStake = voters.reduce((sum, v) => sum + v.stake, 0);
        const communityVotingStake = voters
          .filter((v) => !v.isFoundation)
          .reduce((sum, v) => sum + v.stake, 0);
        const foundationVoterCount = voters.filter((v) => v.isFoundation).length;

        return {
          id: index,
          actionType,
          summary,
          expireTime: vote.expireTime,
          quorumReached: Boolean(vote.quorumReached),
          voterCount: voters.length,
          totalValidators,
          participationPct: totalValidators > 0 ? (voters.length / totalValidators) * 100 : 0,
          votingStake,
          stakeWeightPct: totalStake > 0 ? (votingStake / totalStake) * 100 : 0,
          stakeWeightExFoundationPct: communityStake > 0 ? (communityVotingStake / communityStake) * 100 : 0,
          foundationVoterCount,
          voters
        };
      });

      const stats: ValidatorVotesStats = {
        totalValidators,
        totalStake,
        foundationStake,
        communityStake,
        pendingCount: formatted.length,
        lastUpdate: this.lastUpdate
      };

      logDeduplicator.info('Validator votes retrieved and joined from cache', {
        pendingCount: formatted.length,
        totalValidators,
        lastUpdate: this.lastUpdate
      });

      return { votes: formatted, stats };
    } catch (error) {
      logDeduplicator.error('Error fetching validator votes from cache:', { error: error instanceof Error ? error.message : String(error) });
      if (error instanceof ValidatorVotesError) {
        throw error;
      }
      throw new ValidatorVotesError('Failed to fetch and join validator votes from cache');
    }
  }
}
