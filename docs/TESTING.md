# Testing

## Automated

```
npm ci
npm test          # API and script tests, run in temporary directories
npm run test:py   # Discord bot logic and the Gale code generator
```

CI runs the same on every push. The tests use fake `systemctl`, `ufw` and Discord endpoints; they never contact Steam, Thunderstore or a real VPS.

## Needs a real VPS (not covered by the tests)

Please try these on a throwaway server and report what you see:

- [ ] A fresh Ubuntu/Debian VPS through all eight Setup steps against real Steam and Thunderstore.
- [ ] The Discord `/codes` bot installed from the GUI, with a real bot token, in one and in two worlds.
- [ ] Health alerts arriving in a real Discord channel after stopping the server with `vhserver stop` on the VPS (not from the GUI).
- [x] The GUI's update check (`check-valheim-update.sh`) was confirmed working on a real server after it stopped using Debian's `/usr/games/steamcmd` wrapper when that wrapper was broken. LinuxGSM's own `vhserver check-update` has not been re-checked since; see [Troubleshooting](TROUBLESHOOTING.md).
- [ ] Migration between two real VPSes: export, download, upload, import, then start the server and join. The scripts and the whole flow are tested in temp folders, but not across two machines.
- [ ] Firewalls other than `ufw` (for example `firewalld`) are not handled; open the ports yourself.
