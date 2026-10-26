# Taskboard

Taskboard is a small team task board: an HTTP-style Node API with in-memory storage and a React client.
Users register, sign in with a bearer token and manage tasks that move through a fixed set of statuses.

This repository is the fixture used by the Maxify benchmarks. It is a self-contained, realistic
TypeScript project, not meant to be deployed.

## Layout

```
src/
  shared/    types, constants, errors and validation used by both server and client
  server/    API: http (router), auth, users, tasks, plugins, config
  web/       React client: components, hooks, API client, utils
  legacy/    old cookie-session login, no longer imported anywhere
test/        node:test suites for shared and server code
docs/        architecture notes
```

## Getting started

```bash
npm test          # node --test test/*.test.ts  (Node 22.18+, no build step)
npm start         # node src/server/index.ts
npm run typecheck # needs `npm install` first for the React type packages
```

The server runs TypeScript directly through Node's built-in type stripping, so server and shared code only
use erasable syntax: no enums, no namespaces, no constructor parameter properties, and relative imports always
spell out the `.ts` extension. The web client is bundled separately and may use the `@shared/*` path alias.

Configuration comes from environment variables:

| Variable            | Default                 | Meaning                                              |
| ------------------- | ----------------------- | ---------------------------------------------------- |
| `PORT`              | `3000`                  | Listening port                                       |
| `NODE_ENV`          | `development`           | `development`, `test` or `production`                |
| `TOKEN_SECRET`      | development-only secret | HMAC secret for bearer tokens; required in production |
| `TOKEN_TTL_SECONDS` | `3600`                  | Lifetime of an issued token                          |
| `PLUGINS`           | `audit-log`             | Comma-separated built-in plugins to load             |

## API

All routes except `/health`, `/auth/register` and `/auth/login` need an `Authorization: Bearer <token>` header.

| Method and path             | Who                | Description                                        |
| --------------------------- | ------------------ | -------------------------------------------------- |
| `GET /health`               | anyone             | Liveness probe                                     |
| `POST /auth/register`       | anyone             | Create an account; the first account is the admin  |
| `POST /auth/login`          | anyone             | Exchange credentials for a token                   |
| `GET /auth/me`              | signed-in users    | The current user                                   |
| `GET /users`                | admin              | All users                                          |
| `PATCH /users/:id/role`     | admin              | Change a user's role (applies at their next login) |
| `GET /tasks`                | signed-in users    | One page of tasks, with filters                    |
| `GET /tasks/export.csv`     | signed-in users    | Every task as CSV                                  |
| `GET /tasks/:id`            | signed-in users    | One task                                           |
| `POST /tasks`               | admin, member      | Create a task                                      |
| `PATCH /tasks/:id`          | owner or admin     | Change title, description, priority or due date    |
| `POST /tasks/:id/status`    | owner or admin     | Move a task to another status                      |
| `DELETE /tasks/:id`         | owner or admin     | Delete a task                                      |

`GET /tasks` accepts `status` (comma separated), `owner`, `q` (search), `overdue`, `sort`
(`createdAt`, `dueDate`, `priority`, `title`), `dir`, `page` and `pageSize`. Without `pageSize` a page holds 20 tasks.

Errors share one shape: `{ "error": { "code", "message", "details" } }` with the status codes 400 (validation),
401 (missing, invalid or expired token), 403 (not allowed), 404, 405 and 409 (invalid status move or duplicate email).

## Roles

| Role     | Read | Create tasks | Modify own tasks | Modify any task | Manage users |
| -------- | ---- | ------------ | ---------------- | --------------- | ------------ |
| `admin`  | yes  | yes          | yes              | yes             | yes          |
| `member` | yes  | yes          | yes              | no              | no           |
| `viewer` | yes  | no           | no               | no              | no           |

## Task statuses

Tasks start in `todo` and move through `in_progress` and `in_review` to `done`. Allowed moves are defined in
`src/server/tasks/transitions.ts`; `TaskService.updateStatus` rejects anything else with a 409. A finished task
can only be reopened into `in_progress`.

## Plugins

Plugins subscribe to task events (`task.created`, `task.updated`, `task.status_changed`, `task.deleted`).
Two ship with the server, `audit-log` and `slack-notify`, and the `PLUGINS` variable selects which are loaded at startup.
