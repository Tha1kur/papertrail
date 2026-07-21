import { MongoMemoryReplSet } from "mongodb-memory-server";
import mongoose from "mongoose";

let replSet: MongoMemoryReplSet | null = null;

/**
 * Starts an in-memory MongoDB **replica set**, not a standalone server.
 *
 * The repository layer uses transactions — appending a message and
 * incrementing the thread's counters must be atomic — and MongoDB only
 * offers transactions on a replica set. A standalone in-memory server would
 * throw "Transaction numbers are only allowed on a replica set member",
 * which would either force the tests to skip the transactional paths or
 * push someone into removing the transactions to make the tests pass.
 *
 * Testing against something structurally unlike production is how you get a
 * green suite and a broken deploy.
 */
export async function startTestDatabase(): Promise<void> {
  replSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: "wiredTiger" },
  });

  await mongoose.connect(replSet.getUri(), { serverSelectionTimeoutMS: 20_000 });

  // Mongoose defers index creation, so a unique index may not exist yet when
  // the first test relies on it. Building them up front means constraints
  // behave in tests exactly as they do in production.
  await Promise.all(Object.values(mongoose.models).map((model) => model.createIndexes()));
}

export async function stopTestDatabase(): Promise<void> {
  await mongoose.disconnect();
  await replSet?.stop();
  replSet = null;
}

/**
 * Empties every collection between tests without dropping them, so indexes
 * survive and do not have to be rebuilt each time.
 */
export async function clearTestDatabase(): Promise<void> {
  const collections = mongoose.connection.collections;
  await Promise.all(Object.values(collections).map((collection) => collection.deleteMany({})));
}
