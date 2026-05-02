import bcrypt from 'bcrypt';
import { UserModel } from '../models/index.js';
import { env } from '../core/env.js';
import { scoped } from '../utils/logger.js';

const log = scoped('AUTH');

export async function ensureAdminUser(): Promise<void> {
  const existing = await UserModel.findOne({ username: env.ADMIN_USERNAME });
  if (existing) return;
  const passwordHash = await bcrypt.hash(env.ADMIN_PASSWORD, 10);
  await UserModel.create({ username: env.ADMIN_USERNAME, passwordHash, role: 'admin' });
  log.info({ username: env.ADMIN_USERNAME }, 'admin user seeded');
}

export async function verifyPassword(username: string, password: string): Promise<boolean> {
  const user = await UserModel.findOne({ username });
  if (!user) return false;
  return bcrypt.compare(password, user.passwordHash);
}
