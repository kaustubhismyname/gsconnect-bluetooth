// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

import Config from '../../config.js';
import * as Core from '../core.js';
import * as DBus from '../utils/dbus.js';
import * as Multiplex from './bluetooth/multiplex.js';


const PROFILE_PATH = '/org/gnome/Shell/Extensions/GSConnect/BluetoothProfile';
const SERVICE_UUID = '185f3df4-3268-4e3f-9fca-d4d5059915bd';

const BLUEZ_INFO = Gio.DBusNodeInfo.new_for_xml(`
<node>
  <interface name="org.bluez.Profile1">
    <method name="Release"/>
    <method name="NewConnection">
      <arg name="device" type="o" direction="in"/>
      <arg name="fd" type="h" direction="in"/>
      <arg name="fd_properties" type="a{sv}" direction="in"/>
    </method>
    <method name="RequestDisconnection">
      <arg name="device" type="o" direction="in"/>
    </method>
  </interface>
</node>
`);

const PROFILE_INFO = BLUEZ_INFO.lookup_interface('org.bluez.Profile1');

// These packets carry arbitrary payloads. Their Bluetooth multiplex channels
// are deliberately deferred until file-transfer handling has test coverage.
const PAYLOAD_CAPABILITIES = new Set([
    'kdeconnect.photo',
    'kdeconnect.share.request',
    'kdeconnect.sftp',
    'kdeconnect.sftp.request',
]);


/**
 * Extract the ordinary JavaScript values from a BlueZ a{sv} dictionary.
 *
 * @param {object} values - A D-Bus dictionary
 * @returns {object} A plain value dictionary
 */
function unpackProperties(values) {
    return Object.fromEntries(Object.entries(values).map(([key, value]) => {
        if (value instanceof GLib.Variant)
            return [key, value.deepUnpack()];

        return [key, value];
    }));
}


/**
 * Make an initialized proxy bound to the service's private system-bus link.
 *
 * @param {Gio.DBusConnection} connection - The system bus connection
 * @param {string} objectPath - The target object path
 * @param {string} interfaceName - The target interface
 * @returns {Promise<Gio.DBusProxy>} An initialized proxy
 */
async function newBluezProxy(connection, objectPath, interfaceName) {
    const proxy = new Gio.DBusProxy({
        g_connection: connection,
        g_name: 'org.bluez',
        g_object_path: objectPath,
        g_interface_name: interfaceName,
        g_flags: Gio.DBusProxyFlags.DO_NOT_AUTO_START_AT_CONSTRUCTION,
    });

    await proxy.init_async(GLib.PRIORITY_DEFAULT, null);
    return proxy;
}


/**
 * Bluetooth RFCOMM discovery and connection service.
 *
 * BlueZ owns RFCOMM sockets, handing this profile an fd through Profile1. The
 * service does not need an RFCOMM listener or a root helper.
 */
