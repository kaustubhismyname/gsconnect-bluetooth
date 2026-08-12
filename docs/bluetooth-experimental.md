# Experimental Bluetooth backend

This branch adds a GSConnect Bluetooth Classic transport for KDE Connect
devices. It uses the KDE Connect RFCOMM service UUID and its Bluetooth
multiplexing protocol. This experimental package loads only the Bluetooth
backend, so it cannot use LAN discovery, UDP broadcasts, or a phone hotspot
as a fallback transport.

The branch is intentionally not packaged or installed automatically. A BlueZ
profile owns the KDE Connect Bluetooth UUID, therefore test it only after
stopping another KDE Connect daemon that is using Bluetooth. Do not run both
backends at once.

The Bluetooth backend carries both the default packet channel and additional
UUID multiplex channels used for payloads. It supports KDE Connect control
packets such as clipboard sync, notifications, ping, media controls and remote
input, along with share requests, files, notification icons and photos. SFTP
remains disabled because it starts a separate TCP service, which Bluetooth-only
transport intentionally does not provide. Payload support is experimental and
should be tested with the target phone before relying on it for important
transfers.

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
