import { Router } from 'express';
import fillsRoutes from './fills.routes';
import usersRoutes from './users.routes';
import overviewRoutes from './overview.routes';
import analyticsRoutes from './analytics.routes';
import buildersIndexerRoutes from './builders-indexer.routes';
import completedTradesRoutes from './completed-trades.routes';
import evmRoutes from './evm.routes';
import fundingRoutes from './funding.routes';
import hip3Routes from './hip3.routes';
import hip4Routes from './hip4.routes';
import spotIndexerRoutes from './spot-indexer.routes';
import twapsRoutes from './twaps.routes';
import vaultsIndexerRoutes from './vaults-indexer.routes';

const router = Router();

router.use('/fills', fillsRoutes);
router.use('/users', usersRoutes);
router.use('/overview', overviewRoutes);
router.use('/analytics', analyticsRoutes);
router.use('/builders', buildersIndexerRoutes);
router.use('/completed-trades', completedTradesRoutes);
router.use('/evm', evmRoutes);
router.use('/funding', fundingRoutes);
router.use('/hip3', hip3Routes);
router.use('/hip4', hip4Routes);
router.use('/spot', spotIndexerRoutes);
router.use('/twaps', twapsRoutes);
router.use('/vaults', vaultsIndexerRoutes);

export default router;
