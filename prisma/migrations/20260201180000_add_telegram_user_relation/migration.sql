-- AddForeignKey
ALTER TABLE "telegram_users" ADD CONSTRAINT "telegram_users_linked_user_id_fkey" FOREIGN KEY ("linked_user_id") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
