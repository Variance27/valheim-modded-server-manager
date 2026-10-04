# Architecture

A short map for contributors.

## Overview

```
Browser  ──HTTP──▶  server.js (Node + Express)  ──SSH or local shell──▶  VPS
 public/                │                                              LinuxGSM, BepInEx,
 (plain JS, no build)   ├─ auth.js        login, sessions, CSRF         ValheimEnforcer,
                        ├─ config.json    connection + overrides        cron, helper scripts
                        └─ instances.json extra worlds
```

- **No build step and no framework.** `public/` is plain HTML, CSS and JavaScript served as-is. `server.js` is a single Express file organized in commented sections (`// ---- Backups ----` and so on).
- **The GUI does not hold state about the game.** It runs commands on the VPS and reads files there. Scheduled backups and update checks are real cron jobs on the VPS, so the GUI can be closed.
- **Dependencies:** `express`, `ssh2` and `js-yaml`. Nothing else is needed on the GUI machine.

## Execution modes

- **SSH mode** (default): short commands share one SSH connection; long jobs stream output over a dedicated exec channel as server-sent events. Commands over about 32 KiB do not fit in one exec, so scripts are uploaded in 12 KiB chunks. The `ssh2` stream can emit `exit` before its last `data`, so streams finish a moment after `exit`.
- **Local mode** (`"mode": "local"`): the GUI runs on the VPS and uses a local shell with the same code paths.

## Worlds

The main world comes from `config.json`. Extra worlds are entries in `instances.json`, each with an id, a game account `vhserver-<id>`, a port and its own paths.

- Each request is bound to one world through `AsyncLocalStorage`. The instance is chosen by `?instance=`, the `X-Instance` header, the `vg_instance` cookie, or the main world, in that order.
- The exported `config` object is a Proxy: reads of per-world keys (`paths`, `lgsmUser`, `lgsmServer`, `lgsmHome`, `worldName`, `connect`) return the selected world's values.
- Code that runs **outside** a request (stream callbacks, `res.on('finish')`, timers) has no request context, so it must capture the world id up front. Start the GUI with `VG_STRICT=1` to log any per-world read that happens outside a request.
- Caches, pending-change lists, cron file names and process checks are keyed per world.

## Setup tab

Eight steps, each an endpoint that streams output. Steps 1 and 2 run templated scripts from `vps-scripts/` as root. Step 5 edits `common.cfg` with a preview and a backup. Step 6 resolves ValheimEnforcer's dependency chain from Thunderstore or Hexium and installs it through the same installer the Mods tab uses. Step 7 renders and installs the helper scripts (`__TOKEN__` placeholders, checksum compare, `.bak.<timestamp>` of differing files). `/api/setup/status` powers the checklist.

## Mods

Package lists from Thunderstore and Hexium are cached in memory in a slimmed form. Matching an installed folder to a `Mods.yaml` entry and to a package follows the order described in [Mods and ValheimEnforcer](MODS_AND_ENFORCER.md). The GUI never writes extra fields into `Mods.yaml`; it keeps `Mods.overrides.yaml` and `Mods.installedFrom.yaml` beside it, because ValheimEnforcer rewrites `Mods.yaml` on every restart.

## Security model

`auth.js` provides a single admin login (scrypt hash in `auth.json`), HttpOnly SameSite=Strict session cookies, per-address rate limiting, and a same-origin plus `X-VGUI` header check on every state-changing request. The server binds to `127.0.0.1` by default. See [SECURITY.md](../SECURITY.md).

## Checks

```bash
npm run check          # syntax-checks server.js, auth.js, set-password.js and public/app.js
```

CI runs the same check plus `bash -n` on the shell scripts and a Python compile of the helpers. There is no automated end-to-end suite in the repository yet; contributions are welcome.