export const ChannelService = GObject.registerClass({
    GTypeName: 'GSConnectBluetoothChannelService',
    Properties: {
        'certificate': GObject.ParamSpec.object(
            'certificate',
            'Certificate',
            'The identity certificate sent over Bluetooth',
            GObject.ParamFlags.READWRITE,
            Gio.TlsCertificate.$gtype
        ),
    },
}, class BluetoothChannelService extends Core.ChannelService {

    _init(params = {}) {
        super._init(params);

        this._devices = new Map();
        this._starting = null;
        this._started = false;
        this._registered = false;
        this._connections = new Map();
    }

    get certificate() {
        if (this._certificate === undefined)
            this._certificate = null;

        return this._certificate;
    }

    set certificate(certificate) {
        if (this.certificate === certificate)
            return;

        this._certificate = certificate;
        this.notify('certificate');
    }

    get channels() {
        if (this._channels === undefined)
            this._channels = new Map();

        return this._channels;
    }

    get id() {
        return this.certificate ? this.certificate.common_name : super.id;
    }

    /**
     * Give the peer an identity packet with the same certificate used by the
     * LAN backend. Bluetooth itself encrypts the radio link; this certificate
     * supplies KDE Connect's trust-on-first-use device identity.
     *
     * @returns {Core.Packet} The local Bluetooth identity
     */
    getIdentity() {
        const identity = new Core.Packet(this.identity);
        identity.body.certificate = this.certificate.certificate_pem;
        return identity;
    }

    buildIdentity() {
        super.buildIdentity();

        for (const direction of ['incomingCapabilities', 'outgoingCapabilities']) {
            this.identity.body[direction] = this.identity.body[direction].filter(
                type => !PAYLOAD_CAPABILITIES.has(type));
        }
    }

    set name(name) {
        super.name = name;
        this._identity = undefined;
    }

    /**
     * Ask BlueZ to connect a paired device, or all known candidate devices.
     *
     * @param {string} [address] - A Bluetooth address from bluetooth:// URI
     */
    broadcast(address = null) {
        this._refreshDevices().then(() => {
            for (const device of this._devices.values()) {
                if (address !== null && device.address !== address)
                    continue;

                this._connectDevice(device).catch(error => {
                    debug(error, `Bluetooth ${device.address}`);
                });
            }
        }).catch(error => {
            debug(error, 'Bluetooth device discovery');
        });
    }

    async NewConnection(objectPath, fd) {
        let channel = null;

        try {
            const device = await this._getDevice(objectPath);
            const socket = Gio.Socket.new_from_fd(fd);
            const connection = socket.connection_factory_create_connection();

            channel = new Channel({
                backend: this,
                certificate: this.certificate,
                device,
            });
            await channel.open(connection);

            const existing = this.channels.get(channel.address);
            if (existing)
                existing.close();

            this.channels.set(channel.address, channel);
            this.channel(channel);
        } catch (error) {
            channel?.close();
            throw error;
        }
    }

    RequestDisconnection(objectPath) {
        const device = this._devices.get(objectPath);
        if (!device)
            return;

        const channel = this.channels.get(`bluetooth://${device.address}`);
        channel?.close();
    }

    Release() {
        this._registered = false;
        this._active = false;
        this.notify('active');
    }

    start() {
        if (this._started)
            return;

        this._started = true;
        this._starting = this._start().catch(error => {
            this._started = false;
            this._starting = null;
            debug(error, 'Bluetooth backend unavailable');
        });
    }

    async stop() {
        if (!this._started && !this._registered)
            return;

        this._started = false;
        this.cancellable.cancel();

        for (const channel of this.channels.values())
            channel.close();

        this.channels.clear();
        this._connections.clear();
        this._devices.clear();

        try {
            if (this._registered) {
                await this._profileManager.call('UnregisterProfile',
                    new GLib.Variant('(o)', [PROFILE_PATH]),
                    Gio.DBusCallFlags.NONE, -1, null);
            }
        } catch (error) {
            debug(error, 'Bluetooth profile cleanup');
        }

        this._registered = false;
        this._profile?.destroy();
        this._profile = null;
        this._systemBus?.close_sync(null);
        this._systemBus = null;
        this._objectManager = null;
        this._profileManager = null;
        this._active = false;
        this.notify('active');
    }

    destroy() {
        this.stop().catch(error => debug(error, 'Bluetooth shutdown'));
    }

    async _start() {
        this._cancellable = new Gio.Cancellable();
        this.certificate = Gio.TlsCertificate.new_for_paths(
            GLib.build_filenamev([Config.CONFIGDIR, 'certificate.pem']),
            GLib.build_filenamev([Config.CONFIGDIR, 'private.pem']), null);
        this._identity = undefined;
        this._systemBus = await DBus.newConnection(Gio.BusType.SYSTEM,
            this.cancellable);

        this._objectManager = await newBluezProxy(this._systemBus, '/',
            'org.freedesktop.DBus.ObjectManager');
        this._profileManager = await newBluezProxy(this._systemBus,
            '/org/bluez', 'org.bluez.ProfileManager1');
        this._profile = new DBus.Interface({
            g_connection: this._systemBus,
            g_instance: this,
            g_interface_info: PROFILE_INFO,
            g_object_path: PROFILE_PATH,
        });

        const serviceRecord = new TextDecoder().decode(
            Gio.resources_lookup_data(
                `${Config.APP_PATH}/${Config.APP_ID}.sdp.xml`,
                Gio.ResourceLookupFlags.NONE).toArray());
        const options = {
            Name: new GLib.Variant('s', 'GSConnect'),
            RequireAuthentication: new GLib.Variant('b', true),
            ServiceRecord: new GLib.Variant('s', serviceRecord),
        };

        await this._profileManager.call('RegisterProfile',
            new GLib.Variant('(osa{sv})', [PROFILE_PATH, SERVICE_UUID, options]),
            Gio.DBusCallFlags.NONE, -1, this.cancellable);
        this._registered = true;
        this._objectManager.connect('g-signal', this._onBluezSignal.bind(this));
        await this._refreshDevices();

        if (!this._started) {
            await this.stop();
            return;
        }

        this._active = true;
        this.notify('active');
    }

    _onBluezSignal(proxy, sender, signal, parameters) {
        if (signal === 'InterfacesAdded' || signal === 'InterfacesRemoved' ||
            signal === 'PropertiesChanged') {
            this._refreshDevices().catch(error => {
                debug(error, 'Bluetooth device update');
            });
        }
    }

    async _connectDevice(device) {
        if (!device.paired || this.channels.has(`bluetooth://${device.address}`) ||
            this._connections.has(device.path))
            return;

        if (device.uuids.length && !device.uuids.includes(SERVICE_UUID))
            return;

        this._connections.set(device.path, true);

        try {
            const proxy = await newBluezProxy(this._systemBus, device.path,
                'org.bluez.Device1');
            await proxy.call('ConnectProfile', new GLib.Variant('(s)', [SERVICE_UUID]),
                Gio.DBusCallFlags.NONE, -1, this.cancellable);
        } finally {
            this._connections.delete(device.path);
        }
    }

    async _getDevice(path) {
        let device = this._devices.get(path);
        if (device)
            return device;

        const proxy = await newBluezProxy(this._systemBus, path,
            'org.freedesktop.DBus.Properties');
        const result = await proxy.call('GetAll', new GLib.Variant('(s)', [
            'org.bluez.Device1',
        ]), Gio.DBusCallFlags.NONE, -1, this.cancellable);
        const properties = unpackProperties(result.deepUnpack()[0]);

        device = {
            address: properties.Address,
            paired: properties.Paired,
            path,
            uuids: properties.UUIDs || [],
        };
        this._devices.set(path, device);
        return device;
    }

    async _refreshDevices() {
        if (!this._objectManager || this.cancellable.is_cancelled())
            return;

        const result = await this._objectManager.call('GetManagedObjects', null,
            Gio.DBusCallFlags.NONE, -1, this.cancellable);
        const objects = result.deepUnpack()[0];
        const devices = new Map();

        for (const [path, interfaces] of Object.entries(objects)) {
            const raw = interfaces['org.bluez.Device1'];
            if (!raw)
                continue;

            const properties = unpackProperties(raw);
            devices.set(path, {
                address: properties.Address,
                paired: properties.Paired,
                path,
                uuids: properties.UUIDs || [],
            });
        }

        this._devices = devices;
    }
});


