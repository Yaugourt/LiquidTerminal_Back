// ============ DOMAINES BLOQUÉS ============
export const BLACKLISTED_DOMAINS = [
    // URL shorteners (cachent la destination réelle)
    'bit.ly', 'tinyurl.com', 'goo.gl', 't.co', 'ow.ly', 'is.gd',
    'buff.ly', 'adf.ly', 'shorte.st', 'bc.vc', 'j.mp', 'v.gd',

    // Discord (spam potentiel)
    'discord.gg', 'discord.com/invite',

    // Hébergement fichiers directs
    'mediafire.com', 'mega.nz', 'anonfiles.com', 'gofile.io',
    'wetransfer.com', 'sendspace.com', 'zippyshare.com',

    // Redirecteurs suspects
    'linktr.ee', 'linkin.bio', 'beacons.ai',

    // Pastebin (peut contenir du code malveillant)
    'pastebin.com', 'hastebin.com', 'ghostbin.com',
];

// ============ EXTENSIONS BLOQUÉES ============
export const BLOCKED_EXTENSIONS = [
    // Exécutables Windows/Mac/Linux
    '.exe', '.msi', '.bat', '.cmd', '.ps1', '.sh', '.app', '.dmg',
    '.deb', '.rpm', '.bin', '.run',

    // Scripts dangereux
    '.vbs', '.wsf', '.jar', '.scr', '.pif', '.com', '.hta',

    // Archives (téléchargements directs)
    '.zip', '.rar', '.7z', '.tar', '.gz', '.bz2', '.xz',

    // Documents avec macros
    '.docm', '.xlsm', '.pptm', '.dotm',

    // Autres dangereux
    '.iso', '.img', '.torrent',
];

// ============ PATTERNS MALWARE/PHISHING CRYPTO ============
export const MALWARE_PATTERNS: RegExp[] = [
    // Faux wallet/crypto scams (2024 techniques)
    /metamask.*claim/i,
    /wallet.*connect.*verify/i,
    /airdrop.*claim.*now/i,
    /send.*\d+.*receive.*\d+/i,        // "Send 1 ETH receive 2 ETH"
    /free\s*(eth|btc|usdt|crypto|nft)/i,
    /guaranteed\s*(profit|return|apy)/i,
    /double\s*your\s*(crypto|eth|btc)/i,
    /claim.*free.*token/i,
    /connect.*wallet.*reward/i,
    /verify.*wallet.*secure/i,

    // Urgence artificielle
    /urgent.*action.*required/i,
    /account.*suspended/i,
    /verify.*immediately/i,
    /limited.*time.*offer/i,
    /act.*now.*before/i,

    // Téléchargements suspects
    /\/download\//i,
    /\?download=/i,
    /dropbox\.com.*\?dl=1/i,
    /drive\.google\.com.*\/uc\?.*export=download/i,

    // Faux login/verification
    /login.*verify.*account/i,
    /confirm.*identity.*click/i,
];

// ============ INJECTION PROTECTION ============
export const INJECTION_PATTERNS: RegExp[] = [
    // SQL injection
    /(union|select|insert|update|delete|drop)\s+(all|from|into)/i,
    /['";]\s*(-{2}|\/\*)/,
    /\bor\b.*['"].*['"].*=/i,  // OR "x"="x"

    // XSS patterns
    /<script/i,
    /javascript:/i,
    /on(click|error|load|mouseover|focus|blur)\s*=/i,
    /data:text\/html/i,
    /vbscript:/i,

    // Path traversal
    /\.\.\//,
    /%2e%2e/i,           // Encoded ../
    /%252e%252e/i,       // Double encoded ../
    /%00/,               // Null byte
    /%0a|%0d/i,          // CRLF injection
];

// ============ URL MANIPULATION ATTACKS ============
export const URL_MANIPULATION_PATTERNS: RegExp[] = [
    // @ trick: http://legitimate.com@malicious.com
    /@[a-z0-9]/i,

    // IP-based URLs (suspicious)
    /^https?:\/\/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/i,
    /^https?:\/\/0x[a-f0-9]+/i,       // Hex IP
    /^https?:\/\/\d{10,}/,            // Decimal IP

    // Open redirect patterns
    /[?&](redirect|url|next|return|goto|link|dest|target)=/i,

    // Fragment abuse
    /#javascript:/i,
    /#data:/i,

    // IPFS phishing (Web3 specific)
    /ipfs:\/\//i,
    /ipfs\.io.*\/ipfs\//i,

    // Suspicious subdomains (typosquatting)
    /\.(xyz|tk|ml|ga|cf|gq|top)\//i,  // Free TLDs often used for scams
];

// ============ PUNYCODE/HOMOGRAPH DETECTION ============
export const PUNYCODE_PATTERNS: RegExp[] = [
    /xn--/i,  // Punycode prefix - potential homograph attack
];

// Caractères Unicode lookalikes à détecter
export const HOMOGRAPH_CHARS = [
    '\u0430', // Cyrillic 'а' looks like 'a'
    '\u0435', // Cyrillic 'е' looks like 'e'
    '\u043E', // Cyrillic 'о' looks like 'o'
    '\u0440', // Cyrillic 'р' looks like 'p'
    '\u0441', // Cyrillic 'с' looks like 'c'
    '\u0445', // Cyrillic 'х' looks like 'x'
    '\u0443', // Cyrillic 'у' looks like 'y'
];

// ============ VALIDATION RULES ============
export const URL_VALIDATION = {
    MIN_LENGTH: 10,
    MAX_LENGTH: 500,
    REQUIRE_HTTPS: true,
    MAX_REDIRECTS: 0,        // No open redirects
    BLOCK_IP_URLS: true,     // No IP-based URLs
    BLOCK_PUNYCODE: true,    // No IDN homograph attacks
};

// ============ RATE LIMITING ============
export const CONTRIBUTION_LIMITS = {
    MAX_SUBMISSIONS_PER_DAY: 5,
    WINDOW_MS: 24 * 60 * 60 * 1000, // 24 hours
};

// ============ CONTENT FILTER RESULT TYPES ============
export type ContentFilterResultType =
    | 'BLACKLISTED_DOMAIN'
    | 'BLOCKED_EXTENSION'
    | 'MALWARE_PATTERN'
    | 'INJECTION_DETECTED'
    | 'URL_MANIPULATION'
    | 'PUNYCODE_DETECTED'
    | 'HOMOGRAPH_DETECTED'
    | 'INVALID_URL'
    | 'URL_TOO_SHORT'
    | 'URL_TOO_LONG'
    | 'HTTPS_REQUIRED';

export interface ContentFilterResult {
    valid: boolean;
    reason?: ContentFilterResultType;
    details?: string;
}
