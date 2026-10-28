# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A local web dashboard (Node 18+, Express, no build step, no framework on the front end) that manages a modded Valheim dedicated server (LinuxGSM + BepInEx + ValheimEnforcer) on a Linux VPS. It normally runs on the user's Windows PC and drives the VPS over SSH. It also has an optional Project Zomboid tab. [README.md](README.md) is the overview; [docs/](docs/) has a page per topic ([CONFIGURATION](docs/CONFIGURATION.md) for every config key, [GETTING_STARTED](docs/GETTING_STARTED.md) for bootstrapping a fresh VPS, [ARCHITECTURE](docs/ARCHITECTURE.md), [TESTING](docs/TESTING.md)).

## Commands

- Install and run: `npm install`, then `npm start` (= `node server.js`). Serves http://localhost:4173 (`guiPort`). Needs `config.json` (copy [config.example.json](config.example.json)).
- Windows launcher: [deploy/run-local.cmd](deploy/run-local.cmd) / [deploy/run-local.ps1](deploy/run-local.ps1).
- Reset the GUI login: `node set-password.js` (or delete `auth.json` and restart, which prints a new random password).
- Before every commit run all three:
  - `npm test`: unit tests (`node:test`, files in [test/](test/)). One file: `node --test test/modsets.test.js`. One test: add `--test-name-pattern "<name>"`.
  - `npm run lint`: ESLint for undefined and unused names. After moving code between files, this is what catches a missed import.
  - `npm run check`: syntax of every JS, shell and Python file, and fails on CRLF in a `.sh` (it would break on Linux).
  - `npm run test:py` (needs `pip install discord.py`): the Discord bot and code generator.
- The API and update-script tests (`test/api.test.js`, `test/scripts.test.js`) run the GUI in local mode with bash and symlink `node_modules`, so they fail on Windows without admin rights. CI runs everything on Ubuntu; on Windows, `test/server-boot.test.js` and the unit tests still run.
- `migration.js`, `modgraph.js`, `modsets.js` and `pzmodsets.js` are kept free of I/O so they can be unit-tested. `VGUI_MIGRATION_DIR` exists only to point migration scripts at a temp folder in tests.
- Nothing can be exercised end to end without a real VPS. Don't claim a VPS-side change works without saying it was only syntax-checked.
- Read [LESSONS_LEARNED.md](LESSONS_LEARNED.md) before non-trivial work, and add an entry whenever a bug or mistake is found.

## Architecture

**Backend layout.** [server.js](server.js) only loads the files in [src/](src/) and starts listening. Each file in `src/` is one feature and opens with a one-line summary. Four core files load first and never depend on a feature:
- [src/context.js](src/context.js): `config`, worlds, `ROOT` (the project folder; use it instead of `__dirname` in `src/`).
- [src/notify.js](src/notify.js): Discord webhook settings.
- [src/exec.js](src/exec.js): every way to run a command on the VPS.
- [src/app.js](src/app.js): the Express app, login, world selection, static files.

Feature files import core helpers by destructuring (`const { sshExec, shq } = require('./exec')`). Feature files use each other circularly, so they import each other as a whole and call through it (`const worldInfo = require('./world-info')`, then `worldInfo.getWorldInfo()`). Never destructure from a feature file: during a circular load its exports are still empty. Each file exports with `Object.assign(module.exports, {...})` at the end, never `module.exports = ...` (that breaks the object other files already hold). Nothing may call into another feature at load time, only inside functions. Routes register as each file loads, so their order differs from [server.js](server.js)'s list. That's safe because no two routes overlap. Keep it that way: a middleware that must run before some routes belongs in [src/app.js](src/app.js) (see the `/api/mods` one).

