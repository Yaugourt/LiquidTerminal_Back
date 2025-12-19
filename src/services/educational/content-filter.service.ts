import {
    BLACKLISTED_DOMAINS,
    BLOCKED_EXTENSIONS,
    MALWARE_PATTERNS,
    INJECTION_PATTERNS,
    URL_MANIPULATION_PATTERNS,
    PUNYCODE_PATTERNS,
    HOMOGRAPH_CHARS,
    URL_VALIDATION,
    ContentFilterResult,
} from '../../constants/content-filter.constants';
import { logDeduplicator } from '../../utils/logDeduplicator';

/**
 * Service de filtrage de contenu pour les URLs soumises par les utilisateurs.
 * Vérifie les domaines blacklistés, patterns malveillants, injection, etc.
 */
export class ContentFilterService {
    private static instance: ContentFilterService;

    private constructor() { }

    static getInstance(): ContentFilterService {
        if (!ContentFilterService.instance) {
            ContentFilterService.instance = new ContentFilterService();
        }
        return ContentFilterService.instance;
    }

    /**
     * Valide une URL soumise par un utilisateur
     */
    validateUrl(url: string): ContentFilterResult {
        try {
            // 1. Validation de base
            const basicResult = this.validateBasicUrl(url);
            if (!basicResult.valid) {
                return basicResult;
            }

            // 2. Vérification domaine blacklisté
            const domainResult = this.checkBlacklistedDomain(url);
            if (!domainResult.valid) {
                return domainResult;
            }

            // 3. Vérification extensions bloquées
            const extensionResult = this.checkBlockedExtension(url);
            if (!extensionResult.valid) {
                return extensionResult;
            }

            // 4. Vérification patterns malware/phishing
            const malwareResult = this.checkMalwarePatterns(url);
            if (!malwareResult.valid) {
                return malwareResult;
            }

            // 5. Vérification injection (XSS, SQL, path traversal)
            const injectionResult = this.checkInjectionPatterns(url);
            if (!injectionResult.valid) {
                return injectionResult;
            }

            // 6. Vérification manipulation d'URL
            const manipulationResult = this.checkUrlManipulation(url);
            if (!manipulationResult.valid) {
                return manipulationResult;
            }

            // 7. Vérification Punycode/Homograph
            const homographResult = this.checkHomographAttack(url);
            if (!homographResult.valid) {
                return homographResult;
            }

            logDeduplicator.info('URL passed content filter validation', { url });
            return { valid: true };

        } catch (error) {
            logDeduplicator.error('Content filter error', { url, error });
            return {
                valid: false,
                reason: 'INVALID_URL',
                details: 'URL parsing failed',
            };
        }
    }

    /**
     * Validation basique de l'URL
     */
    private validateBasicUrl(url: string): ContentFilterResult {
        // Longueur minimale
        if (url.length < URL_VALIDATION.MIN_LENGTH) {
            return {
                valid: false,
                reason: 'URL_TOO_SHORT',
                details: `URL must be at least ${URL_VALIDATION.MIN_LENGTH} characters`,
            };
        }

        // Longueur maximale
        if (url.length > URL_VALIDATION.MAX_LENGTH) {
            return {
                valid: false,
                reason: 'URL_TOO_LONG',
                details: `URL must be at most ${URL_VALIDATION.MAX_LENGTH} characters`,
            };
        }

        // Parse URL
        let parsedUrl: URL;
        try {
            parsedUrl = new URL(url);
        } catch {
            return {
                valid: false,
                reason: 'INVALID_URL',
                details: 'Invalid URL format',
            };
        }

        // HTTPS requis
        if (URL_VALIDATION.REQUIRE_HTTPS && parsedUrl.protocol !== 'https:') {
            return {
                valid: false,
                reason: 'HTTPS_REQUIRED',
                details: 'Only HTTPS URLs are allowed',
            };
        }

        return { valid: true };
    }

