/* Shared helpers for every API route.
   Files and folders under functions/ that start with "_" are not routed,
   so this module is importable but never reachable as a URL. */

export const SESSION_COOKIE = 'll_session';
export const SESSION_DAYS = 30;
export const PBKDF2_ITERATIONS = 210000;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;   // 10 MB per image
export const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif'];

/* ---------- responses ---------- */
export const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...headers
    }
  });

export const bad = (message, status = 400) => json({ error: message }, status);

/* ---------- ids & encoding ---------- */
export function newId() {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return [...b].map(x => x.toString(16).padStart(2, '0')).join('');
}
const toHex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');

/* ---------- email ---------- */
/* Deliberately strict but not clever: one @, a local part with no spaces or
   stray dots at the edges, a dotted domain, and a TLD of at least two letters. */
const EMAIL_RE = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,}$/;

export function normalizeEmail(raw) {
  return String(raw == null ? '' : raw).trim().toLowerCase();
}

export function validateEmail(raw) {
  const email = normalizeEmail(raw);
  if (!email) return { ok: false, error: 'Enter your email address.' };
  if (email.length > 254) return { ok: false, error: 'That email address is too long.' };
  if (email.includes('..')) return { ok: false, error: 'That email address is not valid.' };
  const [local] = email.split('@');
  if (local && local.length > 64) return { ok: false, error: 'That email address is not valid.' };
  if (!EMAIL_RE.test(email)) return { ok: false, error: 'That email address is not valid.' };
  return { ok: true, email };
}

export function validatePassword(raw) {
  const pw = String(raw == null ? '' : raw);
  if (pw.length < 8) return { ok: false, error: 'Use a password of at least 8 characters.' };
  if (pw.length > 200) return { ok: false, error: 'That password is too long.' };
  return { ok: true, password: pw };
}

/* ---------- password hashing (PBKDF2-SHA256) ---------- */
export async function hashPassword(password, saltHex, iterations = PBKDF2_ITERATIONS) {
  const salt = Uint8Array.from(saltHex.match(/.{2}/g).map(h => parseInt(h, 16)));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
  return toHex(bits);
}

export function newSalt() {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return [...b].map(x => x.toString(16).padStart(2, '0')).join('');
}

/* Length-independent comparison so a wrong password costs the same either way. */
export function timingSafeEqual(a, b) {
  const x = String(a), y = String(b);
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) diff |= (x.charCodeAt(i) || 0) ^ (y.charCodeAt(i) || 0);
  return diff === 0;
}

/* ---------- sessions ---------- */
/* The cookie holds the raw token; the database holds only its SHA-256.
   A leaked database row therefore cannot be replayed as a session. */
export function newSessionToken() {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return [...b].map(x => x.toString(16).padStart(2, '0')).join('');
}

export async function hashToken(token) {
  return toHex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)));
}

export function sessionCookie(token, request) {
  const secure = new URL(request.url).protocol === 'https:' ? ' Secure;' : '';
  const maxAge = SESSION_DAYS * 24 * 60 * 60;
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly;${secure} SameSite=Lax; Max-Age=${maxAge}`;
}

export function clearCookie(request) {
  const secure = new URL(request.url).protocol === 'https:' ? ' Secure;' : '';
  return `${SESSION_COOKIE}=; Path=/; HttpOnly;${secure} SameSite=Lax; Max-Age=0`;
}

export function readCookie(request, name) {
  const header = request.headers.get('cookie') || '';
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

/* Resolves the caller. Returns null when there is no valid, unexpired session.
   Every route derives the user id from here — never from the request body. */
export async function currentUser(context) {
  const { request, env } = context;
  const token = readCookie(request, SESSION_COOKIE);
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return null;
  const tokenHash = await hashToken(token);
  const row = await env.DB.prepare(
    `SELECT u.id, u.email, u.name, s.expires_at
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ?`
  ).bind(tokenHash).first();
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(tokenHash).run();
    return null;
  }
  return { id: row.id, email: row.email, name: row.name };
}

/* Wraps a handler so it only runs for a signed-in caller. */
export function withUser(handler) {
  return async context => {
    const user = await currentUser(context);
    if (!user) return bad('Sign in to continue.', 401);
    return handler(context, user);
  };
}
