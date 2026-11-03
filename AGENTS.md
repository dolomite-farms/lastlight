# Last Light monorepo

The canonical guidance for agents lives in **[`CLAUDE.md`](./CLAUDE.md)** — start
there for workspace orientation (packages, dependency graph, commands), and follow
its links to the per-package `CLAUDE.md` files (the full dev guide is
[`apps/server/CLAUDE.md`](./apps/server/CLAUDE.md)).

`AGENTS.md` files in this repo are pointers to the co-located `CLAUDE.md`, which is
the single source of truth — they are never duplicated.

---

## Local deployment — this instance (operator-local; never commit or push upstream)

This checkout is also the **running Last Light factory** on the Mac Studio. This
section is the operator's and must not be committed or pushed to `nearform/lastlight`.
Deployment rules live in `instance/AGENTS.md` (read it first). The factory is
product-agnostic: no product-specific code, docs or patches in the engine or overlay.

**Where it lives**
- Project dir (compose project `lastlight`): `~/Projects/lastlight` (`~/lastlight` symlinks here)
- Deployment overlay: `instance/` (private repo `whoisgloom/lastlight-instance`, gitignored here)
- Secrets (mode 0600, never print): `instance/secrets/{.env,app.pem,admin-password.txt,.cli-token}`
- Public URL: `https://lastlight.owlvin.io` (dashboard `/admin`, webhook `/webhooks/github`); local `http://127.0.0.1:8644`

**Control it**
- `ll` (`~/.local/bin/ll`): admin-API client with a cached token. `ll GET '/workflow-runs?limit=5'`, `ll GET /workflows`,
  `ll POST /workflows/<name>/toggle`.
- GitHub App `last-light-owlvin` (App ID `5356269`); only repos in `instance/config.yaml` `managedRepos` are acted on.

**Stack** (the override must be loaded, or the wrong image runs)
```bash
docker compose -f apps/server/docker-compose.yml -f docker-compose.override.yml --project-directory . up -d agent
```
Tunnel ingress lives in `~/.cloudflared/config.yml`. Caddy is disabled in the override.

**Engine changes we carry** (generic only; re-apply after upstream pulls)
- `instance/patches/engine-*.patch`, `stale-base-retry.patch`, `failed-sandbox-keep.patch` via `instance/scripts/apply-*.sh`.
- Checkout edits: `apps/server/sandbox-base.Dockerfile` (baked CPython 3.12/3.13), dashboard colors
  (`apps/server/dashboard/src/{index.css,components/HomePage.tsx,components/FeedbackPage.tsx}`).
- Rebuild: `docker build -f apps/server/Dockerfile -t lastlight-agent:<tag> .`, then set the tag in the override.

**Backup:** `instance/scripts/backup-data.sh` runs nightly (launchd `io.owlvin.lastlight-backup`) to
`~/owlvin-state/lastlight-backups/`.

Get operator approval before any upstream issue or PR; never mention private products or paths upstream.
