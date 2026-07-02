/**
 * Staking domain constants.
 *
 * Single source of truth for the "Hyper Foundation" validator rule. The
 * Foundation operates several validators whose combined stake sits outside the
 * community allocation; identifying them in one place lets every staking metric
 * (concentration, distribution, governance vote weight) expose a community-only
 * "ex-Foundation" view without duplicating the rule.
 *
 * Identification is by display-name prefix because the upstream Hyperliquid
 * `validatorSummaries` feed carries no Foundation flag and no fixed address set
 * (the Foundation reuses the "Hyper Foundation N" naming convention).
 */
export const FOUNDATION_VALIDATOR_NAME_PREFIXES = ['Hyper Foundation'] as const;

/**
 * Returns true when a validator belongs to the Hyper Foundation, based on its
 * display name. Prefix-based and case-sensitive to mirror the upstream naming
 * convention ("Hyper Foundation 1" … "Hyper Foundation 5").
 */
export function isFoundationValidator(name: string | null | undefined): boolean {
  if (!name) {
    return false;
  }
  return FOUNDATION_VALIDATOR_NAME_PREFIXES.some((prefix) => name.startsWith(prefix));
}
