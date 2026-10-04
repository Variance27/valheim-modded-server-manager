# Configuration

The GUI reads `config.json` next to `server.js`. Copy `config.example.json` to start. It holds your VPS password in plain text if you use one, so **never commit or share it** (it is in `.gitignore`). Everything is optional except the SSH details, unless you run in local mode.

A fresh server needs only the `ssh` block (plus, optionally, `guiPort` and `publicHost`). The GUI derives every path from LinuxGSM's standard layout, so you do not need a `paths` block unless your install differs.

## Connection and GUI

| Key | Default | Meaning |
| --- | --- | --- |
| `ssh.host`, `ssh.port` | none, `22` | How to reach the VPS. |
| `ssh.username` | none | Required. Use `root`, or a sudo-capable user together with a key (privileged commands then use `sudo -n`). |
| `ssh.password` | none | Password login. Prefer a key. |
| `ssh.privateKeyPath`, `ssh.passphrase` | none | Key login. |
| `mode` | ssh | Set `"local"` when the GUI runs on the VPS itself. No SSH is used. |
| `guiPort` | `4173` | Port the dashboard listens on. |
| `bindHost` | `127.0.0.1` | Interface the dashboard listens on. Keep it on localhost. |
| `guiUser` | `admin` | Login user name. The password hash lives in `auth.json`. |
| `trustProxy` | `false` | Set `true` when the GUI is behind an HTTPS tunnel or reverse proxy. |
| `publicHost` | none | Your VPS public IP or host, shown on the Dashboard for players. |

## The game server

| Key | Default | Meaning |
| --- | --- | --- |
| `lgsmUser` | `vhserver` | Linux account the game runs as. |
| `lgsmServer` | `vhserver` | LinuxGSM instance name. |
| `lgsmHome` | `/home/<lgsmUser>` | Where LinuxGSM lives. |
| `scriptsDir` | `<lgsmHome>/scripts` | Where Setup installs the helper scripts. |
| `worldName` | read from LinuxGSM | Normally leave it out. The GUI reads `worldname` from LinuxGSM's settings and shows "Valheim" until the world exists. Set it only to pin a different name. |
| `connect.port` | `2456` | Game port shown to players. |
| `thunderstoreCommunity` | `valheim` | Community slug used for Thunderstore and Hexium. |

## Discord

| Key | Meaning |
| --- | --- |
| `discordWebhookUrl` | Channel for the Mods tab's "Notify Discord" summaries. |
| `discordStatusWebhookUrl` | Channel for the cron jobs: backup failures, "server restarted after backup", update available. Falls back to `discordWebhookUrl`. |

Webhook URLs are secrets. Anyone who has one can post to the channel, so regenerate it if it leaks. If you change a webhook or script path, re-save the schedules so the wrapper scripts are regenerated.

## Paths (advanced)

Every `paths.*` value you leave out is derived from `lgsmHome`. Anything you set wins.

| Key | Meaning |
| --- | --- |
| `paths.pluginsDir`, `paths.disabledModsDir` | BepInEx `plugins` folder, and a folder outside it where Disable moves mods. |
| `paths.bepinexConfigDir` | Mod config folder (default: `config` next to `pluginsDir`). |
| `paths.enforcerYaml` | ValheimEnforcer's `Mods.yaml`. |
| `paths.moveModScript`, `paths.generateCodesScript` | The Mods-tab helper scripts. |
| `paths.logFile`, `paths.consoleLog` | `BepInEx/LogOutput.log` and the LinuxGSM console log. |
| `paths.backupScript`, `paths.backupDir`, `paths.worldDir`, `paths.listDir` | Backup script, where archives go, the Valheim data parent folder, and the folder holding `adminlist.txt` and friends. |
| `paths.checkUpdateScript`, `paths.applyUpdateScript` | Server update scripts. |
| `paths.lgsmScript`, `paths.commonCfgPath` | The LinuxGSM `vhserver` script and `config-lgsm/vhserver/common.cfg`. |
| `paths.valheimServerDir` | Server install root. |
| `paths.cronDir`, `scriptDir`, `logDir`, `lockDir`, `stateDir` | Where cron files, wrapper scripts, status logs, locks and state files go on the VPS (defaults `/etc/cron.d`, `/usr/local/bin`, `/var/log`, `/var/lock`, `/var/lib`). |

## Project Zomboid (optional)

A `zomboid` block enables an extra tab for a Project Zomboid server on the same VPS. It uses the same connection as Valheim. See the comments at the top of the Zomboid section in `server.js` for its keys.

## Files the GUI creates

| File | Purpose |
| --- | --- |
| `auth.json` | The GUI login (scrypt hash). Delete it and restart to get a new random password. |
| `instances.json` | The list of extra worlds. `config.json` is never rewritten. |
| `.cache/` | Caches and the pending-changes lists behind the restart-required banner. |

All three are in `.gitignore`.
