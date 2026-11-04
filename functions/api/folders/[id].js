import { json, bad, withUser } from '../../_lib.js';

/* Both handlers match on (id, user_id). Another account's folder id simply
   finds no row, so it reads as "not found" rather than "forbidden". */

export const onRequestPatch = withUser(async ({ request, params, env }, user) => {
  let body;
  try { body = await request.json(); } catch { return bad('Send a JSON body.'); }
  const name = String(body.name || '').trim().slice(0, 60);
  if (!name) return bad('Give the folder a name.');

  const folder = await env.DB.prepare('SELECT id FROM folders WHERE id = ? AND user_id = ?')
    .bind(params.id, user.id).first();
  if (!folder) return bad('Folder not found.', 404);

  const dup = await env.DB.prepare('SELECT id FROM folders WHERE user_id = ? AND name = ? AND id != ?')
    .bind(user.id, name, params.id).first();
  if (dup) return bad('You already have a folder with that name.', 409);

  await env.DB.prepare('UPDATE folders SET name = ? WHERE id = ? AND user_id = ?')
    .bind(name, params.id, user.id).run();
  return json({ ok: true, folder: { id: params.id, name } });
});

export const onRequestDelete = withUser(async ({ params, env }, user) => {
  const folder = await env.DB.prepare('SELECT id FROM folders WHERE id = ? AND user_id = ?')
    .bind(params.id, user.id).first();
  if (!folder) return bad('Folder not found.', 404);

  const total = await env.DB.prepare('SELECT COUNT(*) AS n FROM folders WHERE user_id = ?').bind(user.id).first();
  if (total && total.n <= 1) return bad('Keep at least one folder.');

  // Items move to the account's oldest remaining folder rather than being lost.
  const fallback = await env.DB.prepare(
    'SELECT id FROM folders WHERE user_id = ? AND id != ? ORDER BY created_at ASC LIMIT 1'
  ).bind(user.id, params.id).first();

  await env.DB.batch([
    env.DB.prepare('UPDATE items SET folder_id = ? WHERE folder_id = ? AND user_id = ?')
      .bind(fallback.id, params.id, user.id),
    env.DB.prepare('DELETE FROM folders WHERE id = ? AND user_id = ?').bind(params.id, user.id)
  ]);

  return json({ ok: true, moved_to: fallback.id });
});
