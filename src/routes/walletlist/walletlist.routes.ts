import express, { Request, Response, RequestHandler } from "express";
import { WalletListService } from "../../services/walletlist/walletlist.service";
import { WalletListItemService } from "../../services/walletlist/walletlist-item.service";
import { marketRateLimiter } from '../../middleware/apiRateLimiter';
import { validatePrivyToken } from '../../middleware/authMiddleware';
import {
  validateUpdateWalletList,
  validateCreateWalletListItem,
  validateUpdateWalletListItem,
  validateWalletListQuery,
  validateWalletListItemQuery
} from '../../middleware/validation/walletlist.validation';
import { walletListCreateSchema } from '../../schemas/walletlist.schema';
import { WalletListError } from '../../errors/walletlist.errors';
import { logDeduplicator } from '../../utils/logDeduplicator';
import { prisma } from '../../core/prisma.service';
import { XP_REWARDS } from '../../constants/xp.constants';

const router = express.Router();
const walletListService = new WalletListService();
const walletListItemService = new WalletListItemService();

// Rate limiting
router.use(marketRateLimiter);

// ========== WALLET LISTS ==========

// Créer une wallet list
router.post('/', validatePrivyToken, (async (req: Request, res: Response) => {
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

    // Validation des données
    const validatedData = walletListCreateSchema.parse({ ...req.body, userId: user.id });
    
    const walletList = await walletListService.create(validatedData);
    res.status(201).json({ 
      success: true, 
      data: walletList,
      xpGranted: XP_REWARDS.CREATE_WALLETLIST
    });
  } catch (error) {
    logDeduplicator.error('Error creating wallet list:', { error: error instanceof Error ? error.message : String(error) });
    if (error instanceof WalletListError) {
      return res.status(error.statusCode).json({ success: false, error: error.message, code: error.code });
    }
    res.status(500).json({ success: false, error: 'Internal server error', code: 'INTERNAL_SERVER_ERROR' });
  }
}) as RequestHandler);

// Lister toutes les wallet lists
router.get('/', validateWalletListQuery, (async (req: Request, res: Response) => {
  try {
    // Force public-only: this route is UNAUTHENTICATED and getAll honours a
    // caller-supplied `userId`/`isPublic`, so `?userId=N` used to leak another
    // user's PRIVATE wallet lists (with names, item counts, creator). Private
    // lists are reachable only via the owner's authenticated /userlists route.
    const walletLists = await walletListService.getAll({ ...req.query, isPublic: true });
    res.json({ success: true, data: walletLists.data, pagination: walletLists.pagination });
  } catch (error) {
    logDeduplicator.error('Error fetching wallet lists:', { error: error instanceof Error ? error.message : String(error) });
    if (error instanceof WalletListError) {
      return res.status(error.statusCode).json({ success: false, error: error.message, code: error.code });
    }
    res.status(500).json({ success: false, error: 'Internal server error', code: 'INTERNAL_SERVER_ERROR' });
  }
}) as RequestHandler);

// Lister les wallet lists publiques
router.get('/public', validateWalletListQuery, (async (req: Request, res: Response) => {
  try {
    const walletLists = await walletListService.getPublicLists(req.query);
    res.json({ success: true, data: walletLists.data, pagination: walletLists.pagination });
  } catch (error) {
    logDeduplicator.error('Error fetching public wallet lists:', { error: error instanceof Error ? error.message : String(error) });
    if (error instanceof WalletListError) {
      return res.status(error.statusCode).json({ success: false, error: error.message, code: error.code });
    }
    res.status(500).json({ success: false, error: 'Internal server error', code: 'INTERNAL_SERVER_ERROR' });
  }
}) as RequestHandler);

// Récupérer les wallet lists de l'utilisateur connecté
router.get('/userlists', validatePrivyToken, validateWalletListQuery, (async (req: Request, res: Response) => {
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

    const walletLists = await walletListService.getByUser(user.id);
    res.json({ success: true, data: walletLists });
  } catch (error) {
    logDeduplicator.error('Error fetching user wallet lists:', { error: error instanceof Error ? error.message : String(error) });
    if (error instanceof WalletListError) {
      return res.status(error.statusCode).json({ success: false, error: error.message, code: error.code });
    }
    res.status(500).json({ success: false, error: 'Internal server error', code: 'INTERNAL_SERVER_ERROR' });
  }
}) as RequestHandler);

