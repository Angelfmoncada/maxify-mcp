# Architecture

Taskboard has three source folders with one rule between them: `shared` imports nothing from the other two,
`server` and `web` import from `shared`, and `server` and `web` never import each other.

```
web (React)  --HTTP /api-->  server (router, services, repositories)
     \                              /
      +------ shared (types, validation, errors) ------+
```

## Shared layer

`src/shared` holds the vocabulary of the application.

- `types.ts` defines `Task`, `User`, `Role`, `TaskStatus`, `TaskPriority` and the request and response shapes.
- `validation.ts` contains `validateTaskInput`, `validateTaskPatch`, `validateStatus` and the account validators.
  They throw `ValidationError`, which lists every broken field in `issues`. The web form runs the same
  `validateTaskInput` before it submits, so client and server never disagree about what a valid task is.
- `errors.ts` defines `AppError` and its subclasses. Each carries an `ErrorCode` and an HTTP status, and the
  router turns them into responses.
- `constants.ts` holds limits such as `MAX_TITLE_LENGTH`, `DEFAULT_PAGE_SIZE` and `DEFAULT_TOKEN_TTL_SECONDS`.
- `index.ts` is a barrel that re-exports everything with `export *`.

## Request lifecycle

1. `src/server/index.ts` adapts Node's `http` module: it parses the JSON body and calls `app.handle(request)`.
   Tests call `app.handle` directly, so no socket is needed.
2. `Router.handle` (`http/router.ts`) picks the first registered route whose method and path pattern match.
   Static routes such as `/tasks/export.csv` must therefore be registered before `/tasks/:id`.
3. Global and per-route middleware run outside-in. `requireAuth` verifies the bearer token and passes the
   identity on as `request.user`; `requireRole` checks that identity against the allowed roles.
4. The handler calls a service. Services own the business rules and throw `AppError` subclasses.
5. Any thrown error ends up in `errorResponse`, which maps `AppError` to its status and hides every other
   error behind an opaque 500.

## Authentication and authorization

Tokens are compact `header.payload.signature` strings signed with HMAC-SHA256 (`auth/token.ts`).
The payload carries `sub` (user id), `email`, `role`, `iat` and `exp`, both in seconds.

- `signToken` issues a token, `decodeToken` reads it without trusting it and `verifyToken` checks the signature
  and the expiry.
- `isExpired` decides expiry: a token is invalid from its `exp` second onwards, so a token with `exp = 1000` is
  rejected at 1000 s. The comparison converts the millisecond clock to whole seconds first.
- `requireAuth` answers 401 when the header is missing, malformed, signed with another secret or expired.
- The role lives inside the token. `PATCH /users/:id/role` therefore takes effect when the user signs in again.
- Passwords are hashed with scrypt and a random salt (`auth/password.ts`). Login returns the same 401 for an
  unknown email and a wrong password.
- The first account registered becomes the admin; later accounts are members.

Authorization for tasks is decided in two places. `requireRole('admin', 'member')` on the write routes rejects
viewers with 403 before the handler runs, and `canModify` in `tasks/service.ts` lets only the owner or an admin
change an existing task. `TaskService.getModifiable` applies that rule and builds the 403 message
("Only the owner or an admin can delete this task").

## Task lifecycle

Statuses are `todo`, `in_progress`, `in_review` and `done`. `tasks/transitions.ts` is the single source of
truth for allowed moves. `TaskService.updateStatus` calls `assertTransition`, so the rule applies to admins too.

| From          | Allowed targets                   |
| ------------- | --------------------------------- |
| `todo`        | `in_progress`                     |
| `in_progress` | `todo`, `in_review`, `done`       |
| `in_review`   | `in_progress`, `done`             |
| `done`        | `in_progress`                     |

Every successful create, update, status change and delete publishes an event on the `TaskEventBus`.

## Listing, filtering and export

`GET /tasks` parses the query string with `parseTaskFilter` and applies `filterTasks`, `sortTasks` and `paginate`
in that order (`queryTasks`). Pages hold `DEFAULT_PAGE_SIZE` (20) tasks unless `pageSize` is given, capped at
`MAX_PAGE_SIZE` (100). `GET /tasks/export.csv` serializes every task with `tasksToCsv`. The CSV escaping lives
in `lib/legacy-csv.cjs`, a CommonJS file that the ops team's nightly report script also requires, so
`tasks/export.ts` loads it through `createRequire`.

## Plugins

`plugins/loader.ts` loads built-in plugins by name from `plugins/builtin/<name>.ts`. The names come from the
`PLUGINS` environment variable. A plugin default-exports an object with a `setup(context)` function that
subscribes to the event bus and may return a teardown function.

## Web client

- `api/client.ts` wraps `fetch`, adds the bearer token and converts error responses to `ApiError`.
  The dev server proxies `/api/*` to the Node server and strips the prefix.
- `hooks/useAuth.tsx` keeps the signed-in user, stores the token in `localStorage` and exposes `canModify`,
  which mirrors the server rule so the UI only offers actions the server will accept.
- `hooks/useTasks.ts` loads a page of tasks, applies optimistic status changes and filters the visible tasks
  with the search box text split by `utils/tokenize.ts`.
- Components (`TaskList`, `TaskItem`, `TaskForm`, `StatusBadge`, `LoginForm`) are presentational and receive
  their callbacks from `App.tsx`.

## Legacy code

`src/legacy` contains the cookie-session login of the previous monolith. It is not imported by the server or the
client, has its own token helpers and is kept only until the old admin pages are migrated. New code must not use it.
