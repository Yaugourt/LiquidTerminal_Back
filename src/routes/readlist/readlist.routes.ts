import express, { Request, Response, RequestHandler } from "express";
import { ReadListService } from "../../services/readlist/readlist.service";
import { ReadListItemService } from "../../services/readlist/readlist-item.service";
import { marketRateLimiter } from '../../middleware/apiRateLimiter';
import { validatePrivyToken } from '../../middleware/authMiddleware';
import {
  validateUpdateReadList,
  validateCreateReadListItem,
  validateUpdateReadListItem,
  validateReadListQuery,
  validateReadListItemQuery
} from '../../middleware/validation/readlist.validation';
import { readListCreateSchema } from '../../schemas/readlist.schema';
import { ReadListError } from '../../errors/readlist.errors';
import { logDeduplicator } from '../../utils/logDeduplicator';
import { prisma } from '../../core/prisma.service';
import { XP_REWARDS } from '../../constants/xp.constants';

const router = express.Router();
const readListService = new ReadListService();
const readListItemService = new ReadListItemService();

// Rate limiting
router.use(marketRateLimiter);

// ========== READ LISTS ==========

// Créer une read list
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

    // Valider après avoir ajouté le userId
    const dataWithUserId = { ...req.body, userId: user.id };
    readListCreateSchema.parse(dataWithUserId);

    const readList = await readListService.create(dataWithUserId);
    res.status(201).json({ 
      success: true, 
      message: 'Read list created successfully', 
      data: readList,
      xpGranted: XP_REWARDS.CREATE_READLIST
    });
  } catch (error) {
    logDeduplicator.error('Error creating read list:', { error, body: req.body });
    if (error instanceof ReadListError) {
      return res.status(error.statusCode).json({ success: false, error: error.message, code: error.code });
    }
    res.status(500).json({ success: false, error: 'Internal server error', code: 'INTERNAL_SERVER_ERROR' });
  }
}) as RequestHandler);

// Lister toutes les read lists
router.get('/', validateReadListQuery, (async (req: Request, res: Response) => {
  try {
    const readLists = await readListService.getAll(req.query);
    res.json({ success: true, data: readLists.data, pagination: readLists.pagination });
  } catch (error) {
    logDeduplicator.error('Error fetching read lists:', { error });
    if (error instanceof ReadListError) {
      return res.status(error.statusCode).json({ success: false, error: error.message, code: error.code });
    }
    res.status(500).json({ success: false, error: 'Internal server error', code: 'INTERNAL_SERVER_ERROR' });
  }
}) as RequestHandler);

// Lister les read lists publiques
router.get('/public', (async (req: Request, res: Response) => {
  try {
    const publicLists = await readListService.getPublicLists(req.query);
    res.json({ success: true, data: publicLists.data, pagination: publicLists.pagination });
  } catch (error) {
    logDeduplicator.error('Error fetching public read lists:', { error });
    if (error instanceof ReadListError) {
      return res.status(error.statusCode).json({ success: false, error: error.message, code: error.code });
    }
    res.status(500).json({ success: false, error: 'Internal server error', code: 'INTERNAL_SERVER_ERROR' });
  }
}) as RequestHandler);

// Mes read lists
router.get('/my-lists', validatePrivyToken, (async (req: Request, res: Response) => {
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

    const readLists = await readListService.getByUser(user.id);
    res.json({ success: true, data: readLists });
  } catch (error) {
    logDeduplicator.error('Error fetching user read lists:', { error, privyUserId: req.user?.sub });
    if (error instanceof ReadListError) {
      return res.status(error.statusCode).json({ success: false, error: error.message, code: error.code });
    }
    res.status(500).json({ success: false, error: 'Internal server error', code: 'INTERNAL_SERVER_ERROR' });
  }
}) as RequestHandler);

