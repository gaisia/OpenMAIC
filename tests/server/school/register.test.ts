import { afterEach, describe, expect, it, vi } from 'vitest';

import { resetClaimParticipantsForTests } from '@/lib/persistence/owner-claims';
import {
  ownerAuthConfigurationForResolution,
  resetOwnerAuthenticationForTests,
} from '@/lib/server/identity/registry';
import {
  getPersistenceHooks,
  resetPersistenceHooksForTests,
} from '@/lib/server/persistence-hooks/registry';
import { readSchoolJwtConfig } from '@/lib/server/school/jwt-config';
import { registerSchoolHost } from '@/lib/server/school/register';
import { setSchoolRepositoryForTests } from '@/lib/server/school/repository';

const SECRET = 'test-secret-test-secret-test-secret';

function schoolEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    SCHOOL_JWT_ISSUER: 'https://school.example/',
    SCHOOL_JWT_AUDIENCE: 'openmaic',
    SCHOOL_JWT_SECRET: SECRET,
    OWNER_SINGLE_USER: 'false',
    OWNER_ANONYMOUS_PREMINT: 'false',
    ...extra,
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  resetOwnerAuthenticationForTests();
  resetPersistenceHooksForTests();
  resetClaimParticipantsForTests();
  setSchoolRepositoryForTests(undefined);
});

describe('school identity configuration', () => {
  it('stays off when no SCHOOL_JWT variable is set', () => {
    expect(readSchoolJwtConfig({})).toBeUndefined();
    expect(registerSchoolHost({})).toBe(false);
  });

  it('rejects a partial configuration', () => {
    expect(() => readSchoolJwtConfig({ SCHOOL_JWT_ISSUER: 'https://school.example/' })).toThrow(
      /SCHOOL_JWT_AUDIENCE/,
    );
    expect(() =>
      readSchoolJwtConfig({
        SCHOOL_JWT_ISSUER: 'https://school.example/',
        SCHOOL_JWT_AUDIENCE: 'openmaic',
        SCHOOL_JWT_SECRET: SECRET,
        SCHOOL_JWT_JWKS_URL: 'https://school.example/jwks',
      }),
    ).toThrow(/not both/);
    expect(() =>
      readSchoolJwtConfig({
        SCHOOL_JWT_ISSUER: 'https://school.example/',
        SCHOOL_JWT_AUDIENCE: 'openmaic',
        SCHOOL_JWT_SECRET: 'too-short',
      }),
    ).toThrow(/32/);
    expect(() => readSchoolJwtConfig({ SCHOOL_JWT_FOO: '1' })).toThrow(/Unknown school identity/);
  });

  it('refuses single-user mode, a shared owner, and anonymous pre-minting', () => {
    expect(() => registerSchoolHost(schoolEnv({ OWNER_SINGLE_USER: 'true' }))).toThrow(
      /OWNER_SINGLE_USER=false/,
    );
    expect(() => registerSchoolHost(schoolEnv({ PERSISTENCE_SHARED_OWNER_ID: 'team' }))).toThrow(
      /PERSISTENCE_SHARED_OWNER_ID/,
    );
    expect(() => registerSchoolHost(schoolEnv({ OWNER_ANONYMOUS_PREMINT: 'true' }))).toThrow(
      /OWNER_ANONYMOUS_PREMINT=false/,
    );
  });

  it('registers the gateway method with anonymous fallback off', () => {
    for (const [key, value] of Object.entries(schoolEnv())) {
      vi.stubEnv(key, value ?? '');
    }
    vi.stubEnv('PERSISTENCE_SHARED_OWNER_ID', '');
    vi.stubEnv('OWNER_SINGLE_USER_ID', '');
    expect(registerSchoolHost()).toBe(true);
    const configured = ownerAuthConfigurationForResolution();
    expect(configured.anonymousFallback).toBe(false);
    expect(configured.methods.map((item) => item.name)).toEqual(['schoolGatewayJwt']);
    expect(getPersistenceHooks().name).toBe('school-class');
    expect(typeof getPersistenceHooks().authorizeCreate).toBe('function');
    expect(getPersistenceHooks().library?.name).toBe('school-class');
    expect(typeof getPersistenceHooks().library?.list).toBe('function');
  });
});
