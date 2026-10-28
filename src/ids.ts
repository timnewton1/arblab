import { randomBytes } from 'node:crypto';

/** A market's public id: 8 URL-safe characters (48 random bits), e.g. "k3J9xQpL". */
export function newPublicId(): string {
  return randomBytes(6).toString('base64url');
}
