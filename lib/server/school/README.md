# 学校身份与班级（M1）

学校统一登录经网关 JWT 进入宿主 `configureOwnerAuthentication`。未设置任何 `SCHOOL_JWT_*` 时，本目录不注册，进程保持上游的匿名 / 单用户 / 共享团队行为。没有自建密码登录。

M2（发布、分配、`canRead`）和 M3（测验成绩册）不在这里。管理台前端也不在这里；下面的 HTTP API 即管理台与教师花名册会调用的接口。

## 配置网关

在 `.env.local`（Compose 会覆盖 `docker-compose.defaults.env`）中：

```text
OWNER_SINGLE_USER=false
OWNER_ANONYMOUS_PREMINT=false
SCHOOL_JWT_ISSUER=https://idp.example/
SCHOOL_JWT_AUDIENCE=openmaic
```

密钥二选一：

- `SCHOOL_JWT_SECRET`：网关与本服务共享的 HS256 密钥，至少 32 字符。
- `SCHOOL_JWT_JWKS_URL`：身份源的 JWKS（RS256 / ES256）。这是 hosting 文档里的配方：oauth2-proxy 把 IdP 的 id token 放进 `Authorization: Bearer`，Cloudflare Access 用头 `cf-access-jwt-assertion`，Google IAP 用 `x-goog-iap-jwt-assertion`。后两者把 `SCHOOL_JWT_HEADER` 设成该头名，值是原始 JWT，不是 Bearer 方案。

不要设置 `PERSISTENCE_SHARED_OWNER_ID`。`ACCESS_CODE` 可以继续当站点门禁，它不授予教师或管理员。

`sub` 会存成 `ownerId = user:<sub>`，之后不能改。角色声明默认依次看 `school_roles`、`roles`、`groups`（可用 `SCHOOL_JWT_ROLES_CLAIM` 指定）。认这些字符串：`admin` / `teacher` / `student`，或 `school:admin` / `school:teacher` / `school:student`。教师和管理员的 principal 带 `course:publish`，学生没有。`teacher` 与 `student` 不能同时出现。

启动时若开了学校身份但仍是 `OWNER_SINGLE_USER=true` 或匿名 cookie 预铸造，进程拒绝启动。

### 角色以哪边为准

- 用户还没被管理员改过角色时，每次登录按 JWT 声明写入绑定。
- `PUT /api/school/users/<ownerId>/roles` 把该用户标成「已托管」。从下一请求起以数据库为准，JWT 里的旧角色不再覆盖。
- 第一位管理员：其 JWT 带 `admin`（或 `school:admin`），首次登录即成为管理员。

## API

均需学校身份与 `DATABASE_URL`。未登录 `401 INVALID_CREDENTIAL`。错误体为 `{ "error": { "code", "message" } }`。

| 方法 | 路径 | 谁 |
| --- | --- | --- |
| GET | `/api/school/users` | 管理员 |
| PUT | `/api/school/users/<ownerId>/roles` | 管理员。体 `{ "roles": ["teacher"] }`。`ownerId` 需 URL 编码（`user:abc` → `user%3Aabc`） |
| GET | `/api/school/classes` | 管理员看全部；教师只看自己任教的班 |
| POST | `/api/school/classes` | 仅管理员。体 `{ "name": "Class-1" }` |
| POST | `/api/school/classes/<id>/archive` | 仅管理员 |
| GET/POST | `/api/school/classes/<id>/teachers` | 查看：管理员或该班教师。指派：仅管理员，体 `{ "ownerId" }`，对方须已是教师 |
| DELETE | `/api/school/classes/<id>/teachers/<ownerId>` | 仅管理员 |
| GET/POST | `/api/school/classes/<id>/members` | 管理员或该班授课教师。加人时对方须已是学生 |
| DELETE | `/api/school/classes/<id>/members/<ownerId>` | 同上 |

学生建课被 `authorizeCreate` 拒绝，创建接口返回 `403 CREATE_REFUSED`，事务回滚。学生改教师的课仍走上游所有者隔离：非所有者写同一 stage 得到 **404**（不暴露课程是否存在），内容不变。本里程碑不改那些上游路由。

归档后的班不能再加人、移人或指派教师。同名未归档班冲突为 `409 CLASS_NAME_TAKEN`。

## 校验

自动测试（不需要数据库）：

```text
pnpm exec vitest run tests/server/school tests/server/identity/cookie-guard.test.ts tests/persistence/schema-migration-checksums.test.ts
```

对应产品故事：

| 故事 | 自动测试覆盖 | 手工补充 |
| --- | --- | --- |
| US-01 教师可建课，学生不可 | `authorizeSchoolCreate`：教师/管理员允许，学生拒绝（即 `403 CREATE_REFUSED`） | 教师 JWT 调创建课程成功；学生同一调用 `403`，库中无新课 |
| US-02 学生不能改教师的课 | 学生 principal 没有 `course:publish`；创建钩子拒绝学生 | 学生 `PUT`/`DELETE /api/stages/<教师的课>` 为 404，课程不变；教师本人可改 |
| US-04 教师管本班成员、不能建班 | 目录 API：教师加人/移出成功；学生加人 403；教师建班 403；仅管理员建班 | 移出后该生不再出现在花名册 |
| US-06 未登录 401；门禁不等于角色 | 无 JWT、坏签名、过期、错误 audience 均为 401；只带任意 cookie、无 JWT 也是 401 | 只通过 `ACCESS_CODE`、不带网关 JWT，不能调用教师 API |
| US-07 管理员建班并改角色 | 管理员建班、归档、指派教师；把仍持有学生声明的用户改成教师后，下一请求按教师鉴权（可列班、不可建班） | 用 IdP 改组之前，以数据库绑定为准 |

用共享密钥本地签发一枚管理员令牌（`jose` 已是依赖）：

```js
import { SignJWT } from 'jose';

const token = await new SignJWT({ roles: ['school:admin'] })
  .setProtectedHeader({ alg: 'HS256' })
  .setSubject('admin-1')
  .setIssuer(process.env.SCHOOL_JWT_ISSUER)
  .setAudience(process.env.SCHOOL_JWT_AUDIENCE)
  .setExpirationTime('1h')
  .sign(new TextEncoder().encode(process.env.SCHOOL_JWT_SECRET));
```

```text
curl -sS -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"name":"Class-1"}' http://127.0.0.1:3000/api/school/classes
```
