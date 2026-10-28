# Lessons learned

Mistakes and near-misses found while working on this project, so they are not repeated.
Add an entry whenever a bug or mistake is found: what happened, why, and the rule that prevents it.

## Line endings: shell scripts must stay LF

- **What:** Git on this Windows PC converts line endings to CRLF. Files in `vps-scripts/` are read
  from disk and uploaded to the VPS byte for byte, and a CRLF shell script fails on Linux with
  `$'\r': command not found`.
- **Rule:** `.gitattributes` forces LF (`* text=auto eol=lf`). `npm run check` fails on any `.sh`
  with a CR in it. Never remove either.

## Node 22+: `node --test <folder>` does not work

- **What:** `node --test test/` tried to load the folder as a module (`MODULE_NOT_FOUND`).
- **Rule:** use plain `node --test` (it finds `test/**/*.test.js`) or pass explicit files. That is
  what `npm test` does.

## Tests that would pass on an empty function

- **What:** the migration test extracts the `safe_listing` bash function and checks it rejects
  bad archives. If extraction silently produced nothing, bash fails with "command not found", so
  every "should be rejected" assertion would still pass.
- **Rule:** every negative test needs a positive partner that proves the code under test actually
  ran (here: "accepts a normal archive").

## A checker must be proven to catch failures

- **What:** a syntax checker that quietly skips a file type looks the same as one that passes.
- **Rule:** after writing or changing `scripts/check.js`, feed it one broken file of each type
  and confirm it fails. Missing tools (bash, python) are reported, never silently skipped.

## Deleting files in a folder without version control

- **What:** the cleanup deleted `Claude outputs/`, cached package lists and a PDF before the
  project was under git, so it can't be undone.
- **Rule:** before deleting anything, check `git status`. If the folder isn't a repo, list what
  will go and get explicit confirmation.

## Removing a feature means removing its references everywhere

- **What:** after rclone was removed, the README still mentioned scripts and settings that no
  longer existed (`generate-player-code.sh`, `paths.generatePlayerCodeScript`,
  `deploy/README-DEPLOY.md`).
- **Rule:** after removing a feature, grep the whole project (code, README, docs/,
  CLAUDE.md) for its names and fix every hit.

## Scripts on the VPS do not update themselves

- **What:** editing `vps-scripts/backup-valheim.sh` here changes nothing on a running server.
- **Rule:** when a VPS script changes, say so in the change summary and tell the user to re-run
  the matching Setup step.

## Finding unused code: check spread and property use

- **What:** a quick "defined but never used" scan flagged `healthFiles` and `parseWorldModifiers`,
  but both are called as `...healthFiles(...)`. The regex treated `...` as a property access.
- **Rule:** confirm each candidate with a plain grep before deleting it.

## `/tmp` means different folders to Git Bash and to Node on Windows

- **What:** a file written to `/tmp` from Git Bash was not found by Node (`C:\tmp\...`).
- **Rule:** use the session scratchpad with a Windows-style path (or `cygpath -w`) for any file
  passed between bash and Node.

## "Not found" must not look like a pass

- **What:** an order check compared `findIndex` results. The middleware wasn't found (-1), and
  -1 < any index printed "OK".
- **Rule:** check that each lookup found something before comparing. Prefer a plain `grep -n`
  that shows the actual lines.

## An impossible result means the check is broken

- **What:** a script reported 0 uses of functions inside the very file that defines them. Regex
  escaping got mangled between bash quotes and a `node -e` string.
- **Rule:** sanity-check any scan against one case you already know the answer to. Avoid regexes
  inside `node -e '...'` in bash; use grep, or write a script file.

## Startup waits in tests must settle on failure

- **What:** the boot test polled for the server's "running" line in a loop. When the server
  crashed, the loop never stopped and the test hung instead of failing.
- **Rule:** wait with one promise that settles on success, process exit or timeout, and clears
  its timer either way.

## Windows can't delete a running process's working folder

- **What:** test cleanup failed with EPERM because the killed server hadn't exited yet.
- **Rule:** wait for the child's `exit` event before deleting its folder.

## Don't chain "break a file, run, restore" in one command

- **What:** a probe that edited `src/settings.js`, ran a test, then restored the file was moved to
  the background when the test hung. The restore never ran, and the file stayed broken.
- **Rule:** restore in a separate step (or with `trap ... EXIT`). Check the file is clean
  afterwards (`git diff`, or grep for the probe).

## Circular requires between feature files (src/)

- **What:** proven with a probe: reading another feature's export at load time crashes with
  `Cannot read properties of undefined`, because that file is still half-loaded.
- **Rule:** see CLAUDE.md "Backend layout". Import features as a namespace and use them only
  inside functions. Export with `Object.assign(module.exports, ...)`. The boot test catches
  violations.

## Lint each file with its own environment

- **What:** linting `public/app.js` with Node globals produced 210 false errors (`document`,
  `location`...).
- **Rule:** browser and server code have separate blocks in `eslint.config.js`. Top-level
  browser functions are used from `onclick` in HTML, so only unused locals are reported there.
