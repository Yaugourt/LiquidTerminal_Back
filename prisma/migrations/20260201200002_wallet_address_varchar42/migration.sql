-- Reduce Wallet.address from VARCHAR(255) to VARCHAR(42)
-- Ethereum addresses are always 42 chars (0x + 40 hex)
ALTER TABLE "Wallet" ALTER COLUMN "address" TYPE VARCHAR(42);
