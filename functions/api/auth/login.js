import {
  json, bad, validateEmail, hashPassword, timingSafeEqual,
  newSessionToken, hashToken, sessionCookie, SESSION_DAYS, newSalt, PBKDF2_ITERATIONS
} from '../../_lib.js';

export async function onRequestPost(context) {
  const { request, env } = context;

  let body;
  try { body = await request.json(); } catch { return bad('Send a JSON body.'); }

  const email = validateEmail(body.email);
  if (!email.ok) return bad(email.error);
  const password = String(body.password || '');
  if (!password) return bad('Enter your password.');

  const user = await env.DB.prepare(
    'SELECT id, email, name, pw_salt, pw_hash, pw_iter FROM users WHERE email = ?'
  ).bind(email.email).first();

  // Hash against a throwaway salt when the account does not exist, so an
  // unknown address takes the same time as a wrong password.
  const salt = user ? user.pw_salt : newSalt();
  const iter = user ? user.pw_iter : PBKDF2_ITERATIONS;
  const attempt = await hashPassword(password, salt, iter);

  if (!user || !timingSafeEqual(attempt, user.pw_hash)) {
    return bad('Email or password is incorrect.', 401);
  }

  const now = Date.now();
  const token = newSessionToken();
  await env.DB.prepare(
    'INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)'
  ).bind(await hashToken(token), user.id, now, now + SESSION_DAYS * 86400000).run();

  // Opportunistic cleanup of this account's expired sessions.
  await env.DB.prepare('DELETE FROM sessions WHERE user_id = ? AND expires_at < ?').bind(user.id, now).run();

  return json({ user: { email: user.email, name: user.name } }, 200, { 'set-cookie': sessionCookie(token, request) });
}
