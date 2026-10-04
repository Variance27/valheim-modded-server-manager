# Contributing

Thanks for helping. Issues and pull requests are welcome.

## Reporting a bug

Open an issue and include:

- what you did (which tab or Setup step) and what you expected;
- the exact error text from the page or the step's output box;
- your OS on the VPS, Node version on the GUI machine, and whether the GUI runs over SSH or locally;
- relevant lines from `BepInEx/LogOutput.log` or the console log.

**Remove passwords, webhook URLs, IP addresses and SteamIDs before posting.** For anything security related, follow [SECURITY.md](SECURITY.md) instead of opening a public issue.

## Development setup

```bash
git clone https://github.com/Variance27/valheim-modded-server-manager.git
cd valheim-modded-server-manager
npm install
cp config.example.json config.json   # point it at a throwaway VPS, or use "mode": "local"
npm start
```

Use a **throwaway VPS or VM** when working on Setup, backups, restore or world features. These run as root and change real files.

Run the checks before you open a pull request:

```bash
npm run check
npm test                                      # GUI, login, webhooks, worlds, script syntax (no VPS needed)
pip install discord.py && npm run test:py     # helper scripts and the Discord bot
```

The tests start a throwaway copy of the GUI in local mode inside a temp folder, so they never touch your own `config.json`, `auth.json` or `instances.json`. They do not need a VPS. Add a test with every behavior change you can cover that way.

## Guidelines

- Keep it dependency-light and build-free: plain JavaScript in `public/`, one Express file on the server.
- Every file the GUI changes on the VPS gets a `.bak.<timestamp>` copy first, and destructive actions need an explicit confirmation.
- Code that runs outside a request (stream callbacks, timers) must capture the world id up front; see [Architecture](docs/ARCHITECTURE.md#worlds).
- Do not hard-code a server name, world name, path or IP. Derive it from the config or the LinuxGSM settings.
- Update the docs in the same pull request as the behavior change.
- Never commit `config.json`, `auth.json`, `instances.json`, `.cache/`, or screenshots that show real addresses or names.

## Pull requests

Keep each pull request to one change, describe how you tested it (and on what OS), and note anything you could not test.
