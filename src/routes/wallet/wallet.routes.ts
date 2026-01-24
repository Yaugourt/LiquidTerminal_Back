import express, { Request, Response, RequestHandler } from "express";
import { WalletService } from "../../services/wallet/wallet.service";
import { WalletListService } from "../../services/walletlist/walletlist.service";
import { WalletListItemService } from "../../services/walletlist/walletlist-item.service";
import { marketRateLimiter } from "../../middleware/apiRateLimiter";
import { validatePrivyToken } from "../../middleware/authMiddleware";
import { 
  WalletAlreadyExistsError, 
  UserNotFoundError,
  WalletError
} from "../../errors/wallet.errors";
import { WalletListError } from "../../errors/walletlist.errors";
import {
  validateCreateWallet,
  validateUpdateWallet,
  validateWalletQuery,
  validateBulkAddWallet,
  validateBulkDeleteWallet
} from "../../middleware/validation/wallet.validation";
import { logDeduplicator } from "../../utils/logDeduplicator";
import { prisma } from "../../core/prisma.service";

const router = express.Router();
const walletService = new WalletService();
const walletListService = new WalletListService();
const walletListItemService = new WalletListItemService();

// Rate limiting
router.use(marketRateLimiter);

// ========== WALLET ROUTES ==========

// Bulk import de wallets
router.post("/bulk-add", validatePrivyToken, validateBulkAddWallet, (async (req: Request, res: Response) => {
  try {
    const privyUserId = req.user?.sub;
    if (!privyUserId) {
      return res.status(401).json({ 
        success: false, 
        error: 'User not authenticated', 
        code: 'UNAUTHENTICATED' 
      });
    }

    const { wallets, walletListId } = req.body;

    logDeduplicator.info('Bulk wallet import request', { 
      privyUserId,
      walletsCount: wallets.length,
      walletListId 
    });

    const result = await walletService.bulkAddWallets(privyUserId, wallets, walletListId);

    logDeduplicator.info('Bulk wallet import completed', { 
      privyUserId,
      result 
    });

    res.status(200).json({
      success: true,
      data: result
    });
  } catch (error) {
    logDeduplicator.error('Error in bulk wallet import:', { 
      error, 
      body: req.body 
    });

    if (error instanceof WalletAlreadyExistsError ||
        error instanceof UserNotFoundError ||
        error instanceof WalletError) {
      return res.status((error as any).statusCode || 400).json({
        success: false,
        error: (error as any).message,
        code: (error as any).code
      });
    }

    res.status(500).json({
      success: false,
      error: "Erreur interne du serveur",
      code: "INTERNAL_SERVER_ERROR"
    });
  }
}) as RequestHandler);

// Bulk delete de wallets
router.post("/bulk-delete", validatePrivyToken, validateBulkDeleteWallet, (async (req: Request, res: Response) => {
  try {
    const privyUserId = req.user?.sub;
    if (!privyUserId) {
      return res.status(401).json({ 
        success: false, 
        error: 'User not authenticated', 
        code: 'UNAUTHENTICATED' 
      });
    }

    const { walletIds } = req.body;

    logDeduplicator.info('Bulk wallet delete request', { 
      privyUserId,
      walletsCount: walletIds.length
    });

    const result = await walletService.bulkDeleteWallets(privyUserId, walletIds);

    logDeduplicator.info('Bulk wallet delete completed', { 
      privyUserId,
      result 
    });

    res.status(200).json({
      success: true,
      data: result
    });
  } catch (error) {
    logDeduplicator.error('Error in bulk wallet delete:', { 
      error, 
      body: req.body 
    });

    if (error instanceof UserNotFoundError ||
        error instanceof WalletError) {
      return res.status((error as any).statusCode || 400).json({
        success: false,
        error: (error as any).message,
        code: (error as any).code
      });
    }

    res.status(500).json({
      success: false,
      error: "Erreur interne du serveur",
      code: "INTERNAL_SERVER_ERROR"
    });
  }
}) as RequestHandler);

