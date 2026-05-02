import type { Request, Response, NextFunction, RequestHandler } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../core/env.js';

export interface AuthedRequest extends Request {
  user?: { username: string; role: string };
}

export function signToken(payload: { username: string; role: string }): string {
  return jwt.sign(payload, env.JWT_SECRET, { expiresIn: env.JWT_EXPIRES_IN } as jwt.SignOptions);
}

export const authMiddleware: RequestHandler = (req: AuthedRequest, res: Response, next: NextFunction) => {
  const header = req.headers.authorization ?? '';
  const m = /^Bearer (.+)$/i.exec(header);
  if (!m) {
    res.status(401).json({ error: 'missing_token' });
    return;
  }
  try {
    const decoded = jwt.verify(m[1] as string, env.JWT_SECRET) as { username: string; role: string };
    req.user = decoded;
    next();
  } catch {
    res.status(401).json({ error: 'invalid_token' });
  }
};

export function verifyTokenString(token: string): { username: string; role: string } | null {
  try {
    return jwt.verify(token, env.JWT_SECRET) as { username: string; role: string };
  } catch {
    return null;
  }
}