// Récupérer une read list par ID
router.get('/:id', (async (req: Request, res: Response) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id)) {
      return res.status(400).json({ success: false, error: 'Invalid ID format', code: 'INVALID_ID_FORMAT' });
    }

    const privyUserId = req.user?.sub;
    let readList;

    if (privyUserId) {
      // Récupère l'utilisateur depuis la DB
      const user = await prisma.user.findUnique({ where: { privyUserId } });
      if (user) {
        readList = await readListService.getByIdWithPermission(id, user.id);
      } else {
        readList = await readListService.getById(id);
        if (!readList.isPublic) {
          return res.status(403).json({ success: false, error: 'Access denied to private read list', code: 'ACCESS_DENIED' });
        }
      }
    } else {
      readList = await readListService.getById(id);
      if (!readList.isPublic) {
        return res.status(403).json({ success: false, error: 'Access denied to private read list', code: 'ACCESS_DENIED' });
      }
    }

    res.json({ success: true, data: readList });
  } catch (error) {
    logDeduplicator.error('Error fetching read list:', { error, id: req.params.id });
    if (error instanceof ReadListError) {
      return res.status(error.statusCode).json({ success: false, error: error.message, code: error.code });
    }
    res.status(500).json({ success: false, error: 'Internal server error', code: 'INTERNAL_SERVER_ERROR' });
  }
}) as RequestHandler);

// Modifier une read list
router.put('/:id', validatePrivyToken, validateUpdateReadList, (async (req: Request, res: Response) => {
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

    await readListService.getByIdWithPermission(id, user.id);
    const readList = await readListService.update(id, req.body);
    res.json({ success: true, message: 'Read list updated successfully', data: readList });
  } catch (error) {
    logDeduplicator.error('Error updating read list:', { error, id: req.params.id, body: req.body });
    if (error instanceof ReadListError) {
      return res.status(error.statusCode).json({ success: false, error: error.message, code: error.code });
    }
    res.status(500).json({ success: false, error: 'Internal server error', code: 'INTERNAL_SERVER_ERROR' });
  }
}) as RequestHandler);

// Supprimer une read list
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

    await readListService.getByIdWithPermission(id, user.id);
    await readListService.delete(id);
    res.json({ success: true, message: 'Read list deleted successfully' });
  } catch (error) {
    logDeduplicator.error('Error deleting read list:', { error, id: req.params.id });
    if (error instanceof ReadListError) {
      return res.status(error.statusCode).json({ success: false, error: error.message, code: error.code });
    }
    res.status(500).json({ success: false, error: 'Internal server error', code: 'INTERNAL_SERVER_ERROR' });
  }
}) as RequestHandler);

// ========== READ LIST ITEMS ==========

