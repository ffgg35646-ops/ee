import { createHmac, timingSafeEqual } from 'node:crypto';

export const ADMIN_COOKIE_NAME = 'ee_admin_session';
const SESSION_SECONDS = 60 * 60 * 8;

function getConfig() {
  return {
    username: process.env.WEB_ADMIN_USERNAME?.trim() || '',
    password: process.env.WEB_ADMIN_PASSWORD || '',
    secret: process.env.WEB_ADMIN_SECRET || ''
  };
}
export function getAdminConfigurationStatus() {
  const config = getConfig();
  return {
    configured: Boolean(config.username && config.password && config.secret.length >= 32),
    missing: [
      ...(!config.username ? ['WEB_ADMIN_USERNAME'] : []),
      ...(!config.password ? ['WEB_ADMIN_PASSWORD'] : []),
      ...(config.secret.length < 32 ? ['WEB_ADMIN_SECRET (32 characters minimum)'] : [])
    ]
  };
}
function constantTimeEqual(left: string, right: string) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
function sign(value: string, secret: string) {
  return createHmac('sha256', secret).update(value).digest('base64url');
}
export function verifyAdminCredentials(username: string, password: string) {
  const config = getConfig();
  if (!config.username || !config.password || config.secret.length < 32) return false;
  return constantTimeEqual(username, config.username) && constantTimeEqual(password, config.password);
}
export function createAdminSessionToken(username: string) {
  const config = getConfig();
  if (!config.username || config.secret.length < 32) throw new Error('Web admin authentication is not configured');
  const payload = Buffer.from(JSON.stringify({
    sub: username,
    exp: Math.floor(Date.now() / 1000) + SESSION_SECONDS
  })).toString('base64url');
  return payload + '.' + sign(payload, config.secret);
}
export function verifyAdminSessionToken(token: string | undefined | null) {
  if (!token) return false;
  const config = getConfig();
  if (!config.username || config.secret.length < 32) return false;
  const parts = token.split('.');
  if (parts.length !== 2) return false;
  const [payload, signature] = parts;
  if (!constantTimeEqual(signature, sign(payload, config.secret))) return false;
  try {
    const session = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { sub?: string; exp?: number };
    return session.sub === config.username && typeof session.exp === 'number' && session.exp > Math.floor(Date.now() / 1000);
  } catch {
    return false;
  }
}
