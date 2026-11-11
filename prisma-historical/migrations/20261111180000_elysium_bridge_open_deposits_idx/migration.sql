-- The deposits still waiting for their retryable ticket (a handful at any time: a ticket is
-- redeemed or expires within 7 days). The bridge stream reads each of them again by its hash
-- once the live windows no longer cover it; without this index that was a scan of 10 days of
-- deposits on every sweep.
CREATE INDEX "elysium_bridge_transfer_open_deposit_idx" ON "elysium_bridge_transfer"("initiated_at")
  WHERE "direction" = 'deposit' AND "status" IN ('initiated', 'ticket_created', 'redeem_failed');
