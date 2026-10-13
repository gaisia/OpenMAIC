/**
 * School gateway JWT owner auth method.
 *
 * A deployment behind an identity gateway (oauth2-proxy, Cloudflare Access,
 * Google IAP, or a school gateway that signs its own token) verifies that
 * signed assertion here and nowhere else. Absent token is `not-applicable`.
 * A token that is present but fails verification is `invalid`, which core
 * answers as 401 and does not fall through to an anonymous owner.
 *
 * `sub` becomes `user:<sub>`. School roles come from the configured claim
 * (`school:teacher`, `teacher`, and the admin/student equivalents). When a
 * database binding exists and an admin has managed it, that binding replaces
 * the claim on this request. Teachers and admins receive `course:publish`.
 * Students do not.
 *
 * The file lives in `lib/server/identity/host/` because that is the only place
 * allowed to read an incoming Authorization header or a gateway identity header.
 */
import { createRemoteJWKSet, errors, jwtVerify, type JWTPayload } from 'jose';

import type { OwnerAuthMethod, OwnerAuthMethodResult } from '@/lib/server/identity';
import { isStorableOwnerId } from '@/lib/server/identity/types';
import type { SchoolJwtConfig } from '@/lib/server/school/jwt-config';
import { getSchoolRepository } from '@/lib/server/school/repository';
import { parseSchoolRoleClaim, principalRoleSet, type SchoolRole } from '@/lib/server/school/roles';

/** jose errors that mean the token itself is bad, not that the key source failed. */
const TOKEN_ERRORS = [
  errors.JWTExpired,
  errors.JWTClaimValidationFailed,
  errors.JWTInvalid,
  errors.JWSInvalid,
  errors.JWSSignatureVerificationFailed,
  errors.JWKSNoMatchingKey,
  errors.JWKSMultipleMatchingKeys,
  errors.JOSEAlgNotAllowed,
  errors.JOSENotSupported,
];

export interface LoginRoleSync {
  (input: {
    ownerId: string;
    displayName: string | null;
    email: string | null;
    claimedRoles: readonly SchoolRole[];
  }): Promise<readonly SchoolRole[]>;
}

const defaultRoleSync: LoginRoleSync = async (input) => {
  const repo = await getSchoolRepository();
  return repo.syncFromLogin(input);
};

function textClaim(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max || trimmed.includes('\0')) return null;
  return trimmed;
}

function roleClaim(payload: JWTPayload, config: SchoolJwtConfig): unknown {
  if (config.rolesClaim) return payload[config.rolesClaim];
  if ('school_roles' in payload) return payload.school_roles;
  if ('roles' in payload) return payload.roles;
  if ('groups' in payload) return payload.groups;
  return undefined;
}

type LocatedToken =
  | { readonly kind: 'absent' }
  | { readonly kind: 'bad'; readonly reason: string }
  | { readonly kind: 'token'; readonly token: string };

function bearer(value: string): LocatedToken {
  const match = /^Bearer\s+(\S+)$/i.exec(value.trim());
  if (!match?.[1]) return { kind: 'bad', reason: 'authorization is not a bearer token' };
  return { kind: 'token', token: match[1] };
}

function headerToken(headers: Headers, headerName: string): LocatedToken {
  const value = headers.get(headerName);
  if (value === null || value.trim() === '') return { kind: 'absent' };
  if (headerName.toLowerCase() === 'authorization') return bearer(value);
  return { kind: 'token', token: value.trim() };
}

function cookieToken(headers: Headers, cookieName: string): LocatedToken {
  const raw = headers.get('cookie');
  if (!raw) return { kind: 'absent' };
  for (const part of raw.split(';')) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    if (trimmed.slice(0, eq) !== cookieName) continue;
    let value = trimmed.slice(eq + 1);
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      value = value.slice(1, -1);
    }
    try {
      value = decodeURIComponent(value);
    } catch {
      return { kind: 'bad', reason: 'cookie token is not url-encoded' };
    }
    if (!value) return { kind: 'bad', reason: 'empty cookie token' };
    return { kind: 'token', token: value };
  }
  return { kind: 'absent' };
}

function locateToken(headers: Headers, config: SchoolJwtConfig): LocatedToken {
  if (config.headerName) {
    const header = headerToken(headers, config.headerName);
    if (header.kind !== 'absent') return header;
  }
  if (config.cookieName) return cookieToken(headers, config.cookieName);
  return { kind: 'absent' };
}

export function createSchoolGatewayJwtMethod(
  config: SchoolJwtConfig,
  syncRoles: LoginRoleSync = defaultRoleSync,
): OwnerAuthMethod {
  const secretKey = config.secret ? new TextEncoder().encode(config.secret) : undefined;
  const jwks = config.jwksUrl ? createRemoteJWKSet(new URL(config.jwksUrl)) : undefined;
  const verification = {
    issuer: config.issuer,
    audience: config.audience,
    clockTolerance: config.clockToleranceSeconds,
  };

  return {
    name: 'schoolGatewayJwt',
    async authenticate(req): Promise<OwnerAuthMethodResult> {
      const located = locateToken(req.headers, config);
      if (located.kind === 'absent') return { status: 'not-applicable' };
      if (located.kind === 'bad') return { status: 'invalid', reason: located.reason };
      let payload: JWTPayload;
      try {
        if (secretKey) {
          ({ payload } = await jwtVerify(located.token, secretKey, {
            ...verification,
            algorithms: ['HS256'],
          }));
        } else if (jwks) {
          ({ payload } = await jwtVerify(located.token, jwks, {
            ...verification,
            algorithms: ['RS256', 'ES256'],
          }));
        } else {
          throw new Error('school gateway JWT method has neither a secret nor a JWKS URL');
        }
      } catch (error) {
        if (TOKEN_ERRORS.some((type) => error instanceof type)) {
          const code = error instanceof errors.JOSEError ? error.code : 'invalid token';
          return { status: 'invalid', reason: code };
        }
        throw error;
      }
      const sub = typeof payload.sub === 'string' ? payload.sub : '';
      const ownerId = `user:${sub}`;
      if (!sub || !isStorableOwnerId(ownerId)) {
        return { status: 'invalid', reason: 'unusable sub' };
      }
      const parsed = parseSchoolRoleClaim(roleClaim(payload, config));
      if (!parsed.ok) return { status: 'invalid', reason: parsed.reason };
      const displayName =
        textClaim(payload.name, 200) ?? textClaim(payload.preferred_username, 200);
      const email = textClaim(payload.email, 320);
      const roles = await syncRoles({
        ownerId,
        displayName,
        email,
        claimedRoles: parsed.roles,
      });
      return {
        status: 'authenticated',
        principal: {
          ownerId,
          kind: 'user',
          roles: principalRoleSet(roles),
          assurance: 'verified',
          channel: 'gateway',
        },
      };
    },
    describeStoredOwner(ownerId) {
      if (!ownerId.startsWith('user:') || !isStorableOwnerId(ownerId)) return undefined;
      return { kind: 'user' };
    },
  };
}