**Every action is a shell command on the VPS.** Use the helpers rather than building new execution paths:
- `sshExec(cmd)` runs a short command over one shared SSH connection with a channel limit. `sshExecStream`, `sshExecFollow` and `sshExecPlainStream` stream output to the browser (SSE or chunked).
- These live in [src/exec.js](src/exec.js). `mode: "local"` swaps the ssh2 `Client` for `LocalClient`/`LocalStream`, which spawn `/bin/bash -c` with the same event interface, so callers never branch on mode.
- `shq()` single-quotes any value interpolated into a command. `maybeSudo()` prefixes `sudo -n` unless already root. `asLgsmUser()` runs as the LinuxGSM account (`cd` into its home first, see the comment on why).
- Write responses with `safeWrite()`, because ssh2 can emit data after `exit` and a write after end crashes the process.

**Multi-world via a config proxy.** `config` is a `Proxy` that answers `paths`, `lgsmUser`, `lgsmServer`, `lgsmHome`, `worldName` and `connect` from the *current request's* world. The world is resolved by middleware (`?instance=` / `X-Instance` / `vg_instance` cookie, default `main`) and kept in `AsyncLocalStorage`. The `main` world comes from `config.json`. Extra worlds live in `instances.json`, each with its own `vhserver-<id>` account and all paths derived in `buildInstanceConfig`. Code outside a request sees `main`. Use `inWorld(id, fn)` to act on another world. Per-world VPS artifacts (cron files, wrappers, status files) get the `instSfx()` / `worldTag()` suffix.

**VPS scripts are templates.** Files in [vps-scripts/](vps-scripts/) are not run from here. The Setup tab installs them onto the VPS (`HELPER_SCRIPTS`, skipped when the sha256 is unchanged). `renderScriptTemplate()` fills `__NAME__` placeholders from `setupValues()` and refuses to install if one is left unfilled or a value has unsafe characters. Entries marked `verbatim` (`move-mod.py`, `generate-codes.py`) are copied as is. Editing a script here only changes the VPS after the user re-runs that Setup step. Cron schedules (backup, update check, health) are generated wrapper scripts in `/usr/local/bin` plus `/etc/cron.d` files written by [src/schedules.js](src/schedules.js) (`buildBackupWrapper` etc.). The GUI only reads them back, so they keep running when the GUI is off.

**Auth** ([auth.js](auth.js)) is installed before the static files and every `/api` route. It uses a scrypt hash in `auth.json`, a session cookie and rate limiting. Every state-changing request must be same-origin and carry an `X-VGUI: 1` header. [public/app.js](public/app.js) patches `window.fetch` to add it (and to redirect to login on 401), so `fetch` just works. An `XMLHttpRequest` (used for upload progress) must set the header itself.

**Front end**: [public/index.html](public/index.html) + [public/app.js](public/app.js) (~6k lines, plain JS, numbered sections: utilities, UI primitives, router, then one section per tab). Each section header lists the API endpoints it uses.

**Mod identity rules (easy to break).** ValheimEnforcer rewrites `Mods.yaml` from its own model on every restart, so GUI-only fields must go in the sidecar files `Mods.overrides.yaml` (keyed by GUID) and `Mods.installedFrom.yaml` (keyed by plugin folder, written on every install/update). They must never be written onto `Mods.yaml` entries. Package resolution order is: explicit override pin → installedFrom record → folder `Owner-Name` → exact folder/DLL-basename match → fuzzy name. Update checks use Hexium first and Thunderstore only when a mod isn't on Hexium. Deprecated packages are excluded everywhere. [docs/MODS_AND_ENFORCER.md](docs/MODS_AND_ENFORCER.md) explains why each rule exists.

**Local state files** in the project folder (all git-ignored): `config.json` and `auth.json` (secrets), `instances.json`, `notifications.json` (webhooks), `.cache/` (package lists, `pending-changes*.json` for the restart-required banner).

## Conventions

- Server control is Start/Stop only, never Restart. The world must be saved by a clean stop. Keep it that way in the UI and any new flows.
- Anything that stops the server (backup, restore, update) must bring it back on failure, and must back up before destructive steps (restore makes a `PRE-RESTORE-*` copy; updates run a backup first and abort if it fails).
- Config-file edits on the VPS make a `.bak.<timestamp>` copy first.
