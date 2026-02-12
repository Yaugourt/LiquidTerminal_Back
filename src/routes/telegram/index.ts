import express from 'express';
import telegramRoutes from './telegram.routes';

const router = express.Router();

// Mount telegram bot routes
router.use('/', telegramRoutes);

export default router;
