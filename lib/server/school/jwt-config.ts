/**
 * Environment for the school gateway JWT.
 *
 * School identity is off unless some `SCHOOL_JWT_*` variable is set. A partial
 * or unknown variable fails the boot: a typo must not silently leave the
 * deployment on anonymous owners. When it is on, `registerSchoolHost` registers
 * the gateway method with anonymous fallback off.
 */

import type { SchoolJwtConfig } from './jwt-config-types';

export type { SchoolJwtConfig } from './jwt-config-types';

const KNOWN = [
  'SCHOOL_JWT_ISSUER',
  'SCHOOL_JWT_AUDIENCE',
  'SCHOOL_JWT_SECRET',
  'SCHOOL_JWT_JWKS_URL',
  'SCHOOL_JWT_HEADER',
  'SCHOOL_JWT_COOKIE',
  'SCHOOL_JWT_ROLES_CLAIM',
  'SCHOOL_JWT_CLOCK_TOLERANCE_SECONDS',
] as const;

function trimmed(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

/** Whether any school JWT variable is set to a non-blank value. */
export function schoolJwtEnvIsSet(env: NodeJS.ProcessEnv = process.env): boolean {
  return Object.entries(env).some(
    ([name, value]) => name.startsWith('SCHOOL_JWT_') && typeof value === 'string' && value.trim(),
  );
}

/**
 * The school JWT configuration, or `undefined` when school identity is off.
 * Throws when a school variable is set but the configuration is not usable.
 */
export function readSchoolJwtConfig(
  env: NodeJS.ProcessEnv = process.env,
): SchoolJwtConfig | undefined {
  if (!schoolJwtEnvIsSet(env)) return undefined;
  const unknown = Object.keys(env)
    .filter(
      (name) => name.startsWith('SCHOOL_JWT_') && !(KNOWN as readonly string[]).includes(name),
    )
    .filter((name) => trimmed(env, name))
    .sort();
  if (unknown.length > 0) {
    throw new Error(
      `Unknown school identity setting ${unknown.join(', ')}. ` +
        `Known settings: ${KNOWN.join(', ')}.`,
    );
  }
  const issuer = trimmed(env, 'SCHOOL_JWT_ISSUER');
  const audience = trimmed(env, 'SCHOOL_JWT_AUDIENCE');
  const secret = trimmed(env, 'SCHOOL_JWT_SECRET');
  const jwksUrl = trimmed(env, 'SCHOOL_JWT_JWKS_URL');
  if (!issuer) throw new Error('SCHOOL_JWT_ISSUER is required when school identity is enabled.');
  if (!audience)
    throw new Error('SCHOOL_JWT_AUDIENCE is required when school identity is enabled.');
  if (secret && jwksUrl) {
    throw new Error('Set SCHOOL_JWT_SECRET or SCHOOL_JWT_JWKS_URL, not both.');
  }
  if (!secret && !jwksUrl) {
    throw new Error(
      'School identity needs SCHOOL_JWT_SECRET (HS256) or SCHOOL_JWT_JWKS_URL (RS256/ES256).',
    );
  }
  if (secret && secret.length < 32) {
    throw new Error('SCHOOL_JWT_SECRET must be at least 32 characters.');
  }
  if (jwksUrl) {
    let url: URL;
    try {
      url = new URL(jwksUrl);
    } catch {
      throw new Error('SCHOOL_JWT_JWKS_URL must be an absolute URL.');
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new Error('SCHOOL_JWT_JWKS_URL must be an http or https URL.');
    }
  }
  const headerRaw = trimmed(env, 'SCHOOL_JWT_HEADER');
  const headerName =
    headerRaw === undefined
      ? 'authorization'
      : headerRaw.toLowerCase() === 'off'
        ? undefined
        : headerRaw;
  const cookieName = trimmed(env, 'SCHOOL_JWT_COOKIE');
  if (!headerName && !cookieName) {
    throw new Error(
      'School identity needs a token source: leave SCHOOL_JWT_HEADER unset (Authorization bearer) or set SCHOOL_JWT_COOKIE.',
    );
  }
  if (cookieName && cookieName === ['anonymous', 'id'].join('_')) {
    throw new Error('SCHOOL_JWT_COOKIE must not reuse the built-in anonymous owner cookie.');
  }
  const rolesClaim = trimmed(env, 'SCHOOL_JWT_ROLES_CLAIM');
  const toleranceRaw = trimmed(env, 'SCHOOL_JWT_CLOCK_TOLERANCE_SECONDS');
  let clockToleranceSeconds = 30;
  if (toleranceRaw !== undefined) {
    if (!/^\d+$/.test(toleranceRaw) || Number(toleranceRaw) > 300) {
      throw new Error(
        'SCHOOL_JWT_CLOCK_TOLERANCE_SECONDS must be an integer from 0 to 300 seconds.',
      );
    }
    clockToleranceSeconds = Number(toleranceRaw);
  }
  return {
    issuer,
    audience,
    secret,
    jwksUrl,
    headerName,
    cookieName,
    rolesClaim,
    clockToleranceSeconds,
  };
}