// Créer un wallet
router.post("/", validatePrivyToken, validateCreateWallet, (async (req: Request, res: Response) => {
  try {
    const privyUserId = req.user?.sub;
    if (!privyUserId) {
      return res.status(401).json({ success: false, error: 'User not authenticated', code: 'UNAUTHENTICATED' });
    }

    // Récupère l'utilisateur depuis la DB
    const user = await prisma.user.findUnique({ where: { privyUserId } });
    if (!user) {
      return res.status(401).json({ success: false, error: 'User not found', code: 'USER_NOT_FOUND' });
    }

    const { address, name, walletListId } = req.body;

    const userWallet = await walletService.addWallet(privyUserId, address, name);
    
    if (!userWallet || !userWallet.Wallet) {
      logDeduplicator.error('Invalid userWallet structure', { userWallet });
      return res.status(500).json({ 
        success: false,
        error: "Structure de réponse invalide",
        code: "INVALID_RESPONSE_STRUCTURE"
      });
    }

    // Si un walletListId est fourni, ajouter le wallet à la liste
    let walletListItem = null;
    if (walletListId) {
      try {
        // Vérifier que l'utilisateur a accès à la wallet list
        const hasAccess = await walletListService.hasAccess(walletListId, user.id);
        if (!hasAccess) {
          logDeduplicator.warn('User attempted to add wallet to inaccessible list', {
            userId: user.id,
            walletListId,
            userWalletId: userWallet.id
          });
          return res.status(403).json({
            success: false,
            error: "Accès refusé à cette liste de wallets",
            code: "ACCESS_DENIED"
          });
        }

        // Ajouter le wallet à la liste
        walletListItem = await walletListItemService.create({
          userWalletId: userWallet.id,
          walletListId: walletListId
        });

        logDeduplicator.info('Wallet added to list successfully', {
          userWalletId: userWallet.id,
          walletListId,
          itemId: walletListItem.id
        });
      } catch (error) {
        logDeduplicator.error('Error adding wallet to list:', { 
          error, 
          userWalletId: userWallet.id, 
          walletListId 
        });
        
        // Si l'erreur vient de la wallet list, on retourne une erreur spécifique
        if (error instanceof WalletListError) {
          return res.status(error.statusCode).json({
            success: false,
            error: error.message,
            code: error.code
          });
        }
        
        // Pour les autres erreurs, on log mais on continue (le wallet a été créé avec succès)
        logDeduplicator.warn('Wallet created but failed to add to list', {
          userWalletId: userWallet.id,
          walletListId,
          error: error
        });
      }
    }
    
    logDeduplicator.info('Wallet added successfully', { 
      address: userWallet.Wallet.address,
      userId: userWallet.userId,
      walletId: userWallet.walletId,
      name: userWallet.name,
      addedToList: !!walletListItem
    });
    
    res.status(201).json({ 
      success: true,
      message: walletListItem 
        ? "Wallet ajouté avec succès et ajouté à la liste." 
        : "Wallet ajouté avec succès.", 
      data: {
        userWallet,
        walletListItem
      }
    });
  } catch (error) {
    logDeduplicator.error('Error adding wallet:', { error, body: req.body });
    
    if (error instanceof WalletAlreadyExistsError ||
        error instanceof UserNotFoundError) {
      return res.status((error as any).statusCode).json({
        success: false,
        error: (error as any).message,
        code: (error as any).code
      });
    }

    res.status(500).json({ 
      success: false,
      error: "Erreur interne du serveur.",
      code: "INTERNAL_SERVER_ERROR"
    });
  }
}) as RequestHandler);

// Lister mes wallets
router.get("/my-wallets", validatePrivyToken, (async (req: Request, res: Response) => {
  try {
    const privyUserId = req.user?.sub;
    if (!privyUserId) {
      return res.status(401).json({ success: false, error: 'User not authenticated', code: 'UNAUTHENTICATED' });
    }

    // Récupère l'utilisateur depuis la DB
    const user = await prisma.user.findUnique({ where: { privyUserId } });
    if (!user) {
      return res.status(401).json({ success: false, error: 'User not found', code: 'USER_NOT_FOUND' });
    }

    logDeduplicator.info('Fetching wallets for user', { userId: user.id });

    const wallets = await walletService.getWalletsByUser(user.id);
    logDeduplicator.info('Wallets retrieved successfully', { 
      userId: user.id,
      count: wallets.data.length,
      total: wallets.pagination.total
    });

    res.json({
      success: true,
      data: wallets.data,
      pagination: wallets.pagination
    });
  } catch (error) {
    logDeduplicator.error('Error retrieving wallets:', { error, privyUserId: req.user?.sub });

    if (error instanceof WalletError) {
      return res.status(error.statusCode).json({
        success: false,
        error: error.message,
        code: error.code
      });
    }

    res.status(500).json({ 
      success: false,
      error: "Erreur interne du serveur",
      code: "INTERNAL_SERVER_ERROR"
    });
  }
}) as RequestHandler);

