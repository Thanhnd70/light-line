import { json, currentUser } from '../../_lib.js';

export async function onRequestGet(context) {
  const user = await currentUser(context);
  if (!user) return json({ user: null }, 200);
  return json({ user: { email: user.email, name: user.name } });
}
