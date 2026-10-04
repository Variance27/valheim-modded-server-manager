# Security

This tool holds a root-capable connection to your VPS, so treat the GUI like a root shell.

## Hardening checklist

- **Keep it on localhost.** The GUI binds to `127.0.0.1` by default. Do not change `bindHost` without real protection in front of it. If you host it somewhere reachable, put it behind HTTPS (an SSH tunnel, Tailscale Serve, Cloudflare Tunnel, or nginx with Let's Encrypt) and set `"trustProxy": true`. Never expose it to the public internet over plain HTTP.
- **Protect `config.json`, `auth.json` and `notifications.json`.** They are in `.gitignore`. `config.json` contains your VPS password in plain text if you use one, `auth.json` contains the GUI login hash, and `notifications.json` holds your Discord webhook URLs (anyone with one can post to the channel). Never commit, paste or screenshot them.
- **Prefer an SSH key** (`ssh.privateKeyPath`) over a password, and disable SSH password login on the VPS once the key works.
- **Do not use the default or weak game passwords.** The Settings page flags very common passwords.
- **Treat webhook URLs as secrets.** A Discord webhook URL lets anyone post to the channel. If one leaks, delete it in Discord and create a new one.
- **Firewall.** Open only the UDP game ports you need (2456-2458 for the first world), and consider `fail2ban` for SSH.
- **Keep Setup for fresh servers.** It needs root. After setup, a sudo-capable user with a key is enough for daily use (privileged commands then use `sudo -n`).

## What the login protects against

The GUI shows a sign-in page first. The password is stored only as a scrypt hash in `auth.json`. Sessions use an HttpOnly, SameSite=Strict cookie (Secure over HTTPS) and expire after 12 hours idle and 7 days at most. Five wrong passwords from one address lock that address out for 15 minutes. State-changing requests must come from the page's own origin and carry an `X-VGUI` header, which stops other websites from driving the GUI through your browser.

Locked out? Delete `auth.json` and restart; a new random password is printed once. Or run `node set-password.js`.

## Reporting a vulnerability

Please do not open a public issue for a security problem. Use GitHub's private vulnerability reporting on this repository (**Security**, then **Report a vulnerability**), or contact the maintainer through the profile at <https://github.com/Variance27>. Include what you found, how to reproduce it, and the impact. You will get an acknowledgement as soon as the maintainer sees it.

## Supported versions

Only the latest release on the default branch receives fixes.
