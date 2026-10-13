import { SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';

import { createSchoolGatewayJwtMethod } from '@/lib/server/identity/host/gateway-jwt';
import type { SchoolJwtConfig } from '@/lib/server/school/jwt-config';
import { OWNER_ROLES } from '@/lib/server/identity';

const SECRET = 'test-secret-test-secret-test-secret';
const ISSUER = 'https://school.example/';
const AUDIENCE = 'openmaic';

const config: SchoolJwtConfig = {
  issuer: ISSUER,
  audience: AUDIENCE,
  secret: SECRET,
  headerName: 'authorization',
  clockToleranceSeconds: 30,
};

function method(
  sync?: (roles: readonly string[]) => Promise<readonly ('admin' | 'teacher' | 'student')[]>,
) {
  return createSchoolGatewayJwtMethod(config, async (input) => {
    if (sync) return sync(input.claimedRoles);
    return input.claimedRoles;
  });
}

async function sign(
  sub: string,
  claims: Record<string, unknown> = { roles: ['school:teacher'] },
  options: { audience?: string; expiresIn?: string | number; secret?: string } = {},
): Promise<string> {
  const jwt = new SignJWT(claims)
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(sub)
    .setIssuer(ISSUER)
    .setAudience(options.audience ?? AUDIENCE);
  jwt.setExpirationTime(options.expiresIn ?? '2h');
  return jwt.sign(new TextEncoder().encode(options.secret ?? SECRET));
}

function headers(token?: string, extra?: Record<string, string>): Headers {
  const value = new Headers(extra);
  if (token) value.set('authorization', `Bearer ${token}`);
  return value;
}

describe('school gateway JWT', () => {
  it('does not apply when the token is absent', async () => {
    const result = await method().authenticate({ headers: new Headers() });
    expect(result).toEqual({ status: 'not-applicable' });
  });

  it('refuses a malformed bearer instead of ignoring it', async () => {
    const result = await method().authenticate({
      headers: headers(undefined, { authorization: 'Token abc' }),
    });
    expect(result.status).toBe('invalid');
  });

  it('refuses a bad signature, the wrong audience, and an expired token', async () => {
    const auth = method();
    const badSignature = await auth.authenticate({
      headers: headers(await sign('t', { roles: ['teacher'] }, { secret: `${SECRET}-other` })),
    });
    const wrongAudience = await auth.authenticate({
      headers: headers(await sign('t', { roles: ['teacher'] }, { audience: 'other-app' })),
    });
    const expired = await auth.authenticate({
      headers: headers(await sign('t', { roles: ['teacher'] }, { expiresIn: '-1m' })),
    });
    expect(badSignature.status).toBe('invalid');
    expect(wrongAudience.status).toBe('invalid');
    expect(expired.status).toBe('invalid');
  });

  it('refuses a token that claims both teacher and student', async () => {
    const result = await method().authenticate({
      headers: headers(await sign('t', { roles: ['school:teacher', 'school:student'] })),
    });
    expect(result).toMatchObject({
      status: 'invalid',
      reason: 'teacher and student cannot be combined',
    });
  });

  it('maps teachers and admins to course:publish and leaves students without it', async () => {
    const auth = method();
    const teacher = await auth.authenticate({
      headers: headers(await sign('ada', { roles: ['teacher'], name: 'Ada' })),
    });
    const student = await auth.authenticate({
      headers: headers(await sign('bea', { school_roles: ['school:student'] })),
    });
    const admin = await auth.authenticate({
      headers: headers(await sign('cam', { groups: ['school:admin', 'school:teacher'] })),
    });
    expect(teacher.status).toBe('authenticated');
    expect(student.status).toBe('authenticated');
    expect(admin.status).toBe('authenticated');
    if (
      teacher.status !== 'authenticated' ||
      student.status !== 'authenticated' ||
      admin.status !== 'authenticated'
    ) {
      return;
    }
    expect(teacher.principal.ownerId).toBe('user:ada');
    expect(teacher.principal.kind).toBe('user');
    expect(teacher.principal.assurance).toBe('verified');
    expect([...teacher.principal.roles].sort()).toEqual(['course:publish', 'school:teacher']);
    expect(teacher.principal.roles.has(OWNER_ROLES.coursePublish)).toBe(true);
    expect([...student.principal.roles]).toEqual(['school:student']);
    expect(student.principal.roles.has(OWNER_ROLES.coursePublish)).toBe(false);
    expect(admin.principal.roles.has(OWNER_ROLES.admin)).toBe(true);
    expect(admin.principal.roles.has('school:admin')).toBe(true);
    expect(admin.principal.roles.has(OWNER_ROLES.coursePublish)).toBe(true);
    expect(admin.principal.roles.has('school:teacher')).toBe(true);
  });

  it('lets a stored role binding replace the JWT claim', async () => {
    const auth = method(async () => ['teacher']);
    const result = await auth.authenticate({
      headers: headers(await sign('bea', { roles: ['student'] })),
    });
    expect(result.status).toBe('authenticated');
    if (result.status !== 'authenticated') return;
    expect(result.principal.roles.has(OWNER_ROLES.coursePublish)).toBe(true);
    expect(result.principal.roles.has('school:student')).toBe(false);
  });

  it('accepts the token from a cookie when the header is absent', async () => {
    const cookieMethod = createSchoolGatewayJwtMethod(
      { ...config, headerName: undefined, cookieName: 'school_jwt' },
      async (input) => input.claimedRoles,
    );
    const token = await sign('ada', { roles: ['teacher'] });
    const result = await cookieMethod.authenticate({
      headers: new Headers({ cookie: `school_jwt=${token}` }),
    });
    expect(result.status).toBe('authenticated');
    if (result.status !== 'authenticated') return;
    expect(result.principal.ownerId).toBe('user:ada');
  });

  it('does not grant course:publish from a stored owner id alone', () => {
    const described = method().describeStoredOwner?.('user:ada');
    expect(described).toEqual({ kind: 'user' });
    expect(described?.roles).toBeUndefined();
    expect(method().describeStoredOwner?.('local')).toBeUndefined();
  });

  it('rejects an unusable sub', async () => {
    const result = await method().authenticate({
      headers: headers(await sign('has space', { roles: ['teacher'] })),
    });
    expect(result).toMatchObject({ status: 'invalid', reason: 'unusable sub' });
  });
});
