import { json, readCookie, hashToken, clearCookie, SESSION_COOKIE } from '../../_lib.js';

export async function onRequestPost(context) {
  const { request, env } = context;
  const token = readCookie(request, SESSION_COOKIE);
  if (token && /^[0-9a-f]{64}$/.test(token)) {
    await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await hashToken(token)).run();
  }
  return json({ ok: true }, 200, { 'set-cookie': clearCookie(request) });
}
