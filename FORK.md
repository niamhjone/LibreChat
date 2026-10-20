# FORK.md

This is `jasonsims/LibreChat`, a fork of [`LibreChat-AI/LibreChat`](https://github.com/LibreChat-AI/LibreChat). It runs as a sample app that the [traffic-bots](https://github.com/pendo-io/traffic-bots) personas use, to generate realistic traffic for Pendo dev instances. It is a test site, not a real chat service.

This file records how the fork is maintained and every way it differs from upstream.

## Branches

| Branch   | Purpose                                                                                      |
| -------- | -------------------------------------------------------------------------------------------- |
| `main`   | Clean mirror of `upstream/main`. Fast-forward only. Never commit here, never merge into it.  |
| `deploy` | `main` plus this fork's changes. Default branch on GitHub and the Railway production branch. |

Upstream also has `dev` (where its PRs land) and `canary`. This fork ignores them: upstream's `main` is a fast-forward of `dev` cut at each release sync, so tracking `main` gets tested code without chasing every merge.

## Remotes

| Remote     | URL                      |
| ---------- | ------------------------ |
| `origin`   | `jasonsims/LibreChat`    |
| `upstream` | `LibreChat-AI/LibreChat` |

One-time setup in each clone:

```bash
git remote add upstream git@github.com:LibreChat-AI/LibreChat.git
git config rerere.enabled true                   # remember conflict resolutions between syncs
git branch -u upstream/main main                 # `git pull` on main reads upstream
git config branch.main.mergeOptions --ff-only    # and refuses anything but a fast-forward
git config branch.main.pushRemote origin         # `git push` on main updates the fork's mirror
gh repo set-default jasonsims/LibreChat          # gh would otherwise open PRs against upstream
```

## Syncing with upstream

Sync regularly (weekly or monthly). Small, frequent syncs are much easier than one large one.

```bash
git fetch upstream
git checkout main && git merge --ff-only upstream/main
git push origin main

git checkout -b sync/upstream-YYYY-MM deploy
git merge main
```

Open a PR from the `sync/*` branch into `deploy`, check that the Docker build passes, then merge. Railway deploys `deploy` on every push. After resolving conflicts, check the "Changes from upstream" table below and `grep -rn "FORK:"`.

Read upstream's `UPGRADING.md` for each release in the sync. Breaking config or env var changes show up there first, and some need a change in `.railway/railway.ts`.

## Rules for keeping the diff small

- Prefer configuration (Railway variables, `librechat.yaml`) over editing upstream files.
- Put new things in new files so they can't conflict.
- Don't reformat or refactor upstream files.
- Mark unavoidable edits to upstream code with a `// FORK:` comment so `grep -rn "FORK:"` finds them all. JSON can't hold comments, so list JSON edits in the table below.
- Contribute generic fixes upstream so they stop being this fork's burden.

## Claude Code instructions

`AGENTS.md` and everything under `.claude/skills/` belong to upstream. Do not edit them, because any change conflicts on the next sync. Fork-specific instructions live in `.claude/rules/fork.md`, which Claude Code loads alongside `AGENTS.md`. Upstream has no `.claude/rules/` directory and no `CLAUDE.md`, so neither conflicts.

Upstream's `.gitignore` ignores `/.claude/` and force-adds its skills. New files there need the same: `git add -f .claude/rules/<file>.md`. Don't edit `.gitignore` to un-ignore them.

## Changes from upstream

| Date       | Files                                          | Change | Why                                                                                                                                          |
| ---------- | ---------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-10-15 | `FORK.md`, `.claude/rules/fork.md`             | New    | Fork docs and Claude Code rules.                                                                                                             |
| 2026-10-15 | `.railway/railway.ts`, `.railway/package.json` | New    | Railway infrastructure as code: the app service and its MongoDB. `.dockerignore` already excludes dotfiles, so none of it reaches the image. |
| 2026-10-15 | `client/src/lib/pendo/`                        | New    | Novus by Pendo: one `initialize` with a URL transform that drops credential query parameters, plus `identify` and `clearSession`.            |
| 2026-10-15 | `client/index.html`                            | Edit   | Pendo install snippet, verbatim, and a listener that keeps a failed agent download from triggering the stale-asset reload.                   |
| 2026-10-15 | `client/src/main.jsx`                          | Edit   | Calls `initializePendo()` once per page load, before the first render.                                                                       |
| 2026-10-15 | `client/src/routes/index.tsx`                  | Edit   | Mounts `PendoIdentity` in `AuthLayout`, which identifies the signed-in user on every sign-in path.                                           |
| 2026-10-15 | `client/src/hooks/AuthContext.tsx`             | Edit   | `logout` calls `clearPendoSession()`, so the next sign-in is not tracked as the previous user.                                               |
| 2026-10-16 | `git grep -l "FORK: Haiku 5.5"`                | Edit   | Claude Haiku 5.5 support, with tests in three new `haiku.spec.ts` files. Upstream sends `budget_tokens`, which the API rejects with a 400.   |
| 2026-10-20 | `client/src/lib/pendo/track.ts`                | Edit   | Pendo agent analytics (`pendo.trackAgent`) for the agents chat route report under the agent ID Novus registered for it.                      |

Upstream's `.nvmrc` (Node `24.16.0`, the current LTS line and the version the Dockerfile builds on) is used as is. Don't add a fork-specific one.

## Pendo Track Events

The client sends Pendo Track Events (`pendo.track`) for the product actions the personas exercise. The app does not load Pendo itself: when a deployment installs the Pendo snippet, `window.pendo` exists and the events flow; without it every call is a no-op.

- `client/src/lib/pendo.ts` (new, tested by `client/src/lib/pendo.spec.ts`) lists every event name exactly as registered in Pendo (Pendo matches them verbatim, so never rename one) and wraps the agent: it never throws, drops unset properties, caps strings and trims trailing properties to Pendo's 512-byte limit, so call sites list their properties most important first.
- `packages/data-provider/src/react-query/pendo.ts` (new) is the same guard for the two events sent from shared React Query hooks in `react-query-service.ts`, `tool_credentials_updated` and `endpoint_api_key_saved`.
- Every other changed file is an upstream call site. Each call carries a `// FORK:` comment naming Pendo, so `grep -rln "FORK:" client/src packages/data-provider/src` lists the files and `grep -rn` the calls; the supporting edits (the `~/lib/pendo` import, callback parameters, hook dependency lists) sit next to them. `Nav/SettingsTabs/ApiKeys/Create.tsx` and `Nav/SettingsTabs/Data/ImportConversations.tsx` also carry the Tailwind class order and import order their formatters required once the files changed.
- No event carries message or prompt text, file names, keys, tokens, email addresses or a share link's `shareId`.

When a sync conflicts in one of those files, take upstream's version and re-apply the marked lines. A call that is dropped only loses its event.

## Deployment

- Host: Railway, project `librechat` in the Hobby workspace, defined in `.railway/railway.ts` (Railway infrastructure as code; `railway.json` config-as-code is deprecated and stops being read on 2026-12-01).
- Needs a paid plan. The Free and Trial plans cap a service at about 0.5 GB of memory (LibreChat peaks near that while idle) and a volume at 500 MB, which can't be resized. With that little disk Mongo refuses to build indexes, and LibreChat exits at startup.
- App sleeping is off for both services, so bots don't wait on a cold start.
- Services:
  - `librechat`: built from this repo's `Dockerfile` on branch `deploy`. Health check `GET /health`. `PORT` is pinned to `3080` (the Dockerfile's `EXPOSE`), and the image sets `HOST=0.0.0.0`.
  - `mongo`: Railway's MongoDB 8 with the 5 GB volume `mongo-volume` at `/data/db`. Mongo needs at least 500 MB free on it to build indexes. Volumes can grow online but never shrink. `MONGO_URI` references its `MONGO_URL`, which has no database name, so data lives in Mongo's default `test` database.
