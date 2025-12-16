-- CreateEnum
CREATE TYPE "DailyTaskType" AS ENUM ('LOGIN', 'READ_RESOURCE', 'ADD_WALLET', 'EXPLORE_LEADERBOARD');

-- CreateEnum
CREATE TYPE "WeeklyChallengeType" AS ENUM ('READ_20_RESOURCES', 'CREATE_5_READLISTS', 'LOGIN_7_DAYS', 'ADD_15_WALLETS');

-- CreateTable
CREATE TABLE "daily_task_progress" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "taskType" "DailyTaskType" NOT NULL,
    "date" DATE NOT NULL,
    "completed" BOOLEAN NOT NULL DEFAULT false,
    "completedAt" TIMESTAMP(6),

    CONSTRAINT "daily_task_progress_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "weekly_challenges" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "challengeType" "WeeklyChallengeType" NOT NULL,
    "weekStart" DATE NOT NULL,
    "progress" INTEGER NOT NULL DEFAULT 0,
    "target" INTEGER NOT NULL,
    "completed" BOOLEAN NOT NULL DEFAULT false,
    "completedAt" TIMESTAMP(6),
    "xpReward" INTEGER NOT NULL,

    CONSTRAINT "weekly_challenges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "daily_action_counts" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "actionType" "XpActionType" NOT NULL,
    "date" DATE NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "daily_action_counts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "daily_task_progress_userId_date_idx" ON "daily_task_progress"("userId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "daily_task_progress_userId_taskType_date_key" ON "daily_task_progress"("userId", "taskType", "date");

-- CreateIndex
CREATE INDEX "weekly_challenges_userId_weekStart_idx" ON "weekly_challenges"("userId", "weekStart");

-- CreateIndex
CREATE UNIQUE INDEX "weekly_challenges_userId_challengeType_weekStart_key" ON "weekly_challenges"("userId", "challengeType", "weekStart");

-- CreateIndex
CREATE INDEX "daily_action_counts_userId_date_idx" ON "daily_action_counts"("userId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "daily_action_counts_userId_actionType_date_key" ON "daily_action_counts"("userId", "actionType", "date");

-- AddForeignKey
ALTER TABLE "daily_task_progress" ADD CONSTRAINT "daily_task_progress_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "weekly_challenges" ADD CONSTRAINT "weekly_challenges_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "daily_action_counts" ADD CONSTRAINT "daily_action_counts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
