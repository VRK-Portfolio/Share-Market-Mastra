import { MongoClient } from "mongodb";

type MongoPool = { uri: string; client: Promise<MongoClient> };
const globals = globalThis as typeof globalThis & { paperMongoPool?: MongoPool };

export async function paperDatabase() {
  const uri = process.env.MONGODB_URI?.trim();
  const name = process.env.MONGODB_DB?.trim() || "stock_terminal_paper";
  if (!uri || !/^mongodb(?:\+srv)?:\/\//.test(uri)) {
    throw new Error("Paper trading requires MONGODB_URI in the server environment.");
  }
  if (!/^[a-zA-Z0-9_-]{1,63}$/.test(name) || ["admin", "local", "config"].includes(name)) {
    throw new Error("MONGODB_DB must name a dedicated application database.");
  }
  if (!globals.paperMongoPool || globals.paperMongoPool.uri !== uri) {
    const client = new MongoClient(uri, {
      maxPoolSize: 10, minPoolSize: 0, serverSelectionTimeoutMS: 8000,
      connectTimeoutMS: 8000, socketTimeoutMS: 15_000,
      writeConcern: { w: "majority" },
    });
    const pool: MongoPool = { uri, client: client.connect() };
    globals.paperMongoPool = pool;
    pool.client.catch(() => {
      if (globals.paperMongoPool === pool) globals.paperMongoPool = undefined;
    });
  }
  return (await globals.paperMongoPool.client).db(name);
}

export async function closePaperDatabase() {
  const pool = globals.paperMongoPool;
  globals.paperMongoPool = undefined;
  if (pool) await (await pool.client).close();
}
