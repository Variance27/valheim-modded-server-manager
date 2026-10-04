# VPS helper scripts

The `vps-scripts/` folder holds scripts that run **on the VPS**. The GUI uploads them over SSH, and you can also run them by hand.

## Installed by the Setup tab

| Script | Installed to | Purpose |
| --- | --- | --- |
| `backup-valheim.sh` | `<scriptsDir>` | Stop, archive, restart, verify, prune, optional cloud upload. |
| `check-valheim-update.sh` | `<scriptsDir>` | Asks Steam for the latest public build and compares it with the installed one. Read-only; safe to run any time. Optional auto-apply with `AUTO_APPLY_UPDATE=true` in `valheim-notify.conf`. |
| `update-valheim.sh` | `<scriptsDir>` | Backup gate, then LinuxGSM's own `update`, then start. Aborts if the backup fails. |
| `discord-codes-bot.py` | `/opt/valheim-gui-bot/` | The optional `/codes` bot. Installed by Settings, Discord bot, not by Setup step 7. See [Discord bot](DISCORD_BOT.md). |
| `move-mod.py` | `<scriptsDir>` | Moves a mod between ValheimEnforcer categories, deletes entries, manages the sidecar files. |
| `generate-codes.py` | `<scriptsDir>` | Builds Gale profile codes from the installed mods. |

`<scriptsDir>` defaults to `/home/<game account>/scripts`.

## Used only by Setup

| Script | Step | Purpose |
| --- | --- | --- |
| `setup-prepare.sh` | 1 | Checks for Ubuntu or Debian, creates the game account, installs the packages LinuxGSM needs, downloads LinuxGSM. |
| `setup-install-server.sh` | 2 | Runs LinuxGSM's `auto-install` (or `validate` if the server files already exist) and checks that the server and its config files exist. |

## Templates

The scripts in this repo contain placeholders such as `__LGSM_USER__`, `__LGSM_HOME__`, `__SERVER_DIR__` and `__BACKUP_DIR__`. The GUI fills them in when it installs a script (`renderScriptTemplate` in `server.js`). **Do not copy the repo version straight to a server.** If you see `__LGSM_HOME__` in an error message, an unrendered template reached the VPS: run Setup step 7 again, which re-renders and installs the scripts.

Step 7 compares checksums. A script that already exists and differs is kept as `<name>.bak.<timestamp>` before being replaced, so you can delete those backups once the new scripts work.

## Python dependencies

`move-mod.py` needs `ruamel.yaml` (round-trip mode, so Enforcer's header comments survive edits); step 7 installs it (`apt install python3-ruamel.yaml`, falling back to `pip3`). `generate-codes.py` needs PyYAML, which Ubuntu and Debian normally ship as `python3-yaml`; if it is missing, run `sudo apt install python3-yaml`.

## Running a script by hand

```bash
sudo -u vhserver /home/vhserver/scripts/check-valheim-update.sh
sudo /home/vhserver/scripts/backup-valheim.sh
python3 /home/vhserver/scripts/generate-codes.py \
  /home/vhserver/serverfiles/BepInEx/config/ValheimEnforcer/Mods.yaml \
  --plugins-dir /home/vhserver/serverfiles/BepInEx/plugins --dry-run
```

`generate-codes.py` options: `--mode player|admin|both`, `--community valheim`, `--profile-name <label>`, `--dry-run` (builds without uploading).
