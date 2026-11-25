import { MongoClient, type Db } from 'mongodb';

const globalForMongo = globalThis as typeof globalThis & {
  _eeMongoClientPromise?: Promise<MongoClient>;
};
let localClientPromise: Promise<MongoClient> | undefined;

function getClientPromise(): Promise<MongoClient> {
  const uri = process.env.MONGODB_URI?.trim();
  if (!uri) throw new Error('MONGODB_URI is not configured for EE');
  if (process.env.NODE_ENV !== 'production') {
    if (!globalForMongo._eeMongoClientPromise) {
      const client = new MongoClient(uri);
      let pending: Promise<MongoClient>;
      pending = client.connect().catch(async (error) => {
        if (globalForMongo._eeMongoClientPromise === pending) globalForMongo._eeMongoClientPromise = undefined;
        await client.close().catch(() => undefined);
        throw error;
      });
      globalForMongo._eeMongoClientPromise = pending;
    }
    return globalForMongo._eeMongoClientPromise;
  }
  if (!localClientPromise) {
    const client = new MongoClient(uri);
    let pending: Promise<MongoClient>;
    pending = client.connect().catch(async (error) => {
      if (localClientPromise === pending) localClientPromise = undefined;
      await client.close().catch(() => undefined);
      throw error;
    });
    localClientPromise = pending;
  }
  return localClientPromise;
}

/** EE is isolated from BB. Configure MONGODB_DB=ee_store when adding MongoDB. */
export async function getDb(): Promise<Db> {
  const databaseName = process.env.MONGODB_DB?.trim() || 'ee_store';
  if (!/^[a-zA-Z0-9_-]{1,63}$/.test(databaseName) || databaseName === 'bb_store') {
    throw new Error('MONGODB_DB must be a valid EE database name and cannot be bb_store');
  }
  const client = await getClientPromise();
  return client.db(databaseName);
}
