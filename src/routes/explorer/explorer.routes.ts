import express from 'express';
import { HypurrscanFeedsService } from '../../services/hypurrscan/hypurrscanFeeds.service';
import { marketRateLimiter } from '../../middleware/apiRateLimiter';
import { hypurrscanFeedHandler } from '../hypurrscanFeed.handler';

const router = express.Router();
const feeds = HypurrscanFeedsService.getInstance();

router.use(marketRateLimiter);

/** GET /explorer/deploys — the latest spot deploy actions (Hypurrscan /deploys). */
router.get('/deploys', hypurrscanFeedHandler(() => feeds.getDeploys()));

/** GET /explorer/aliases — address → label (Hypurrscan /globalAliases). */
router.get('/aliases', hypurrscanFeedHandler(() => feeds.getGlobalAliases()));

export default router;
