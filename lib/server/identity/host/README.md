# Host auth methods

This directory is where a deployment keeps its own owner auth methods (see
"Owner identity" in the repository README): a session cookie, an API key, or
a gateway-signed token such as the README's JWT recipe.

This fork ships `gateway-jwt.ts` for school single sign-on. It is registered
from `instrumentation.ts` by `registerSchoolHost` only when `SCHOOL_JWT_*` is
set (`anonymousFallback: false`). Configuration, role mapping, and the smoke
checklist are in `lib/server/school/README.md`. Upstream deployments that
leave those variables unset still have no host method here.

It is the only place outside core that may read identity headers: the
boundary test (`tests/server/identity/cookie-guard.test.ts`) fails on gateway
identity headers (`cf-access-*`, `x-goog-iap-jwt-assertion`,
`x-forwarded-user`, ...) and on reads of an incoming `Authorization` header
anywhere else, including the rest of `lib/server/identity/`. Code here uses
the public surface (`@/lib/server/identity`), not the resolution internals.

Register the methods from `instrumentation.ts` with
`configureOwnerAuthentication({ methods: [...] })`.

The middleware mints the anonymous owner cookie on page navigations
(`anonymousOwnerForNavigation` in `middleware.ts`, see `../navigation.ts`); it
cannot see these registrations. Set `OWNER_ANONYMOUS_PREMINT=false` only when
your registration sets `anonymousFallback: false` (the server warns at startup
when it does and pre-minting is on). With the anonymous fallback on, keep it,
and skip it there only for the requests your methods authenticate.
