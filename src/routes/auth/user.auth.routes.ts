import { Router, Request, Response } from "express";
import { validatePrivyToken } from "../../middleware/authMiddleware";
import { validateAdminUserUpdate } from "../../middleware/validation/authValidation.middleware";
import { marketRateLimiter } from "../../middleware/apiRateLimiter";
import { logDeduplicator } from "../../utils/logDeduplicator";
import { requireAdmin } from "../../middleware/roleMiddleware";
import { UserService } from "../../services/auth/user.service";

const router = Router();
const userService = UserService.getInstance();

// Appliquer le rate limiting
router.use(marketRateLimiter);

// Route admin pour récupérer tous les utilisateurs
router.get("/admin/users", validatePrivyToken, requireAdmin, (req: Request, res: Response): void => {
  const page = parseInt(req.query.page as string) || 1;
  const limit = parseInt(req.query.limit as string) || 20;
  const search = req.query.search as string;
  const verified = req.query.verified === 'true' ? true : req.query.verified === 'false' ? false : undefined;

  userService.getUsers({ page, limit, search, verified })
    .then(result => {
      logDeduplicator.info('Admin retrieved users list', { 
        adminId: req.currentUser?.id,
        page,
        limit,
        total: result.total,
        hasSearch: !!search,
        hasVerifiedFilter: verified !== undefined
      });
      
      res.status(200).json({
        success: true,
        message: 'Users retrieved successfully',
        data: {
          users: result.users,
          pagination: {
            page,
            limit,
            total: result.total,
            totalPages: result.pages,
            hasNext: page < result.pages,
            hasPrevious: page > 1
          }
        }
      });
    })
    .catch(error => {
      logDeduplicator.error("Error retrieving users list", { 
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        adminId: req.currentUser?.id
      });
      
      res.status(500).json({
        success: false,
        message: 'Internal server error',
        code: 'INTERNAL_SERVER_ERROR'
      });
    });
});

// Route admin pour récupérer un utilisateur spécifique
router.get("/admin/users/:userId", validatePrivyToken, requireAdmin, (req: Request, res: Response): void => {
  const userId = parseInt(String(req.params.userId));

  if (!userId || isNaN(userId)) {
    res.status(400).json({
      success: false,
      message: 'Invalid user ID',
      code: 'INVALID_USER_ID'
    });
    return;
  }

  userService.getUserById(userId)
    .then(user => {
      if (!user) {
        logDeduplicator.warn('Admin tried to get non-existent user', { 
          adminId: req.currentUser?.id,
          targetUserId: userId
        });
        
        res.status(404).json({
          success: false,
          message: 'User not found',
          code: 'USER_NOT_FOUND'
        });
        return;
      }
      
      logDeduplicator.info('Admin retrieved user details', { 
        adminId: req.currentUser?.id,
        targetUserId: userId,
        userRole: user.role
      });
      
      res.status(200).json({
        success: true,
        message: 'User retrieved successfully',
        data: { user }
      });
    })
    .catch(error => {
      logDeduplicator.error("Error retrieving user details", { 
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        adminId: req.currentUser?.id,
        targetUserId: userId
      });
      
      res.status(500).json({
        success: false,
        message: 'Internal server error',
        code: 'INTERNAL_SERVER_ERROR'
      });
    });
});

// Route admin pour modifier un utilisateur
router.put("/admin/users/:userId", validatePrivyToken, requireAdmin, validateAdminUserUpdate, (req: Request, res: Response): void => {
  const userId = parseInt(String(req.params.userId));

  if (!userId || isNaN(userId)) {
    res.status(400).json({
      success: false,
      message: 'Invalid user ID',
      code: 'INVALID_USER_ID'
    });
    return;
  }

  userService.updateUser(userId, req.body)
    .then(updatedUser => {
      logDeduplicator.info('Admin updated user', { 
        adminId: req.currentUser?.id,
        targetUserId: userId,
        updatedFields: Object.keys(req.body),
        hasVerifiedUpdate: 'verified' in req.body
      });
      
      res.status(200).json({
        success: true,
        message: 'User updated successfully',
        data: { user: updatedUser }
      });
    })
    .catch(error => {
      if (error.message === 'Email already exists') {
        logDeduplicator.warn('Admin tried to update user with duplicate email', { 
          adminId: req.currentUser?.id,
          targetUserId: userId,
          email: req.body.email
        });
        
        res.status(409).json({
          success: false,
          message: 'Email already exists',
          code: 'EMAIL_ALREADY_EXISTS'
        });
        return;
      }

      logDeduplicator.error("Error updating user", { 
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        adminId: req.currentUser?.id,
        targetUserId: userId
      });
      
      res.status(500).json({
        success: false,
        message: 'Internal server error',
        code: 'INTERNAL_SERVER_ERROR'
      });
    });
});

// Route admin pour supprimer un utilisateur
router.delete("/admin/users/:userId", validatePrivyToken, requireAdmin, (req: Request, res: Response): void => {
  const userId = parseInt(String(req.params.userId));

  if (!userId || isNaN(userId)) {
    res.status(400).json({
      success: false,
      message: 'Invalid user ID',
      code: 'INVALID_USER_ID'
    });
    return;
  }

  // Empêcher l'admin de se supprimer lui-même
  if (!userService.canDeleteUser(userId, req.currentUser?.id || 0)) {
    logDeduplicator.warn('Admin tried to delete themselves', { 
      adminId: req.currentUser?.id
    });
    
    res.status(400).json({
      success: false,
      message: 'Cannot delete your own account',
      code: 'CANNOT_DELETE_SELF'
    });
    return;
  }

  userService.deleteUser(userId)
    .then(deletedUser => {
      logDeduplicator.info('Admin deleted user', { 
        adminId: req.currentUser?.id,
        targetUserId: userId,
        deletedUserRole: deletedUser.role
      });
      
      res.status(200).json({
        success: true,
        message: 'User deleted successfully',
        data: { user: deletedUser }
      });
    })
    .catch(error => {
      logDeduplicator.error("Error deleting user", { 
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        adminId: req.currentUser?.id,
        targetUserId: userId
      });
      
      res.status(500).json({
        success: false,
        message: 'Internal server error',
        code: 'INTERNAL_SERVER_ERROR'
      });
    });
});

export default router; 