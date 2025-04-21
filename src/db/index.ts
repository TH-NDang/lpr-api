import "dotenv/config";

import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from './schema';

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not set in environment variables");
}
const connectionString = process.env.DATABASE_URL || 'postgresql://user:password@host:port/db';
const pool = new Pool({
  connectionString: connectionString,
});
export const db = drizzle(pool, { schema });