    /**
     * Vérifie si le domaine est blacklisté
     */
    private checkBlacklistedDomain(url: string): ContentFilterResult {
        const parsedUrl = new URL(url);
        const hostname = parsedUrl.hostname.toLowerCase();
        const fullUrl = url.toLowerCase();

        for (const domain of BLACKLISTED_DOMAINS) {
            // Vérifier le hostname exact ou sous-domaine
            if (hostname === domain || hostname.endsWith(`.${domain}`)) {
                return {
                    valid: false,
                    reason: 'BLACKLISTED_DOMAIN',
                    details: `Domain "${domain}" is not allowed`,
                };
            }

            // Vérifier si le domaine apparaît dans l'URL complète (pour les paths comme discord.com/invite)
            if (fullUrl.includes(domain)) {
                return {
                    valid: false,
                    reason: 'BLACKLISTED_DOMAIN',
                    details: `Domain "${domain}" is not allowed`,
                };
            }
        }

        return { valid: true };
    }

    /**
     * Vérifie si l'URL pointe vers un fichier avec extension bloquée
     */
    private checkBlockedExtension(url: string): ContentFilterResult {
        const parsedUrl = new URL(url);
        const pathname = parsedUrl.pathname.toLowerCase();

        for (const ext of BLOCKED_EXTENSIONS) {
            if (pathname.endsWith(ext)) {
                return {
                    valid: false,
                    reason: 'BLOCKED_EXTENSION',
                    details: `File extension "${ext}" is not allowed`,
                };
            }
        }

        return { valid: true };
    }

    /**
     * Vérifie les patterns de malware/phishing
     */
    private checkMalwarePatterns(url: string): ContentFilterResult {
        for (const pattern of MALWARE_PATTERNS) {
            if (pattern.test(url)) {
                return {
                    valid: false,
                    reason: 'MALWARE_PATTERN',
                    details: 'URL contains suspicious content patterns',
                };
            }
        }

        return { valid: true };
    }

    /**
     * Vérifie les patterns d'injection (XSS, SQL, path traversal)
     */
    private checkInjectionPatterns(url: string): ContentFilterResult {
        // Décoder l'URL pour détecter les tentatives encodées
        let decodedUrl = url;
        try {
            decodedUrl = decodeURIComponent(url);
            // Double décodage pour %25 encodings
            decodedUrl = decodeURIComponent(decodedUrl);
        } catch {
            // Ignorer les erreurs de décodage
        }

        for (const pattern of INJECTION_PATTERNS) {
            if (pattern.test(url) || pattern.test(decodedUrl)) {
                return {
                    valid: false,
                    reason: 'INJECTION_DETECTED',
                    details: 'URL contains injection patterns',
                };
            }
        }

        return { valid: true };
    }

    /**
     * Vérifie les manipulations d'URL (@ trick, IP-based, open redirects)
     */
    private checkUrlManipulation(url: string): ContentFilterResult {
        for (const pattern of URL_MANIPULATION_PATTERNS) {
            if (pattern.test(url)) {
                return {
                    valid: false,
                    reason: 'URL_MANIPULATION',
                    details: 'URL contains manipulation patterns',
                };
            }
        }

        return { valid: true };
    }

    /**
     * Vérifie les attaques homograph/Punycode
     */
    private checkHomographAttack(url: string): ContentFilterResult {
        // Vérifier Punycode
        for (const pattern of PUNYCODE_PATTERNS) {
            if (pattern.test(url)) {
                return {
                    valid: false,
                    reason: 'PUNYCODE_DETECTED',
                    details: 'Punycode/IDN domains are not allowed',
                };
            }
        }

        // Vérifier caractères homograph
        for (const char of HOMOGRAPH_CHARS) {
            if (url.includes(char)) {
                return {
                    valid: false,
                    reason: 'HOMOGRAPH_DETECTED',
                    details: 'URL contains lookalike Unicode characters',
                };
            }
        }

        return { valid: true };
    }
}

// Export singleton instance
export const contentFilterService = ContentFilterService.getInstance();