// Récupérer une wallet list par ID
router.get('/:id', (async (req: Request, res: Response) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id)) {
      return res.status(400).json({ success: false, error: 'Invalid ID format', code: 'INVALID_ID_FORMAT' });
    }

    const privyUserId = req.user?.sub;
    let walletList;

    if (privyUserId) {
      // Récupère l'utilisateur depuis la DB
      const user = await prisma.user.findUnique({ where: { privyUserId } });
      if (user) {
        walletList = await walletListService.getByIdWithPermission(id, user.id);
      } else {
        walletList = await walletListService.getById(id);
        if (!walletList.isPublic) {
          // 404, not 403: a private list must not reveal its existence to a
        // caller who is not its owner.
        return res.status(404).json({ success: false, error: 'Wallet list not found', code: 'WALLET_LIST_NOT_FOUND' });
        }
      }
    } else {
      walletList = await walletListService.getById(id);
      if (!walletList.isPublic) {
        // 404, not 403: a private list must not reveal its existence to a
        // caller who is not its owner.
        return res.status(404).json({ success: false, error: 'Wallet list not found', code: 'WALLET_LIST_NOT_FOUND' });
      }
    }

    res.json({ success: true, data: walletList });
  } catch (error) {
    logDeduplicator.error('Error fetching wallet list:', { error: error instanceof Error ? error.message : String(error), id: req.params.id });
    if (error instanceof WalletListError) {
      return res.status(error.statusCode).json({ success: false, error: error.message, code: error.code });
    }
    res.status(500).json({ success: false, error: 'Internal server error', code: 'INTERNAL_SERVER_ERROR' });
  }
}) as RequestHandler);

// Modifier une wallet list
router.put('/:id', validatePrivyToken, validateUpdateWalletList, (async (req: Request, res: Response) => {
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

    // Vérifier que l'utilisateur a accès à la wallet list
    const hasAccess = await walletListService.isOwner(id, user.id);
    if (!hasAccess) {
      return res.status(403).json({ success: false, error: 'Access denied', code: 'ACCESS_DENIED' });
    }

    const walletList = await walletListService.update(id, req.body);
    res.json({ success: true, data: walletList });
  } catch (error) {
    logDeduplicator.error('Error updating wallet list:', { error: error instanceof Error ? error.message : String(error), id: req.params.id });
    if (error instanceof WalletListError) {
      return res.status(error.statusCode).json({ success: false, error: error.message, code: error.code });
    }
    res.status(500).json({ success: false, error: 'Internal server error', code: 'INTERNAL_SERVER_ERROR' });
  }
}) as RequestHandler);

// Supprimer une wallet list
router.delete('/:id', validatePrivyToken, (async (req: Request, res: Response) => {
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

    // Vérifier que l'utilisateur a accès à la wallet list
    const hasAccess = await walletListService.isOwner(id, user.id);
    if (!hasAccess) {
      return res.status(403).json({ success: false, error: 'Access denied', code: 'ACCESS_DENIED' });
    }

    await walletListService.delete(id);
    res.json({ success: true, message: 'Wallet list deleted successfully' });
  } catch (error) {
    logDeduplicator.error('Error deleting wallet list:', { error: error instanceof Error ? error.message : String(error), id: req.params.id });
    if (error instanceof WalletListError) {
      return res.status(error.statusCode).json({ success: false, error: error.message, code: error.code });
    }
    res.status(500).json({ success: false, error: 'Internal server error', code: 'INTERNAL_SERVER_ERROR' });
  }
}) as RequestHandler);

// Copier une wallet list publique
router.post('/:id/copy', validatePrivyToken, (async (req: Request, res: Response) => {
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

    const copiedWalletList = await walletListService.copyWalletList(id, user.id);
    res.status(201).json({ success: true, data: copiedWalletList });
  } catch (error) {
    logDeduplicator.error('Error copying wallet list:', { error: error instanceof Error ? error.message : String(error), id: req.params.id });
    if (error instanceof WalletListError) {
      return res.status(error.statusCode).json({ success: false, error: error.message, code: error.code });
    }
    res.status(500).json({ success: false, error: 'Internal server error', code: 'INTERNAL_SERVER_ERROR' });
  }
}) as RequestHandler);

// ========== WALLET LIST ITEMS ==========

