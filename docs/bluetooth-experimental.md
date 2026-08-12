# Experimental Bluetooth backend

This branch adds a GSConnect Bluetooth Classic transport for KDE Connect
devices. It uses the KDE Connect RFCOMM service UUID and its Bluetooth
multiplexing protocol, so it does not need LAN discovery, UDP broadcasts, or
the institute Wi-Fi network.

The branch is intentionally not packaged or installed automatically. A BlueZ
profile owns the KDE Connect Bluetooth UUID, therefore test it only after
stopping another KDE Connect daemon that is using Bluetooth. Do not run both
backends at once.

The first milestone carries the default packet channel only. It supports
KDE Connect control packets such as clipboard sync, notifications, ping,
media controls and remote input. It intentionally does not advertise SFTP,
share, photo, or other payload-based capabilities until multiplexed file
transfer support is implemented and tested.

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
