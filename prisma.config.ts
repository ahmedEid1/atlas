import "dotenv/config";
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    // Prisma migrate REQUIRES a direct (non-pooled) connection — pgbouncer
    // doesn't support prepared statements that migrations rely on.
    url: process.env["DIRECT_DATABASE_URL"] ?? process.env["DATABASE_URL"]!,
  },
});
