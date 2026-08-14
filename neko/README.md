# Running this extension inside neko

Wired up against the neko stack at `C:\Users\omkar\neko` (`neko-neko-1`, image
`ghcr.io/m1k1o/neko/google-chrome:latest`, Chrome 151). The repo is bind-mounted
into the container and loaded unpacked; the extension lives in the persistent
`neko-chrome` volume, so it survives restarts.

## Why not `--load-extension`

Branded Google Chrome dropped the `--load-extension` command-line switch in
Chrome 137. Unbranded Chromium, Brave and Chrome for Testing still honour it —
branded Chrome does not, so the flag route is unavailable on this image.
`chrome://extensions` → **Load unpacked** is the supported path.

## What neko's stock policy blocks

`/etc/opt/chrome/policies/managed/policies.json` (mounted from
`C:\Users\omkar\neko\policies.json`) shipped three settings that make an
unpacked install impossible:

| Policy | Was | Now | Why |
| --- | --- | --- | --- |
| `ExtensionInstallBlocklist` | `["*"]` | `[]` | `*` blocks every extension; allowlisting by ID does not reliably exempt unsigned unpacked loads |
| `AllowFileSelectionDialogs` | `false` | `true` | the **Load unpacked** file picker is a native dialog and never opens without this |
| `ExtensionDeveloperModeSettings` | unset | `0` (Allow) | `DeveloperToolsAvailability: 2` otherwise disables the extensions-page dev mode toggle. This key takes precedence on Chrome 128+, so DevTools stays off |

Everything else in that file is untouched. Backup at `policies.json.bak`.

> Emptying the blocklist means anyone with your neko session password can
> install extensions from the Web Store. To re-tighten, restore
> `"ExtensionInstallBlocklist": ["*"]` and add this extension's ID to
> `ExtensionInstallAllowlist`. An unpacked extension's ID is the SHA-256 of its
> absolute path; for `/home/neko/extensions/ytm-lyrics` that is
> `knoiapcdfjoepdclokkacbfecliekojc`. Verify against `chrome://extensions`
> before relying on it, and re-check that the extension still loads — Chrome's
> allowlist is documented as exempting *signed* extensions, so this may not
> hold for an unpacked one.

## The mount

`C:\Users\omkar\neko\docker-compose.yml`:

```yaml
services:
  neko:
    volumes:
      - neko-chrome:/home/neko/.config/google-chrome
      - ./policies.json:/etc/opt/chrome/policies/managed/policies.json:ro
      - "C:/Users/omkar/Projects/Yt Music Lyrics Extension:/home/neko/extensions/ytm-lyrics:ro"
```

Read-only is fine — Chrome only reads an unpacked extension. Backup at
`docker-compose.yml.bak`.

### `hostname: "neko"` is load-bearing

Also added to that service. Chrome writes a `SingletonLock` symlink into the
profile naming the host and pid that hold it — `c33ed14fe8fd-48`. A container
recreate gets a fresh random hostname, so Chrome sees a lock from "another
computer", refuses to touch the profile, and supervisord gives up:

```
The profile appears to be in use by another Google Chrome process (48)
on another computer (c33ed14fe8fd). Chrome has locked the profile...
google-chrome   FATAL   Exited too quickly
```

neko keeps streaming, so this shows up as a black screen with no browser in it.
With the hostname pinned the lock reads `neko-<pid>`; a recreate then matches on
host, finds the pid gone, and clears it by itself.

If it ever happens again (e.g. an unclean kill before the pin was in place):

```bash
docker exec neko-neko-1 rm -f /home/neko/.config/google-chrome/Singleton{Lock,Cookie,Socket}
docker exec neko-neko-1 supervisorctl start google-chrome
```

Those three are dangling symlinks by then; Chrome recreates them on start.

The `dbus`, `UPower` and `DEPRECATED_ENDPOINT` errors in
`/var/log/neko/google-chrome.log` are normal for this image — no dbus daemon in
the container — and are not a symptom of anything.

## Installing it

Once, in the neko browser:

1. `chrome://extensions`
2. **Developer mode** → on
3. **Load unpacked** → path `/home/neko/extensions/ytm-lyrics` → **Select**

Chrome stores the path in the profile, so it reloads on every container start.

## Dev loop

Edit the source on Windows, then hit **Reload** on the extension's card in
`chrome://extensions`. No re-add, no container restart. Content-script changes
also need a refresh of the YouTube Music tab; service-worker changes take effect
on reload.

## Notes for this setup

- `NEKO_DESKTOP_SCREEN` is already `1920x1080@60`, which leaves room for the
  side panel (~350px) next to the player.
- <kbd>Alt</kbd>+<kbd>L</kbd> / <kbd>Shift</kbd>+<kbd>L</kbd> / <kbd>R</kbd>
  travel through neko's input forwarding. If your local browser swallows them
  first, use the player-bar **Lyrics** and **अ→a** buttons, or rebind at
  `chrome://extensions/shortcuts`.
- The optional `itunes.apple.com` and `lyricsmint.com` permissions are granted
  per-profile. Grant them again in the neko browser via the extension's
  Settings page; grants on your desktop install do not carry over.
- Nothing else in the policy interferes: `DownloadRestrictions`,
  `URLBlocklist: file://*` and `--disable-file-system` do not touch
  `music.youtube.com`, `lrclib.net`, or the side panel.
- A container recreate is only needed when the compose file or `policies.json`
  changes, not for extension source edits.

## Sources

- [neko — browser customization docs](https://neko.m1k1o.net/docs/v3/customization/browsers)
- [neko `apps/google-chrome/policies.json`](https://github.com/m1k1o/neko/blob/master/apps/google-chrome/policies.json)
- [PSA: Removing `--load-extension` in branded Chrome builds](https://groups.google.com/a/chromium.org/g/chromium-extensions/c/1-g8EFx2BBY/m/S0ET5wPjCAAJ)
- [Chrome Enterprise — ExtensionInstallBlocklist](https://chromeenterprise.google/policies/extension-install-blocklist/)
- [ExtensionDeveloperModeSettings vs DeveloperToolsAvailability](https://instinctive.app/chromesettings/extensiondevelopermodesettings)
