# Discord `/codes` bot (optional)

A small bot that lets people you trust type `/codes` in Discord and get the Gale profile code for a world, without opening the GUI. It is optional and off by default. A fresh VPS has no bot until you install it from **Settings, then Discord bot**.

This is separate from the [Discord webhooks](BACKUPS_AND_SCHEDULING.md#discord). Webhooks only post messages. The bot answers commands, so it needs a Discord application, a bot token and an always-on service.

## What you get

```
/codes mode:<player|admin|both> [world:<world>] [public:<true|false>] [dry_run:<true|false>]
```

- **mode** picks the player code, the admin code (which also includes admin-only mods) or both.
- **world** picks which world. The list comes from the GUI and follows the worlds you have; if you leave it out, the first world (your main world) is used.
- **public** posts the player code in the channel. The admin code is always shown only to the person who ran the command.
- **dry_run** resolves the mods without uploading a code.

Only the Discord user IDs and role IDs you allow can run it. Everyone else gets a private refusal.

## Set it up

1. In the [Discord developer portal](https://discord.com/developers/applications) create a **New Application**.
2. On the **Bot** page press **Reset Token** and copy the token. Leave the privileged intents off.
3. On **OAuth2, URL Generator** tick the scopes `bot` and `applications.commands`, tick the permission **Send Messages**, open the link and add the bot to your server.
4. In Discord, turn on **Developer Mode** (Settings, Advanced). Right-click your server and choose **Copy Server ID**, then right-click your own name and choose **Copy User ID**.
5. In the GUI open **Settings, Discord bot**, paste the token and the IDs, and press **Install and start**.

The server ID is optional but recommended: with it, `/codes` appears in your server immediately. Without it Discord can take up to an hour to show a new global command.

## What the GUI installs on the VPS

| What | Where |
| --- | --- |
| Bot script, `generate-codes.py`, the worlds list | `/opt/valheim-gui-bot/` |
| `discord.py` in its own Python virtualenv | `/opt/valheim-gui-bot/venv/` |
| Token and allowed IDs | `/etc/valheim-gui-bot.env` (owned by root, mode 600) |
| The service | `/etc/systemd/system/valheim-codes-bot.service` |

Press **Refresh worlds** after renaming a world; adding or deleting a world updates the list by itself. **Restart**, **Stop**, **Start** and **View log** control the service. **Remove bot** stops it and deletes all of the above, including the saved token.

## Security

- The token is written only to the root-only env file on the VPS. The GUI never shows it again, and leaving the field empty keeps the saved one.
- The service runs as root so it can read every world's `Mods.yaml`, but it is sandboxed by systemd (`NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome=read-only`, `PrivateTmp`). It only ever runs `generate-codes.py` with arguments taken from a fixed list of worlds, never from text typed in Discord.
- Treat the token like a password. If it leaks, press **Reset Token** in the developer portal and paste the new one into the GUI.

## If you already run a bot by hand

If a service called `valheim-codes-bot` already exists on the VPS and the GUI did not create it, the GUI leaves it alone and will not install, control or remove it. Remove or rename your service on the VPS first if you want the GUI to manage the bot, otherwise two bots would fight over one token.

## Troubleshooting

- **The card says Stopped after install:** press **View log**. The usual causes are a wrong token ("Improper token") or the VPS being unable to reach `discord.com`.
- **`/codes` does not appear:** check the bot was added with the `applications.commands` scope, and that the server ID is right. Without a server ID wait up to an hour.
- **"No Mods.yaml yet":** that world has not finished setup, or ValheimEnforcer has not run once. Start the world and try again.