- Not deployed: Meilisearch (`SEARCH=false`, so conversation search is off), the RAG API (file chat is off), Redis (single instance, in-memory caches).
- AI provider: Anthropic only, restricted by `ANTHROPIC_MODELS` to keep bot traffic cheap. `claude-haiku-5-5` is listed first, so it is the default; `claude-haiku-4-5`, `claude-sonnet-5-5` and `claude-opus-5-5` are listed for comparison testing. Other endpoints stay hidden because their keys are unset. The Agents endpoint is on by default and uses the same key.
- `librechat.yaml` is not used. LibreChat logs that it's missing and runs on defaults. To add one, commit it under a fork-owned path and set `CONFIG_PATH`.

### First-time setup

```bash
brew install railway        # CLI 5.42.1 or newer runs the IaC engine
railway login
cd .railway && npm ci && cd ..
railway init --name librechat   # or `railway link` to an existing project
railway config plan
railway config apply
```

Then set the values `railway.ts` keeps out of source (`preserve()`), and give the app a public domain:

```bash
railway variable set --service librechat \
  "JWT_SECRET=$(openssl rand -hex 32)" \
  "JWT_REFRESH_SECRET=$(openssl rand -hex 32)" \
  "CREDS_KEY=$(openssl rand -hex 32)" \
  "CREDS_IV=$(openssl rand -hex 16)" \
  "ANTHROPIC_API_KEY=sk-ant-..."
railway domain --service librechat --port 3080
```

