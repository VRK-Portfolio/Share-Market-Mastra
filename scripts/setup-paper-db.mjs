import { MongoServerError } from "mongodb";
import { closePaperDatabase, paperDatabase } from "../src/lib/paper/database.ts";

try {
  const db = await paperDatabase();
  try {
    await db.createCollection("paper_accounts");
  } catch (error) {
    if (!(error instanceof MongoServerError) || error.code !== 48) throw error;
  }
  await db.command({ ping: 1 });
  console.log(`MongoDB paper database "${db.databaseName}" is ready. No user account or trade records were created.`);
} catch {
  console.error("MongoDB setup failed. Check MONGODB_URI, MONGODB_DB, Atlas network access and database-user permissions. Credentials are not logged.");
  process.exitCode = 1;
} finally {
  try { await closePaperDatabase(); } catch {
    console.error("MongoDB connection cleanup failed.");
    process.exitCode = 1;
  }
}