// Lister les items d'une wallet list
router.get('/:id/items', validatePrivyToken, validateWalletListItemQuery, (async (req: Request, res: Response) => {
  try {
    const walletListId = parseInt(String(req.params.id), 10);
    if (isNaN(walletListId)) {
      return res.status(400).json({ success: false, error: 'Invalid wallet list ID format', code: 'INVALID_ID_FORMAT' });
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

    const items = await walletListItemService.getByWalletListWithPermission(walletListId, user.id, req.query);
    res.json({ success: true, data: items.data, pagination: items.pagination });
  } catch (error) {
    logDeduplicator.error('Error fetching items by wallet list:', { error: error instanceof Error ? error.message : String(error), walletListId: req.params.id });
    if (error instanceof WalletListError) {
      return res.status(error.statusCode).json({ success: false, error: error.message, code: error.code });
    }
    res.status(500).json({ success: false, error: 'Internal server error', code: 'INTERNAL_SERVER_ERROR' });
  }
}) as RequestHandler);

// Ajouter un wallet à une liste
router.post('/:id/items', validatePrivyToken, validateCreateWalletListItem, (async (req: Request, res: Response) => {
  try {
    const walletListId = parseInt(String(req.params.id), 10);
    if (isNaN(walletListId)) {
      return res.status(400).json({ success: false, error: 'Invalid wallet list ID format', code: 'INVALID_ID_FORMAT' });
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

    // Vérifier que l'utilisateur a accès à la wallet list
    const hasAccess = await walletListService.isOwner(walletListId, user.id);
    if (!hasAccess) {
      return res.status(403).json({ success: false, error: 'Access denied', code: 'ACCESS_DENIED' });
    }

    // The userWallet being added MUST belong to the caller. Without this, any
    // authenticated user could pass an arbitrary userWalletId and read back the
    // owner's email + wallet address from the enriched response (IDOR → PII).
    const userWalletId = Number(req.body.userWalletId);
    const userWallet = Number.isInteger(userWalletId)
      ? await prisma.userWallet.findUnique({ where: { id: userWalletId }, select: { userId: true } })
      : null;
    if (!userWallet || userWallet.userId !== user.id) {
      return res.status(403).json({ success: false, error: 'Access denied', code: 'ACCESS_DENIED' });
    }

    const item = await walletListItemService.create({
      ...req.body,
      walletListId
    });

    res.status(201).json({ 
      success: true, 
      data: item,
      xpGranted: XP_REWARDS.ADD_WALLET_TO_LIST
    });
  } catch (error) {
    logDeduplicator.error('Error adding wallet to list:', { error: error instanceof Error ? error.message : String(error), walletListId: req.params.id });
    if (error instanceof WalletListError) {
      return res.status(error.statusCode).json({ success: false, error: error.message, code: error.code });
    }
    res.status(500).json({ success: false, error: 'Internal server error', code: 'INTERNAL_SERVER_ERROR' });
  }
}) as RequestHandler);

// Modifier un item
router.put('/items/:itemId', validatePrivyToken, validateUpdateWalletListItem, (async (req: Request, res: Response) => {
  try {
    const itemId = parseInt(String(req.params.itemId), 10);
    if (isNaN(itemId)) {
      return res.status(400).json({ success: false, error: 'Invalid item ID format', code: 'INVALID_ID_FORMAT' });
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

    // Récupérer l'item pour vérifier les permissions
    const existingItem = await walletListItemService.getById(itemId);
    const hasAccess = await walletListService.isOwner(existingItem.walletListId, user.id);
    if (!hasAccess) {
      return res.status(403).json({ success: false, error: 'Access denied', code: 'ACCESS_DENIED' });
    }

    const item = await walletListItemService.update(itemId, req.body);
    res.json({ success: true, data: item });
  } catch (error) {
    logDeduplicator.error('Error updating wallet list item:', { error: error instanceof Error ? error.message : String(error), itemId: req.params.itemId });
    if (error instanceof WalletListError) {
      return res.status(error.statusCode).json({ success: false, error: error.message, code: error.code });
    }
    res.status(500).json({ success: false, error: 'Internal server error', code: 'INTERNAL_SERVER_ERROR' });
  }
}) as RequestHandler);

// Supprimer un wallet d'une liste
router.delete('/items/:itemId', validatePrivyToken, (async (req: Request, res: Response) => {
  try {
    const itemId = parseInt(String(req.params.itemId), 10);
    if (isNaN(itemId)) {
      return res.status(400).json({ success: false, error: 'Invalid item ID format', code: 'INVALID_ID_FORMAT' });
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

    // Récupérer l'item pour vérifier les permissions
    const existingItem = await walletListItemService.getById(itemId);
    const hasAccess = await walletListService.isOwner(existingItem.walletListId, user.id);
    if (!hasAccess) {
      return res.status(403).json({ success: false, error: 'Access denied', code: 'ACCESS_DENIED' });
    }

    await walletListItemService.delete(itemId);
    res.json({ success: true, message: 'Wallet removed from list successfully' });
  } catch (error) {
    logDeduplicator.error('Error removing wallet from list:', { error: error instanceof Error ? error.message : String(error), itemId: req.params.itemId });
    if (error instanceof WalletListError) {
      return res.status(error.statusCode).json({ success: false, error: error.message, code: error.code });
    }
    res.status(500).json({ success: false, error: 'Internal server error', code: 'INTERNAL_SERVER_ERROR' });
  }
}) as RequestHandler);

export default router;