`CREDS_KEY` must be 64 hex characters and `CREDS_IV` 32. Don't rotate them; they encrypt stored user credentials. Rotating either JWT secret signs everyone out, bots included.

After generating the domain, run `railway config plan` again and check that it doesn't plan to delete it. If it does, `railway config pull` shows how Railway records the domain; copy that into `railway.ts`.

### Changing infrastructure

Edit `.railway/railway.ts`, run `railway config plan`, review it, then `railway config apply`. Investigate any planned delete before applying; deleting the `mongo` service deletes the data.

## Authentication

Sign-in is LibreChat's built-in email and password login. Social login, OpenID, LDAP and SAML stay off, so no Google OAuth app (and no IT approval) is needed. Sign-up is open and email verification is off: with no `EMAIL_*` settings, new accounts are marked verified at registration.

The first account ever registered becomes the ADMIN. Register your own account through the UI before the first bot run.

Bots sign in without going through the UI:

1. Check for a session: `POST /api/auth/refresh`. A JSON body with a `token` means the `refreshToken` cookie is valid; anything else means sign in.
2. Sign in: `POST /api/auth/login` with JSON `{ "email", "password" }`. The response sets an httpOnly `refreshToken` cookie (SameSite=Strict, 7 days by default), which the app exchanges for an access token on every page load. A failed sign-in returns `404` with `{ "message": "Email does not exist." }` or `{ "message": "Incorrect password." }`.
3. Create the account once: `POST /api/auth/register` with JSON `{ "name", "username", "email", "password", "confirm_password" }`. `name` needs 3 to 80 characters and the password at least 8. It returns `200` both when it creates the account and when the email already exists (on purpose, to hide which emails exist), so sign in afterwards to find out.

`/api/auth/login` only accepts requests from the site's own origin. Run these calls with `fetch` inside a page on the site (for example after loading `/robots.txt`, which doesn't boot the app), or send an `Origin` header that matches the site URL.

Rate limits apply per IP: 7 logins per 5 minutes (`LOGIN_MAX`, `LOGIN_WINDOW`) and 5 registrations per hour (`REGISTER_MAX`, `REGISTER_WINDOW`). Repeated violations get the IP temporarily banned (`BAN_VIOLATIONS`). Raise those limits with Railway variables if many personas share one IP.