// Ajouter un item à une read list
router.post('/:id/items', validatePrivyToken, validateCreateReadListItem, (async (req: Request, res: Response) => {
  try {
    const readListId = parseInt(String(req.params.id), 10);
    if (isNaN(readListId)) {
      return res.status(400).json({ success: false, error: 'Invalid read list ID format', code: 'INVALID_ID_FORMAT' });
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

    const itemData = { ...req.body, readListId };
    const item = await readListItemService.addResourceToReadList(itemData, user.id);
    res.status(201).json({ success: true, message: 'Resource added to read list successfully', data: item });
  } catch (error) {
    logDeduplicator.error('Error adding resource to read list:', { error, body: req.body });
    if (error instanceof ReadListError) {
      return res.status(error.statusCode).json({ success: false, error: error.message, code: error.code });
    }
    res.status(500).json({ success: false, error: 'Internal server error', code: 'INTERNAL_SERVER_ERROR' });
  }
}) as RequestHandler);

// Lister les items d'une read list
router.get('/:id/items', validatePrivyToken, validateReadListItemQuery, (async (req: Request, res: Response) => {
  try {
    const readListId = parseInt(String(req.params.id), 10);
    if (isNaN(readListId)) {
      return res.status(400).json({ success: false, error: 'Invalid read list ID format', code: 'INVALID_ID_FORMAT' });
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

    const items = await readListItemService.getByReadListWithPermission(readListId, user.id, req.query);
    res.json({ success: true, data: items.data, pagination: items.pagination });
  } catch (error) {
    logDeduplicator.error('Error fetching items by read list:', { error, readListId: req.params.id });
    if (error instanceof ReadListError) {
      return res.status(error.statusCode).json({ success: false, error: error.message, code: error.code });
    }
    res.status(500).json({ success: false, error: 'Internal server error', code: 'INTERNAL_SERVER_ERROR' });
  }
}) as RequestHandler);

// Modifier un item
router.put('/items/:itemId', validatePrivyToken, validateUpdateReadListItem, (async (req: Request, res: Response) => {
  try {
    const itemId = parseInt(String(req.params.itemId), 10);
    if (isNaN(itemId)) {
      return res.status(400).json({ success: false, error: 'Invalid item ID format', code: 'INVALID_ID_FORMAT' });
    }

    const item = await readListItemService.update(itemId, req.body);
    res.json({ success: true, message: 'Read list item updated successfully', data: item });
  } catch (error) {
    logDeduplicator.error('Error updating read list item:', { error, id: req.params.itemId, body: req.body });
    if (error instanceof ReadListError) {
      return res.status(error.statusCode).json({ success: false, error: error.message, code: error.code });
    }
    res.status(500).json({ success: false, error: 'Internal server error', code: 'INTERNAL_SERVER_ERROR' });
  }
}) as RequestHandler);

// Supprimer un item
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

    await readListItemService.deleteWithPermission(itemId, user.id);
    res.json({ success: true, message: 'Read list item deleted successfully' });
  } catch (error) {
    logDeduplicator.error('Error deleting read list item:', { error, id: req.params.itemId });
    if (error instanceof ReadListError) {
      return res.status(error.statusCode).json({ success: false, error: error.message, code: error.code });
    }
    res.status(500).json({ success: false, error: 'Internal server error', code: 'INTERNAL_SERVER_ERROR' });
  }
}) as RequestHandler);

// Marquer un item comme lu/non lu
router.patch('/items/:itemId/read-status', validatePrivyToken, (async (req: Request, res: Response) => {
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

    const { isRead } = req.body;
    if (typeof isRead !== 'boolean') {
      return res.status(400).json({ success: false, error: 'isRead must be a boolean', code: 'INVALID_READ_STATUS' });
    }

    const { item, xpGranted } = await readListItemService.toggleReadStatus(itemId, user.id, isRead);
    res.json({ 
      success: true, 
      message: `Item marked as ${isRead ? 'read' : 'unread'}`, 
      data: item,
      xpGranted
    });
  } catch (error) {
    logDeduplicator.error('Error toggling read status:', { error, id: req.params.itemId, body: req.body });
    if (error instanceof ReadListError) {
      return res.status(error.statusCode).json({ success: false, error: error.message, code: error.code });
    }
    res.status(500).json({ success: false, error: 'Internal server error', code: 'INTERNAL_SERVER_ERROR' });
  }
}) as RequestHandler);

// Copier une read list publique
router.post('/copy/:id', validatePrivyToken, (async (req: Request, res: Response) => {
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

    // Copier la read list
    const copiedReadList = await readListService.copyReadList(id, user.id);
    
    res.json({ 
      success: true, 
      data: copiedReadList,
      message: 'Read list copied successfully',
      xpGranted: XP_REWARDS.COPY_PUBLIC_READLIST + XP_REWARDS.CREATE_READLIST // Copie + création
    });
  } catch (error) {
    logDeduplicator.error('Error copying read list:', { error, id: req.params.id, privyUserId: req.user?.sub });
    if (error instanceof ReadListError) {
      return res.status(error.statusCode).json({ success: false, error: error.message, code: error.code });
    }
    res.status(500).json({ success: false, error: 'Internal server error', code: 'INTERNAL_SERVER_ERROR' });
  }
}) as RequestHandler);

export default router; 