import type { Config } from "drizzle-kit";

const url = process.env.DATABASE_URL_ADMIN ?? process.env.DATABASE_URL;

if (!url) {
  throw new Error(
    "drizzle.config.ts: defina DATABASE_URL_ADMIN (conexão direta, preferida para migrations) ou DATABASE_URL.",
  );
}

export default {
  schema: "./src/lib/db/schema/*",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: { url },
  strict: true,
  verbose: true,
} satisfies Config;
