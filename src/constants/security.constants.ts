export const SECURITY_CONSTANTS = {
  // Liste des origines autorisées pour les requêtes CORS
  ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS 
    ? process.env.ALLOWED_ORIGINS.split(',').map(origin => origin.trim())
    : [
        'https://liquidterminal.xyz',
        'https://liquidterminal-front.vercel.app',
        'http://localhost:3000',
        'http://localhost:3001',
        'http://localhost:3002',
        'http://localhost:5173',
        'http://127.0.0.1:3000',
        'http://127.0.0.1:3001',
        'http://127.0.0.1:3002',
        'http://127.0.0.1:5173'
      ],
  
  // Durée de validité du token JWT (24 heures)
  TOKEN_EXPIRY: 24 * 60 * 60,

  // Fenêtre de temps pour le rate limiting (1 minute)
  RATE_LIMIT_WINDOW: 60 * 1000
} as const;

// SSRF blocklist — IPs that outbound fetchers (linkPreview, etc.) must refuse
// even if the upstream URL resolves to them. Covers private + loopback + link-local
// + CGNAT + cloud metadata endpoints. Applied after DNS resolution.
export const SSRF_BLOCKED_CIDRS_V4 = [
  '0.0.0.0/8',          // "this network"
  '10.0.0.0/8',         // RFC1918 private
  '100.64.0.0/10',      // CGNAT
  '127.0.0.0/8',        // loopback
  '169.254.0.0/16',     // link-local + AWS/GCP/Azure metadata (169.254.169.254)
  '172.16.0.0/12',      // RFC1918 private
  '192.0.0.0/24',       // IETF protocol assignments
  '192.0.2.0/24',       // TEST-NET-1
  '192.168.0.0/16',     // RFC1918 private
  '198.18.0.0/15',      // benchmarking
  '198.51.100.0/24',    // TEST-NET-2
  '203.0.113.0/24',     // TEST-NET-3
  '224.0.0.0/4',        // multicast
  '240.0.0.0/4',        // reserved
  '255.255.255.255/32', // broadcast
] as const;

export const SSRF_BLOCKED_CIDRS_V6 = [
  '::1/128',           // loopback
  '::/128',            // unspecified
  '::ffff:0:0/96',     // IPv4-mapped (would re-introduce blocked v4)
  'fc00::/7',          // unique local
  'fe80::/10',         // link-local
  'fec0::/10',         // site-local (deprecated)
  'ff00::/8',          // multicast
  '2001:db8::/32',     // documentation
] as const;