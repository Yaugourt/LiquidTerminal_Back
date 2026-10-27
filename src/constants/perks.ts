/**
 * Offers for Liquid Terminal users (the /perks page).
 *
 * `members` offers carry what must stay behind sign-in (a promo code, a
 * private link): this file is server-side only, and `GET /perks/public`
 * strips `cta` and `code` from them. The front never ships these values.
 *
 * List only offers a partner confirmed in writing, with their real terms.
 */

export interface Perk {
  id: string;
  partner: string;
  /** Partner site, shown to everyone. */
  partnerUrl: string;
  title: string;
  /** One or two sentences, the real terms. No em dashes. */
  description: string;
  /** `public`: everyone sees everything. `members`: signed-in users only get `cta` and `code`. */
  access: 'public' | 'members';
  /** Where the offer is used: an internal route ("/names") or an https URL. */
  cta: { label: string; href: string };
  /** Promo code, members only. */
  code?: string;
  /** Last day of the offer, YYYY-MM-DD (UTC). Past offers are not served. */
  expires?: string;
}

export const PERKS: Perk[] = [
  {
    id: 'hl-names-referral',
    partner: 'Hyperliquid Names',
    partnerUrl: 'https://hlnames.xyz',
    title: '20% off your .hl name',
    description:
      'Mint a .hl name from Liquid Terminal and pay 20% less than the list price. The discount is applied on chain by our referral; nothing to enter.',
    access: 'public',
    cta: { label: 'Get a .hl name', href: '/names' },
  },
];
