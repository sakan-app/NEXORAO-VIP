-- Supabase exposes the public schema through its Data API. The app talks to Postgres only through
-- Prisma as the database owner, so lock every table for the API roles (no policies = no access).
ALTER TABLE "User" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Product" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Order" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "OrderItem" ENABLE ROW LEVEL SECURITY;
