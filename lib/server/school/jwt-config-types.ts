/** Parsed `SCHOOL_JWT_*` settings. `secret` and `jwksUrl` are mutually exclusive. */
export interface SchoolJwtConfig {
  readonly issuer: string;
  readonly audience: string;
  readonly secret?: string;
  readonly jwksUrl?: string;
  /** Header that carries the token. Absent when the header source is off. */
  readonly headerName?: string;
  readonly cookieName?: string;
  /** JWT claim that lists school roles. Unset probes `school_roles`, then `roles`, then `groups`. */
  readonly rolesClaim?: string;
  readonly clockToleranceSeconds: number;
}
