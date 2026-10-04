#!/usr/bin/env python3
"""
discord-codes-bot.py - a Discord slash command that runs generate-codes.py on the
VPS and posts the resulting Gale profile code(s) back to Discord.

Installed and managed from the GUI (Settings, Discord bot). It runs as its own
systemd service, so it does not need the GUI to be running.

Command (restricted to the allowed user/role IDs):
  /codes mode:<player|admin|both> [world:<world>] [public:<bool>] [dry_run:<bool>]

The list of worlds comes from the worlds file the GUI writes (BOT_WORLDS_FILE),
a JSON list of {"id", "label", "profileName", "modsYaml", "pluginsDir"}. It is
re-read on every command, so adding or deleting a world needs no bot restart.

Security notes:
  * Only users listed in DISCORD_ALLOWED_USER_IDS, or holding a role in
    DISCORD_ALLOWED_ROLE_IDS, can run anything. Everyone else gets a private refusal.
  * The ADMIN code reveals admin-only mods, so it is always sent privately
    (ephemeral: only the person who ran the command sees it). The PLAYER code is
    private by default; pass public:true to post it in the channel.
  * The world option only accepts ids from the worlds file, never free text.
"""
import asyncio
import json
import os
import re
import sys

import discord
from discord import app_commands

TOKEN = os.environ["DISCORD_BOT_TOKEN"]
GUILD_ID = os.environ.get("DISCORD_GUILD_ID")  # optional: instant command sync for one server
ALLOWED_USER_IDS = {int(x) for x in os.environ.get("DISCORD_ALLOWED_USER_IDS", "").split(",") if x.strip()}
ALLOWED_ROLE_IDS = {int(x) for x in os.environ.get("DISCORD_ALLOWED_ROLE_IDS", "").split(",") if x.strip()}
SCRIPT = os.environ["GENERATE_CODES_SCRIPT"]
WORLDS_FILE = os.environ["BOT_WORLDS_FILE"]
PYTHON = os.environ.get("PYTHON_BIN", "python3")
TIMEOUT_SECONDS = int(os.environ.get("GENERATE_TIMEOUT_SECONDS", "600"))

if not ALLOWED_USER_IDS and not ALLOWED_ROLE_IDS:
    sys.exit("Refusing to start: set DISCORD_ALLOWED_USER_IDS and/or DISCORD_ALLOWED_ROLE_IDS.")

intents = discord.Intents.none()  # slash commands need no privileged intents
intents.guilds = True  # caches roles so the role allowlist works
client = discord.Client(intents=intents)
tree = app_commands.CommandTree(client)
run_lock = asyncio.Lock()  # one generation at a time


def load_worlds():
    try:
        with open(WORLDS_FILE, encoding="utf-8") as f:
            data = json.load(f)
        return [w for w in data if isinstance(w, dict) and w.get("id") and w.get("modsYaml")]
    except (OSError, ValueError):
        return []


def is_allowed(interaction: discord.Interaction) -> bool:
    if interaction.user.id in ALLOWED_USER_IDS:
        return True
    raw_ids = {int(r) for r in (getattr(interaction.user, "_roles", None) or [])}
    if raw_ids & ALLOWED_ROLE_IDS:
        return True
    roles = getattr(interaction.user, "roles", []) or []
    return any(r.id in ALLOWED_ROLE_IDS for r in roles)