// Lister tous les wallets (avec filtres)
router.get("/", validateWalletQuery, (async (req: Request, res: Response) => {
  try {
    const wallets = await walletService.getAll(req.query);
    res.json({
      success: true,
      data: wallets.data,
      pagination: wallets.pagination
    });
  } catch (error) {
    logDeduplicator.error('Error fetching all wallets:', { error });

    if (error instanceof WalletError) {
      return res.status(error.statusCode).json({
        success: false,
        error: error.message,
        code: error.code
      });
    }

    res.status(500).json({ 
      success: false,
      error: "Erreur interne du serveur",
      code: "INTERNAL_SERVER_ERROR"
    });
  }
}) as RequestHandler);

// Récupérer un wallet par ID
router.get("/:id", (async (req: Request, res: Response) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id)) {
      return res.status(400).json({ success: false, error: 'Invalid ID format', code: 'INVALID_ID_FORMAT' });
    }

    const wallet = await walletService.getById(id);
    res.json({
      success: true,
      data: wallet
    });
  } catch (error) {
    logDeduplicator.error('Error fetching wallet:', { error, id: req.params.id });

    if (error instanceof WalletError) {
      return res.status(error.statusCode).json({
        success: false,
        error: error.message,
        code: error.code
      });
    }

    res.status(500).json({ 
      success: false,
      error: "Erreur interne du serveur",
      code: "INTERNAL_SERVER_ERROR"
    });
  }
}) as RequestHandler);

// Modifier un wallet
router.put("/:id", validatePrivyToken, validateUpdateWallet, (async (req: Request, res: Response) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id)) {
      return res.status(400).json({ success: false, error: 'Invalid ID format', code: 'INVALID_ID_FORMAT' });
    }

    const privyUserId = req.user?.sub;
    if (!privyUserId) {
      return res.status(401).json({ success: false, error: 'User not authenticated', code: 'UNAUTHENTICATED' });
    }

    // Récupère l'utilisateur depuis la DB
    const user = await prisma.user.findUnique({ where: { privyUserId } });
    if (!user) {
      return res.status(401).json({ success: false, error: 'User not found', code: 'USER_NOT_FOUND' });
    }

    const { name } = req.body;

    const updatedWallet = await walletService.updateWalletName(user.id, id, name);

    logDeduplicator.info('Wallet updated successfully', {
      userId: user.id,
      walletId: id,
      name
    });

    res.json({
      success: true,
      message: "Wallet modifié avec succès.",
      data: updatedWallet
    });
  } catch (error) {
    logDeduplicator.error('Error updating wallet:', { error, id: req.params.id, body: req.body });

    if (error instanceof WalletError) {
      return res.status(error.statusCode).json({
        success: false,
        error: error.message,
        code: error.code
      });
    }

    res.status(500).json({ 
      success: false,
      error: "Erreur interne du serveur",
      code: "INTERNAL_SERVER_ERROR"
    });
  }
}) as RequestHandler);

// Supprimer un wallet
router.delete("/:id", validatePrivyToken, (async (req: Request, res: Response) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id)) {
      return res.status(400).json({ success: false, error: 'Invalid ID format', code: 'INVALID_ID_FORMAT' });
    }

    const privyUserId = req.user?.sub;
    if (!privyUserId) {
      return res.status(401).json({ success: false, error: 'User not authenticated', code: 'UNAUTHENTICATED' });
    }

    // Récupère l'utilisateur depuis la DB
    const user = await prisma.user.findUnique({ where: { privyUserId } });
    if (!user) {
      return res.status(401).json({ success: false, error: 'User not found', code: 'USER_NOT_FOUND' });
    }
    
    logDeduplicator.info('Removing wallet', { userId: user.id, walletId: id });
    
    await walletService.removeWalletFromUser(id, user.id);
    
    logDeduplicator.info('Wallet removed successfully', { userId: user.id, walletId: id });
    
    res.json({ 
      success: true,
      message: "Wallet supprimé avec succès."
    });
  } catch (error) {
    logDeduplicator.error('Error removing wallet:', { error, id: req.params.id });
    
    if (error instanceof WalletError) {
      return res.status(error.statusCode).json({
        success: false,
        error: error.message,
        code: error.code
      });
    }
    
    res.status(500).json({ 
      success: false,
      error: "Erreur interne du serveur",
      code: "INTERNAL_SERVER_ERROR"
    });
  }
}) as RequestHandler);

export default router;

