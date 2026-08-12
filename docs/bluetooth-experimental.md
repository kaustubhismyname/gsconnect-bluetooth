# Experimental dual-transport backend

This branch adds a GSConnect Bluetooth Classic transport for KDE Connect
devices. It uses the KDE Connect RFCOMM service UUID and its Bluetooth
multiplexing protocol alongside GSConnect's existing Wi-Fi/LAN backend.

Preferences exposes independent **Wi-Fi / LAN** and **Bluetooth RFCOMM**
switches under **Connection Transports**. Bluetooth is enabled by default and
Wi-Fi/LAN is disabled by default, so a phone hotspot or institute network is
never used unless the Wi-Fi/LAN switch is explicitly enabled. Switching a
transport off closes its current channels and stops its discovery service;
switching it back on does not require re-pairing.

This experimental branch must be built and installed manually. A BlueZ profile
owns the KDE Connect Bluetooth UUID, therefore stop another KDE Connect desktop
daemon that is using Bluetooth before enabling this extension. Do not run both
desktop services at once.

The Bluetooth backend carries both the default packet channel and additional
UUID multiplex channels used for payloads. It supports KDE Connect control
packets such as clipboard sync, notifications, ping, media controls and remote
input, along with share requests, files, notification icons and photos. SFTP
remains unavailable over Bluetooth because it starts a separate TCP service,
but works when Wi-Fi/LAN is enabled. Payload support is experimental and should
be tested with the target phone before relying on it for important transfers.

Bluetooth pairing and GSConnect pairing remain separate. BlueZ protects the
radio link, while the GSConnect identity packet includes the normal device
certificate. The certificate is stored on pairing and checked on each later
Bluetooth connection.

## Safe test sequence

1. Build this branch with `meson setup _build` followed by `meson compile -C
   _build`.
2. Create a temporary extension package from the branch, rather than replacing
   an installed GSConnect build.
3. Stop the KDE Connect process that currently owns the Bluetooth KDE Connect
   service UUID, then enable only this test extension.
4. Keep the phone paired in GNOME Bluetooth and enable Bluetooth in KDE
   Connect on Android. Use GSConnect to refresh/identify the phone, accept the
   GSConnect pairing request, then test clipboard in both directions.
5. If the test fails, disable the test extension first; the normal installed
   KDE Connect setup remains untouched.

Useful logs while testing:

```sh
journalctl --user -f -o cat | rg 'GSConnect|Bluetooth'
journalctl -u bluetooth -f -o cat
```