async def run_generate(world: dict, mode: str, dry_run: bool):
    cmd = [PYTHON, SCRIPT, world["modsYaml"], "--mode", mode]
    if world.get("pluginsDir"):
        cmd += ["--plugins-dir", world["pluginsDir"]]
    if world.get("profileName"):
        cmd += ["--profile-name", world["profileName"]]
    if dry_run:
        cmd.append("--dry-run")
    proc = await asyncio.create_subprocess_exec(*cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    try:
        out, err = await asyncio.wait_for(proc.communicate(), timeout=TIMEOUT_SECONDS)
    except asyncio.TimeoutError:
        proc.kill()
        return None, None, "timed out"
    return out.decode(errors="replace"), err.decode(errors="replace"), proc.returncode


def summarize_stderr(err: str) -> str:
    """Keep only the lines an admin needs to act on, not the whole progress log."""
    keep = [l.strip() for l in err.splitlines() if re.search(r"\[(WARNING|ERROR|AMBIGUOUS|warn)\]|rejected|Traceback|Error", l)]
    return "\n".join(keep[-15:])[:1500]


async def world_autocomplete(interaction: discord.Interaction, current: str):
    if not is_allowed(interaction):
        return []
    cur = current.lower()
    return [
        app_commands.Choice(name=str(w.get("label") or w["id"])[:100], value=str(w["id"]))
        for w in load_worlds()
        if cur in str(w.get("label") or w["id"]).lower()
    ][:25]


@tree.command(name="codes", description="Generate the Gale profile code(s) for a server's current mods")
@app_commands.describe(
    mode="Which code to generate",
    world="Which world (default: the first one)",
    public="Post the player code in the channel (admin code is always private)",
    dry_run="Resolve mods but don't upload a code",
)
@app_commands.choices(mode=[
    app_commands.Choice(name="player", value="player"),
    app_commands.Choice(name="admin", value="admin"),
    app_commands.Choice(name="both", value="both"),
])
@app_commands.autocomplete(world=world_autocomplete)
async def codes(interaction: discord.Interaction, mode: app_commands.Choice[str], world: str = "", public: bool = False, dry_run: bool = False):
    if not is_allowed(interaction):
        await interaction.response.send_message("You're not allowed to run this command.", ephemeral=True)
        return
    worlds = load_worlds()
    if not worlds:
        await interaction.response.send_message("No worlds are configured for this bot yet. Open the GUI, Settings, Discord bot, and press Refresh worlds.", ephemeral=True)
        return
    chosen = next((w for w in worlds if str(w["id"]) == world), None) if world else worlds[0]
    if chosen is None:
        await interaction.response.send_message("Unknown world. Pick one from the list.", ephemeral=True)
        return
    if not os.path.isfile(chosen["modsYaml"]):
        await interaction.response.send_message(f"{chosen.get('label') or chosen['id']} has no Mods.yaml yet. Finish its setup and start it once first.", ephemeral=True)
        return
    if run_lock.locked():
        await interaction.response.send_message("A code generation is already running. Try again in a minute.", ephemeral=True)
        return

    await interaction.response.defer(ephemeral=True, thinking=True)
    async with run_lock:
        out, err, rc = await run_generate(chosen, mode.value, dry_run)

    if rc == "timed out" or rc is None:
        await interaction.followup.send(f"Generation timed out after {TIMEOUT_SECONDS}s.", ephemeral=True)
        return

    notes = summarize_stderr(err or "")
    player = re.search(r"^PLAYER_CODE=(\S+)", out or "", re.M)
    admin = re.search(r"^ADMIN_CODE=(\S+)", out or "", re.M)

    if rc != 0 or (not dry_run and not (player or admin)):
        msg = f"Generation failed (exit {rc})."
        if notes:
            msg += f"\n```\n{notes}\n```"
        await interaction.followup.send(msg, ephemeral=True)
        return

    if dry_run:
        msg = "Dry run finished, nothing uploaded."
        if notes:
            msg += f"\n```\n{notes}\n```"
        await interaction.followup.send(msg, ephemeral=True)
        return

    label = chosen.get("profileName") or chosen.get("label") or chosen["id"]
    lines = [f"**{label}**"]
    if player:
        lines.append(f"**Player code:** `{player.group(1)}`")
    if admin:
        lines.append(f"**Admin code:** `{admin.group(1)}`")
    lines.append("Gale: File > Import profile > From code.")
    if notes:
        lines.append(f"\nWarnings worth a look:\n```\n{notes}\n```")
    await interaction.followup.send("\n".join(lines), ephemeral=True)

    # Optional public post of the PLAYER code only.
    if public and player and interaction.channel is not None:
        await interaction.channel.send(f"**{label} player code:** `{player.group(1)}`\nGale: File > Import profile > From code.")


@client.event
async def on_ready():
    if GUILD_ID:
        guild = discord.Object(id=int(GUILD_ID))
        tree.copy_global_to(guild=guild)
        await tree.sync(guild=guild)
    else:
        await tree.sync()  # global commands can take up to an hour to appear
    print(f"Logged in as {client.user}: /codes ready", flush=True)


client.run(TOKEN)
