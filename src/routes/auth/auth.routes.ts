import { Router, Request, Response } from "express";
import { AuthService } from "../../services/auth/auth.service";
import { ReferralService } from "../../services/auth/referral.service";
import { userRepository } from "../../repositories/user.repository";
import { validatePrivyToken } from "../../middleware/authMiddleware";
import { validateLogin, validateUserParams } from "../../middleware/validation/authValidation.middleware";
import { marketRateLimiter } from "../../middleware/apiRateLimiter";
import { UserNotFoundError } from "../../errors/auth.errors";
import { logDeduplicator } from "../../utils/logDeduplicator";

const router = Router();
const authService = AuthService.getInstance();
const referralService = ReferralService.getInstance();

// Appliquer le rate limiting à toutes les routes d'authentification
router.use(marketRateLimiter);

// Route de connexion
router.post("/login", validatePrivyToken, validateLogin, (req: Request, res: Response): void => {
  logDeduplicator.info('POST /auth/login called', { 
    method: req.method,
    headers: req.headers,
    body: req.body 
  });
  
  const { privyUserId, name, referrerName } = req.body;

  logDeduplicator.info('Login request received', { 
    hasPrivyUserId: !!privyUserId,
    hasName: !!name,
    hasUser: !!req.user
  });

  if (!req.user) {
    logDeduplicator.warn('Login attempt without authentication', { 
      hasPrivyUserId: !!privyUserId, 
      hasName: !!name,
      path: req.path 
    });
    
    res.status(401).json({ 
      success: false,
      message: "Not authenticated",
      code: "NOT_AUTHENTICATED"
    });
    return;
  }

  if (req.user.sub !== privyUserId) {
    logDeduplicator.warn('Login attempt with invalid Privy User ID', { 
      hasTokenSub: !!req.user.sub, 
      hasProvidedSub: !!privyUserId, 
      hasName: !!name,
      path: req.path 
    });
    
    res.status(400).json({ 
      success: false,
      message: "Invalid Privy User ID",
      code: "INVALID_PRIVY_USER_ID"
    });
    return;
  }

  authService.findOrCreateUser(req.user, name, referrerName)
    .then(user => {
      logDeduplicator.info('User authenticated successfully', { 
        userId: user.id,
        userRole: user.role
      });
      
      res.status(200).json({ 
        success: true,
        message: "User authenticated successfully", 
        user 
      });
    })
    .catch(error => {
      logDeduplicator.error("Authentication error", { 
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        privyUserId, 
        name,
        path: req.path 
      });
      
      if (error instanceof UserNotFoundError) {
        res.status(error.statusCode).json({ 
          success: false,
          message: error.message,
          code: error.code
        });
        return;
      }
      
      res.status(500).json({ 
        success: false,
        message: "Internal server error",
        code: "INTERNAL_SERVER_ERROR"
      });
    });
});

// ✅ Handler pour les mauvaises méthodes sur /login (déplacé à la fin)

// Route pour récupérer les infos de l'utilisateur connecté
router.get("/me", validatePrivyToken, (req: Request, res: Response): void => {
  try {
    const privyUserId = req.user?.sub;
    
    if (!privyUserId) {
      logDeduplicator.warn('Me request without authentication', { path: req.path });
      res.status(401).json({
        success: false,
        message: 'User not authenticated',
        code: 'UNAUTHENTICATED'
      });
      return;
    }

    userRepository.findByPrivyUserId(privyUserId)
      .then(user => {
        if (!user) {
          logDeduplicator.warn('User not found in /me', { privyUserId, path: req.path });
          res.status(404).json({
            success: false,
            message: 'User not found',
            code: 'USER_NOT_FOUND'
          });
          return;
        }

        logDeduplicator.info('User info retrieved successfully', { 
          userId: user.id,
          role: user.role,
          path: req.path 
        });
        
        res.status(200).json({
          success: true,
          message: 'User info retrieved successfully',
          data: {
            user: {
              id: user.id,
              name: user.name,
              email: user.email,
              role: user.role,
              privyUserId: user.privyUserId,
              createdAt: user.createdAt,
              verified: user.verified,
              referralCount: user.referralCount,
              referredBy: user.referredBy
            }
          }
        });
      })
      .catch(error => {
        logDeduplicator.error("Error retrieving user info", { 
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
          path: req.path 
        });
        
        res.status(500).json({
          success: false,
          message: 'Internal server error',
          code: 'INTERNAL_SERVER_ERROR'
        });
      });
  } catch (error) {
    logDeduplicator.error("Unexpected error in /me", { 
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      path: req.path 
    });
    
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      code: 'INTERNAL_SERVER_ERROR'
    });
  }
});

