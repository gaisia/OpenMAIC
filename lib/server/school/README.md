# 学校身份、班级与发课（M1 + M2）

学校统一登录经网关 JWT 进入宿主 `configureOwnerAuthentication`。未设置任何 `SCHOOL_JWT_*` 时，本目录不注册，进程保持上游的匿名 / 单用户 / 共享团队行为。没有自建密码登录。

M2 在同一套身份上增加发布、分配和学生读校验。M3（测验成绩册）不在这里。管理台和发课面板的前端也不在这里；下面的 HTTP API 即那些界面会调用的接口。

学校模式打开后，公开分享链是关掉的，没有环境变量可以再打开：

```text
school.share.publicLink = disabled
school.share.requirePublishedAndAssigned = true
school.share.entryByAssignmentOnly = true
school.share.inviteCode = disabled
```

复制 `/classroom/{stageId}` 不会扩大权限。学生能读，当且仅当：

```text
canRead = 已发布 AND（当前班籍命中整班分配 OR 指定到本人）AND 已登录
```

整班分配按当前班籍计算，后进班自动获得，移出班且没有指定分配则失去。未发布可以先写入分配，对学生不生效，发布后立刻生效。取消发布保留分配，学生立即不可读；再次发布后恢复，不必重新分配。教师（课程所有者）和管理员仍可读草稿。指定学生必须已是该教师所授班里的学生。管理员可以查看分配，不能代教师发布或分配。归档不会清掉已有成员，所以已经整班分配的课对仍在班里的学生继续可读；不能再把课分配给已归档的班。

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

### 发课与分配（M2）

发布写入上游 `stage_meta.is_public` / `published_at`，与 `POST /api/stages/<id>/publish` 同一对字段，并同样要求 principal 带 `course:publish`。学生没有这个角色。分配存在二开表 `school_course_class_assignments` 与 `school_course_student_assignments`，不要求课程已发布。

| 方法 | 路径 | 谁 |
| --- | --- | --- |
| POST | `/api/school/courses/<stageId>/publish` | 课程所有者，且为教师或管理员（带 `course:publish`）。已发布则原样返回 |
| POST | `/api/school/courses/<stageId>/unpublish` | 同上。分配保留 |
| GET | `/api/school/courses/<stageId>/assignments` | 课程所有者或管理员 |
| POST | `/api/school/courses/<stageId>/assignments/classes` | 所有者且为该班授课教师。体 `{ "classId" }`。已归档班 `409 CLASS_ARCHIVED` |
| DELETE | `/api/school/courses/<stageId>/assignments/classes/<classId>` | 课程所有者教师 |
| POST | `/api/school/courses/<stageId>/assignments/students` | 所有者教师。体 `{ "ownerIds": ["user:…"] }`，每人须是其所授班学生 |
| DELETE | `/api/school/courses/<stageId>/assignments/students/<ownerId>` | 课程所有者教师。`ownerId` 需 URL 编码 |
| GET | `/api/school/courses` | 学生。只返回 `canRead` 的课。教师请用 `GET /api/stages` |

学生调用发布或分配为 `403 ROLE_REQUIRED`。无权学习为 `403 COURSE_NOT_READABLE`（文案「无权学习该课程或课程未开放」）。课不存在为 `404 COURSE_NOT_FOUND`。

学校模式下，下列直链读走同一个 `canRead`，不只是从列表里藏掉：

- `GET /api/persistence/documents/<stageId>`（课堂加载课程文档的路径）及其 scene 读
- `GET /api/stage-meta/<stageId>`
- `GET /api/stages/<stageId>/status`（学校模式下改为必须登录；未开学校身份时仍是上游的匿名可读）
- `GET /api/classroom-media/<stageId>/...`

`GET /api/stages` 在学校模式下由 library 钩子过滤：学生只看到 `canRead` 的课，教师仍看自己的课。工作台的所有者写接口（`PUT/PATCH/DELETE /api/stages/<id>`）保持上游所有者隔离，学生不能借分配去改课。

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
| US-CS-01 发布与草稿预分配 | 未发布时整班分配对学生列表和直链均为拒绝；发布后无需再分配即可读；学生发布 `403`；重复发布不改 `publishedAt` | 教师 JWT 调发布，学生再调 `GET /api/school/courses` |
| US-CS-02 整班分配与后进班 | 班内学生可读，班外不可；后加入的学生自动可读；取消整班后立即不可读 | 把链接发给未分配同学，直链 `403` |
| US-CS-03 指定学生与并集 | 只指定 B 时 D 不可读；再加上整班后 D 可读；取消指定后若整班仍在则 B 仍可读，整班也取消后不可读 | |
| US-CS-04 取消发布优先 | 取消发布后学生不可读，分配查询仍能看到班级；再次发布后恢复 | |
| US-CS-05 直链不提权 | 未分配学生拿 stage id 调用读门为 `403 COURSE_NOT_READABLE`，不返回大纲 | 打开 `/classroom/<stageId>` 不应出现课堂内容（失败页属前端，本期 API 拒绝即可） |
| US-CS-06 未登录不能学 | 无 JWT 的「我的课程」为 `401`；匿名 principal 的直链门为 `401`。关掉 `SCHOOL_JWT_*` 时读门不介入，上游行为保留 | 不带 Authorization 调 `GET /api/stages/<id>/status` 为 `401` |
| US-CS-07 学生不能发课 | 学生发布、取消发布、分配均为 `403`；学生库列表不是「自己拥有的课」 | 学生导航里不出现发布按钮（前端本期不做） |
| US-CS-08 移班联动 | 只靠整班时移出班即不可读；另有指定时移出班仍可读 | 用 M1 的成员 DELETE 移人，再查「我的课程」 |

指定学生不在该教师所授班时为 `403 STUDENT_NOT_IN_TAUGHT_CLASS`。向已归档班分配为 `409`。管理员可 `GET` 分配，代为分配是 `403`。

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

教师令牌把 `roles` 换成 `['school:teacher']`，`sub` 换成该教师的稳定 id。发布与整班分配：

```text
curl -sS -X POST -H "Authorization: Bearer $TEACHER" \
  http://127.0.0.1:3000/api/school/courses/$STAGE/publish

curl -sS -X POST -H "Authorization: Bearer $TEACHER" -H 'content-type: application/json' \
  -d '{"classId":"cls_…"}' \
  http://127.0.0.1:3000/api/school/courses/$STAGE/assignments/classes
```

学生令牌查询自己的课，或直接打开文档（未发布或未分配时应为 403，而不是课程 JSON）：

```text
curl -sS -H "Authorization: Bearer $STUDENT" http://127.0.0.1:3000/api/school/courses

curl -sS -H "Authorization: Bearer $STUDENT" \
  http://127.0.0.1:3000/api/persistence/documents/$STAGE
```
