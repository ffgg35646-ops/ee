import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { cookies } from 'next/headers';
import { ObjectId, type Db } from 'mongodb';

export const ADMIN_COOKIE_NAME = 'ee_admin_session';
const SESSION_SECONDS = 60 * 60 * 12;

export type AdminPrincipal = {
  id: string;
  email: string;
  name: string;
  role: 'super_admin' | 'admin';
};

type AdminAccount = {
  _id: ObjectId;
  email: string;
  name: string;
  passwordHash: string;
  passwordSalt: string;
  role: 'super_admin' | 'admin';
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
};

let indexPromise: Promise<void> | undefined;

async function ensureAdminIndexes(db: Db) {
  if (!indexPromise) {
    indexPromise = db.collection<AdminAccount>('admin_users').createIndex({ email: 1 }, { unique: true }).then(() => undefined);
  }
  try {
    await indexPromise;
  } catch (error) {
    indexPromise = undefined;
    throw error;
  }
}

function normalizeEmail(value: string) {
  return value.trim().toLowerCase().slice(0, 190);
}

export function hashAdminPassword(password: string, salt: string) {
  return scryptSync(password, salt, 64).toString('hex');
}

function safeEqual(left: string, right: string) {
  const a = Buffer.from(left, 'hex');
  const b = Buffer.from(right, 'hex');
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

export async function ensureBootstrapAdmin(db: Db) {
  await ensureAdminIndexes(db);
  const email = normalizeEmail(process.env.ADMIN_EMAIL || '');
  const password = process.env.ADMIN_PASSWORD || '';
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 10) return null;

  const collection = db.collection<AdminAccount>('admin_users');
  let account = await collection.findOne({ email });
  if (account) return account;

  const salt = randomBytes(18).toString('hex');
  const now = new Date();
  const newAccount: AdminAccount = {
    _id: new ObjectId(),
    email,
    name: 'مدير المتجر',
    passwordSalt: salt,
    passwordHash: hashAdminPassword(password, salt),
    role: 'super_admin',
    active: true,
    createdAt: now,
    updatedAt: now
  };
  try {
    await collection.insertOne(newAccount);
    account = newAccount;
  } catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 11000)) throw error;
    account = await collection.findOne({ email });
  }
  return account;
}

export async function authenticateAdmin(db: Db, emailInput: string, password: string) {
  await ensureBootstrapAdmin(db);
  const email = normalizeEmail(emailInput);
  const account = await db.collection<AdminAccount>('admin_users').findOne({ email, active: true });
  if (!account || !password || password.length > 256) return null;
  const candidate = hashAdminPassword(password, account.passwordSalt);
  if (!safeEqual(candidate, account.passwordHash)) return null;
  return account;
}

function signingSecret() {
  const secret = process.env.ADMIN_SESSION_SECRET || process.env.MONGODB_URI || '';
  if (secret.length < 32) throw new Error('ADMIN_SESSION_SECRET is not configured');
  return secret;
}

export function createAdminSessionToken(account: Pick<AdminAccount, '_id' | 'email' | 'name' | 'role'>) {
  const payload = Buffer.from(JSON.stringify({
    sub: account._id.toHexString(),
    email: account.email,
    name: account.name,
    role: account.role,
    exp: Math.floor(Date.now() / 1000) + SESSION_SECONDS
  })).toString('base64url');
  const signature = createHmac('sha256', signingSecret()).update(payload).digest('base64url');
  return payload + '.' + signature;
}

function readCookie(request: Request, key: string) {
  const header = request.headers.get('cookie') || '';
  const prefix = key + '=';
  const pair = header.split(';').map((item) => item.trim()).find((item) => item.startsWith(prefix));
  if (!pair) return '';
  try { return decodeURIComponent(pair.slice(prefix.length)); } catch { return ''; }
}

export async function getAdminFromToken(db: Db, token: string): Promise<AdminPrincipal | null> {
  if (!token || token.length > 4096) return null;
  const [payload, signature] = token.split('.');
  if (!payload || !signature) return null;
  try {
    const expected = createHmac('sha256', signingSecret()).update(payload).digest();
    const actual = Buffer.from(signature, 'base64url');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { sub?: string; exp?: number };
    if (!decoded.sub || !ObjectId.isValid(decoded.sub) || !decoded.exp || decoded.exp <= Math.floor(Date.now() / 1000)) return null;
    const account = await db.collection<AdminAccount>('admin_users').findOne({
      _id: new ObjectId(decoded.sub),
      active: true
    });
    if (!account) return null;
    return {
      id: account._id.toHexString(),
      email: account.email,
      name: account.name,
      role: account.role
    };
  } catch {
    return null;
  }
}

export async function getAdminFromRequest(db: Db, request: Request) {
  return getAdminFromToken(db, readCookie(request, ADMIN_COOKIE_NAME));
}

export async function getAdminFromCookies(db: Db) {
  const store = await cookies();
  return getAdminFromToken(db, store.get(ADMIN_COOKIE_NAME)?.value || '');
}

export function adminSessionMaxAge() {
  return SESSION_SECONDS;
}