/**
 * GSConnect's packet channel over a Bluetooth multiplex default channel.
 */
export const Channel = GObject.registerClass({
    GTypeName: 'GSConnectBluetoothChannel',
}, class BluetoothChannel extends Core.Channel {

    _init(params = {}) {
        super._init();
        Object.assign(this, params);
    }

    get address() {
        return `bluetooth://${this.device.address}`;
    }

    get certificate() {
        if (this._certificate === undefined)
            this._certificate = null;

        return this._certificate;
    }

    set certificate(certificate) {
        this._certificate = certificate;
    }

    get peer_certificate() {
        if (this._peer_certificate === undefined)
            this._peer_certificate = null;

        return this._peer_certificate;
    }

    async open(connection) {
        try {
            this._connection = connection;
            this._multiplex = new Multiplex.Connection(connection, this.cancellable);
            const remote = await this._multiplex.negotiate(
                this.backend.getIdentity().serialize());

            this.identity = new Core.Packet(remote);
            this._validateIdentity();
            this.allowed = true;
        } catch (error) {
            this.close();
            throw error;
        }
    }

    async readPacket(cancellable = null) {
        const bytes = await this._multiplex.defaultChannel.readLine(
            cancellable || this.cancellable);
        return new Core.Packet(new TextDecoder().decode(bytes));
    }

    async sendPacket(packet, cancellable = null) {
        if (cancellable?.is_cancelled()) {
            throw new Gio.IOErrorEnum({
                code: Gio.IOErrorEnum.CANCELLED,
                message: 'Operation cancelled',
            });
        }

        await this._multiplex.defaultChannel.write(
            new TextEncoder().encode(packet.serialize()));
        return true;
    }

    /**
     * Check an already paired GSConnect device before replacing its channel.
     *
     * @param {import('../device.js').default} device - The remembered device
     */
    verifyDevice(device) {
        if (!device.paired)
            return;

        const pem = device.settings.get_string('certificate-pem');
        let expected;

        try {
            expected = Gio.TlsCertificate.new_from_pem(pem, -1);
        } catch (error) {
            device._setPaired(false);
            throw new Error(`${device.name}: invalid stored certificate`, {
                cause: error,
            });
        }

        if (!expected.is_same(this.peer_certificate)) {
            device._setPaired(false);
            throw new Error(`${device.name}: Bluetooth certificate changed`);
        }
    }

    close() {
        if (this.closed)
            return;

        this._closed = true;
        this.notify('closed');
        this.cancellable.cancel();
        this.backend?.channels.delete(this.address);
        this._multiplex?.close();
    }

    rejectTransfer() {
        // Payload plugins are not advertised over Bluetooth yet.
    }

    download() {
        throw new Error('Bluetooth payload transfers are not implemented');
    }

    upload() {
        throw new Error('Bluetooth payload transfers are not implemented');
    }

    _validateIdentity() {
        const {body} = this.identity;

        if (!body.deviceId || !body.deviceName || !body.certificate)
            throw new Error('Invalid Bluetooth identity packet');

        this._peer_certificate = Gio.TlsCertificate.new_from_pem(
            body.certificate, -1);
    }
});
