import { MongoClient, type Db } from 'mongodb';

const globalForMongo = globalThis as typeof globalThis & {
  _eeMongoClientPromise?: Promise<MongoClient>;
};

let localClientPromise: Promise<MongoClient> | undefined;

function getClientPromise(): Promise<MongoClient> {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error('MONGODB_URI is not configured');
  }

  if (process.env.NODE_ENV !== 'production') {
    if (!globalForMongo._eeMongoClientPromise) {
      const client = new MongoClient(uri);
      let cachedConnection: Promise<MongoClient>;
      cachedConnection = client.connect().catch((error) => {
        // Do not keep a rejected promise cached after a transient network/TLS failure.
        if (globalForMongo._eeMongoClientPromise === cachedConnection) {
          globalForMongo._eeMongoClientPromise = undefined;
        }
        void client.close().catch(() => undefined);
        throw error;
      });
      globalForMongo._eeMongoClientPromise = cachedConnection;
    }
    return globalForMongo._eeMongoClientPromise;
  }

  if (!localClientPromise) {
    const client = new MongoClient(uri);
    let cachedConnection: Promise<MongoClient>;
    cachedConnection = client.connect().catch((error) => {
      // A failed promise must not poison this warm serverless instance forever.
      if (localClientPromise === cachedConnection) {
        localClientPromise = undefined;
      }
      void client.close().catch(() => undefined);
      throw error;
    });
    localClientPromise = cachedConnection;
  }

  return localClientPromise;
}

export async function getDb(): Promise<Db> {
  const configuredDatabase = process.env.MONGODB_DB?.trim();
  if (configuredDatabase && configuredDatabase !== 'ee_store') {
    throw new Error('MONGODB_DB must be "ee_store" for the EE project');
  }

  const client = await getClientPromise();
  return client.db('ee_store');
}