// Route pour récupérer les informations d'un utilisateur
router.get("/user/:privyUserId", validatePrivyToken, validateUserParams, (req: Request, res: Response): void => {
  if (req.user?.sub !== req.params.privyUserId) {
    logDeduplicator.warn('Unauthorized access attempt', { 
      hasTokenSub: !!req.user?.sub, 
      hasRequestedSub: !!req.params.privyUserId,
      path: req.path 
    });
    
    res.status(403).json({ 
      success: false,
      message: "Unauthorized access",
      code: "UNAUTHORIZED_ACCESS"
    });
    return;
  }

  userRepository.findByPrivyUserId(req.params.privyUserId)
    .then(user => {
      if (!user) {
        logDeduplicator.warn('User not found in /user/:id', { privyUserId: req.params.privyUserId, path: req.path });
        res.status(404).json({
          success: false,
          message: 'User not found',
          code: 'USER_NOT_FOUND'
        });
        return;
      }

      logDeduplicator.info('User retrieved successfully', { 
        userId: user.id,
        userRole: user.role,
        path: req.path 
      });
      
      res.status(200).json({ 
        success: true,
        message: "User retrieved successfully",
        user 
      });
    })
    .catch(error => {
      logDeduplicator.error("Error retrieving user", { 
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        path: req.path 
      });
      
      if (error instanceof UserNotFoundError) {
        res.status(error.statusCode).json({ 
          success: false,
          message: error.message,
          code: error.code
        });
        return;
      }
      
      res.status(500).json({ 
        success: false,
        message: "Internal server error",
        code: "INTERNAL_SERVER_ERROR"
      });
    });
});

// Route pour récupérer les statistiques de referral
router.get("/referral/stats", validatePrivyToken, async (req: Request, res: Response) => {
  try {
    const privyUserId = req.user?.sub;
    
    if (!privyUserId) {
      logDeduplicator.warn('Referral stats request without authentication', { path: req.path });
      res.status(401).json({
        success: false,
        message: 'User not authenticated',
        code: 'UNAUTHENTICATED'
      });
      return;
    }

    const user = await userRepository.findByPrivyUserId(privyUserId);
    if (!user) {
      logDeduplicator.warn('User not found in /referral/stats', { privyUserId, path: req.path });
      res.status(404).json({
        success: false,
        message: 'User not found',
        code: 'USER_NOT_FOUND'
      });
      return;
    }
    const stats = await referralService.getReferralStats(user.id);
    
    logDeduplicator.info('Referral stats retrieved successfully', { 
      userId: user.id,
      referralCount: stats.referralCount
    });
    
    res.status(200).json({
      success: true,
      message: 'Referral stats retrieved successfully',
      data: stats
    });
  } catch (error) {
    logDeduplicator.error("Error retrieving referral stats", { 
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      path: req.path 
    });
    
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      code: 'INTERNAL_SERVER_ERROR'
    });
  }
});

// Route pour valider un name de parrain
router.get("/referral/validate/:name", validatePrivyToken, async (req: Request, res: Response) => {
  try {
    const name = String(req.params.name);
    const isValid = await referralService.validateReferrerName(name);
    
    logDeduplicator.info('Referrer validation completed', { 
      name, 
      isValid 
    });
    
    res.status(200).json({
      success: true,
      message: 'Referrer validation completed',
      data: { isValid }
    });
  } catch (error) {
    logDeduplicator.error("Error validating referrer", { 
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      path: req.path 
    });
    
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      code: 'INTERNAL_SERVER_ERROR'
    });
  }
});

// ✅ Handler pour les mauvaises méthodes sur /login (à la fin)
router.all("/login", (req: Request, res: Response): void => {
  logDeduplicator.warn('Wrong method on /auth/login', { 
    method: req.method,
    path: req.path,
    headers: req.headers 
  });
  
  res.status(405).json({ 
    success: false,
    message: `Method ${req.method} not allowed`,
    code: "METHOD_NOT_ALLOWED"
  });
});

export default router;
