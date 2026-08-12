// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';


/**
 * KDE Connect's Bluetooth transport is a small multiplexing protocol over one
 * RFCOMM socket. The desktop packet channel always uses this UUID.
 */
export const DEFAULT_CHANNEL_UUID = 'a0d0aaf4-1072-4d81-aa35-902a954b1266';

const BUFFER_SIZE = 4096;
const HEADER_SIZE = 19;
const PROTOCOL_VERSION = 1;

export const MessageType = Object.freeze({
    PROTOCOL: 0,
    OPEN: 1,
    CLOSE: 2,
    READ: 3,
    WRITE: 4,
});


/**
 * Encode a multiplex frame.
 *
 * @param {number} type - A {@link MessageType}
 * @param {string} uuid - The multiplex channel UUID
 * @param {Uint8Array} [body] - The frame body
 * @returns {Uint8Array} The encoded frame
 */
export function packMessage(type, uuid, body = new Uint8Array()) {
    if (!(body instanceof Uint8Array))
        throw new TypeError('Multiplex message bodies must be Uint8Array values');

    if (body.length > 0xffff)
        throw new Error(`Multiplex message is too large: ${body.length}`);

    const hex = uuid.replaceAll('-', '');
    if (!/^[0-9a-f]{32}$/i.test(hex))
        throw new Error(`Invalid multiplex UUID: ${uuid}`);

    const frame = new Uint8Array(HEADER_SIZE + body.length);
    const view = new DataView(frame.buffer);

    view.setUint8(0, type);
    view.setUint16(1, body.length, false);

    for (let i = 0; i < 16; i++)
        view.setUint8(i + 3, Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16));

    frame.set(body, HEADER_SIZE);
    return frame;
}


/**
 * Decode a 19-byte multiplex frame header.
 *
 * @param {Uint8Array} header - The encoded header
 * @returns {{type: number, size: number, uuid: string}} The decoded header
 */
export function unpackHeader(header) {
    if (!(header instanceof Uint8Array) || header.length !== HEADER_SIZE)
        throw new Error('Invalid multiplex frame header');

    const view = new DataView(header.buffer, header.byteOffset,
        header.byteLength);
    let hex = '';

    for (let i = 3; i < HEADER_SIZE; i++)
        hex += view.getUint8(i).toString(16).padStart(2, '0');

    return {
        type: view.getUint8(0),
        size: view.getUint16(1, false),
        uuid: `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-` +
              `${hex.slice(16, 20)}-${hex.slice(20)}`,
    };
}


/**
 * A bounded byte buffer for a multiplex channel.
 */
class ChannelBuffer {

    constructor(onConsume) {
        this._bytes = new Uint8Array();
        this._onConsume = onConsume;
        this._waiters = [];
        this._closed = null;
    }

    get length() {
        return this._bytes.length;
    }

    append(bytes) {
        if (this._closed)
            return;

        const joined = new Uint8Array(this._bytes.length + bytes.length);
        joined.set(this._bytes);
        joined.set(bytes, this._bytes.length);
        this._bytes = joined;
        this._wake();
    }

    close(error = new Error('Multiplex connection closed')) {
        if (this._closed)
            return;

        this._closed = error;
        this._wake();
    }

    async readLine(cancellable = null) {
        while (true) {
            const index = this._bytes.indexOf(0x0a);
            if (index !== -1)
                return this._take(index + 1);

            if (this._closed)
                throw this._closed;

            await this._wait(cancellable);
        }
    }

    _take(length) {
        const bytes = this._bytes.slice(0, length);
        this._bytes = this._bytes.slice(length);
        this._onConsume();
        return bytes;
    }

    _wait(cancellable) {
        return new Promise((resolve, reject) => {
            const waiter = {resolve, reject, cancellable, id: 0};

            if (cancellable) {
                waiter.id = cancellable.connect(() => {
                    this._waiters.splice(this._waiters.indexOf(waiter), 1);
                    reject(new Gio.IOErrorEnum({
                        code: Gio.IOErrorEnum.CANCELLED,
                        message: 'Operation cancelled',
                    }));
                });
            }

            this._waiters.push(waiter);
        });
    }

    _wake() {
        const waiters = this._waiters.splice(0);

        for (const waiter of waiters) {
            if (waiter.id)
                waiter.cancellable.disconnect(waiter.id);
            waiter.resolve();
        }
    }
}


/**
 * One logical channel inside a {@link Connection}.
 */
export class Channel {

    constructor(connection, uuid) {
        this.connection = connection;
        this.uuid = uuid;
        this.readCredit = 0;
        this.writeCredit = 0;
        this._writeWaiters = [];
        this.buffer = new ChannelBuffer(() => {
            this.connection.requestRead(this.uuid).catch(this.connection.close.bind(
                this.connection));
        });
    }

    close() {
        this.buffer.close();

        for (const waiter of this._writeWaiters.splice(0))
            waiter.reject(new Error('Multiplex connection closed'));
    }

    readLine(cancellable = null) {
        return this.buffer.readLine(cancellable);
    }

    async write(bytes) {
        let offset = 0;

        while (offset < bytes.length) {
            while (this.writeCredit === 0)
                await this._waitForWriteCredit();

            const length = Math.min(bytes.length - offset, this.writeCredit,
                BUFFER_SIZE);
            this.writeCredit -= length;
            await this.connection._send(MessageType.WRITE, this.uuid,
                bytes.slice(offset, offset + length));
            offset += length;
        }
    }

    _grantWriteCredit(amount) {
        this.writeCredit += amount;

        for (const waiter of this._writeWaiters.splice(0))
            waiter.resolve();
    }

    _waitForWriteCredit() {
        return new Promise((resolve, reject) => {
            this._writeWaiters.push({resolve, reject});
        });
    }
}


/**
 * A KDE Connect Bluetooth multiplex connection.
 *
 * The connection is deliberately independent from Core.Channel. This lets the
 * Bluetooth backend keep packet framing and RFCOMM flow control separate from
 * GSConnect's normal JSON packet API.
 */
export class Connection {

    constructor(connection, cancellable = new Gio.Cancellable()) {
        this._connection = connection;
        this._input = connection.get_input_stream();
        this._output = connection.get_output_stream();
        this.cancellable = cancellable;
        this.channels = new Map();
        this.defaultChannel = this._addChannel(DEFAULT_CHANNEL_UUID);
        this._writeChain = Promise.resolve();
        this._closed = false;
    }

    get closed() {
        return this._closed;
    }

    async negotiate(identity) {
        const localIdentity = new TextEncoder().encode(identity);

        // Android sends its protocol frame as soon as its multiplexer is
        // constructed.  Read that frame before answering: this is also the
        // ordering used by KDE Connect's original desktop Bluetooth backend.
        // It avoids two peers simultaneously trying to write their initial
        // frame on an RFCOMM socket that Android is still bringing up.
        const protocol = await this._readMessage();
        this._checkProtocol(protocol);

        await this._send(MessageType.PROTOCOL, DEFAULT_CHANNEL_UUID,
            new Uint8Array([0, PROTOCOL_VERSION, 0, PROTOCOL_VERSION]));

        await this.requestRead(DEFAULT_CHANNEL_UUID);
        const first = await this._readMessage();
        let remoteIdentity;

        if (first.type === MessageType.WRITE) {
            remoteIdentity = this._receiveIdentity(first);
            await this.requestRead(DEFAULT_CHANNEL_UUID);

            const read = await this._readMessage();
            this._receiveRead(read);
            await this.defaultChannel.write(localIdentity);
        } else if (first.type === MessageType.READ) {
            this._receiveRead(first);
            await this.defaultChannel.write(localIdentity);

            const identityFrame = await this._readMessage();
            remoteIdentity = this._receiveIdentity(identityFrame);
            await this.requestRead(DEFAULT_CHANNEL_UUID);
        } else {
            throw new Error(`Unexpected multiplex handshake frame: ${first.type}`);
        }

        this._receiveLoop().catch(error => {
            if (!this.closed)
                debug(error, 'Bluetooth multiplex receive loop');
            this.close(error);
        });

        return new TextDecoder().decode(remoteIdentity);
    }

    async requestRead(uuid) {
        const channel = this.channels.get(uuid);
        if (!channel || this.closed)
            return;

        const amount = BUFFER_SIZE - channel.readCredit - channel.buffer.length;
        if (amount <= 0)
            return;

        channel.readCredit += amount;
        const body = new Uint8Array(2);
        new DataView(body.buffer).setUint16(0, amount, false);

        try {
            await this._send(MessageType.READ, uuid, body);
        } catch (e) {
            channel.readCredit -= amount;
            throw e;
        }
    }

    close(error = new Error('Multiplex connection closed')) {
        if (this._closed)
            return;

        this._closed = true;
        this.cancellable.cancel();

        for (const channel of this.channels.values())
            channel.close();

        try {
            this._connection.close(null);
        } catch {
            // The fd can already have been reclaimed by BlueZ.
        }

        this.error = error;
    }

    _addChannel(uuid) {
        const channel = new Channel(this, uuid);
        this.channels.set(uuid, channel);
        return channel;
    }

    _checkProtocol(message) {
        // KDE Connect Android sends protocol negotiation frames with an all-
        // zero UUID, while desktop clients use the default channel UUID.
        if (message.type !== MessageType.PROTOCOL || message.body.length < 4)
            throw new Error('Expected a Bluetooth multiplex protocol frame');

        const view = new DataView(message.body.buffer, message.body.byteOffset,
            message.body.byteLength);
        const minimum = view.getUint16(0, false);
        const maximum = view.getUint16(2, false);

        if (minimum > PROTOCOL_VERSION || maximum < PROTOCOL_VERSION)
            throw new Error(`Unsupported Bluetooth multiplex protocol ${minimum}-${maximum}`);
    }

    _receiveIdentity(message) {
        if (message.type !== MessageType.WRITE ||
            message.uuid !== DEFAULT_CHANNEL_UUID)
            throw new Error('Expected Bluetooth identity packet');

        const channel = this.defaultChannel;
        if (message.body.length > channel.readCredit)
            throw new Error('Bluetooth peer exceeded read credit during identity');

        channel.readCredit -= message.body.length;
        return message.body;
    }

    _receiveRead(message) {
        if (message.type !== MessageType.READ || message.body.length !== 2)
            throw new Error('Expected a Bluetooth multiplex read frame');

        const channel = this.channels.get(message.uuid);
        if (!channel)
            throw new Error(`Read credit for unknown Bluetooth channel ${message.uuid}`);

        const amount = new DataView(message.body.buffer, message.body.byteOffset,
            message.body.byteLength).getUint16(0, false);
        channel._grantWriteCredit(amount);
    }

    async _readExactly(length) {
        let bytes = new Uint8Array();

        while (bytes.length < length) {
            const remaining = length - bytes.length;
            const chunk = await new Promise((resolve, reject) => {
                this._input.read_bytes_async(remaining, GLib.PRIORITY_DEFAULT,
                    this.cancellable, (stream, result) => {
                        try {
                            resolve(stream.read_bytes_finish(result).toArray());
                        } catch (e) {
                            reject(e);
                        }
                    });
            });

            if (chunk.length === 0)
                throw new Error('Bluetooth RFCOMM stream closed');

            const joined = new Uint8Array(bytes.length + chunk.length);
            joined.set(bytes);
            joined.set(chunk, bytes.length);
            bytes = joined;
        }

        return bytes;
    }

    async _readMessage() {
        const header = unpackHeader(await this._readExactly(HEADER_SIZE));
        const body = header.size
            ? await this._readExactly(header.size)
            : new Uint8Array();

        return {...header, body};
    }

    async _receiveLoop() {
        while (!this.closed) {
            const message = await this._readMessage();

            switch (message.type) {
                case MessageType.OPEN:
                    this._receiveOpen(message);
                    break;

                case MessageType.CLOSE:
                    this._receiveClose(message);
                    break;

                case MessageType.READ:
                    this._receiveRead(message);
                    break;

                case MessageType.WRITE:
                    this._receiveWrite(message);
                    break;

                default:
                    throw new Error(`Unknown Bluetooth multiplex frame ${message.type}`);
            }
        }
    }

    _receiveOpen(message) {
        if (message.body.length !== 0)
            throw new Error('Bluetooth multiplex open frame has a body');

        if (!this.channels.has(message.uuid))
            this._addChannel(message.uuid);
    }

    _receiveClose(message) {
        const channel = this.channels.get(message.uuid);
        if (!channel)
            return;

        channel.close();
        this.channels.delete(message.uuid);
    }

    _receiveWrite(message) {
        const channel = this.channels.get(message.uuid);
        if (!channel) {
            this._send(MessageType.CLOSE, message.uuid).catch(this.close.bind(this));
            return;
        }

        if (message.body.length > channel.readCredit)
            throw new Error(`Bluetooth peer exceeded read credit for ${message.uuid}`);

        channel.readCredit -= message.body.length;
        channel.buffer.append(message.body);
    }

    _send(type, uuid, body = new Uint8Array()) {
        if (this.closed)
            return Promise.reject(this.error || new Error('Multiplex connection closed'));

        const frame = packMessage(type, uuid, body);
        const write = () => new Promise((resolve, reject) => {
            this._output.write_all_async(frame, GLib.PRIORITY_DEFAULT,
                this.cancellable, (stream, result) => {
                    try {
                        stream.write_all_finish(result);
                        resolve();
                    } catch (e) {
                        reject(e);
                    }
                });
        });

        this._writeChain = this._writeChain.then(write, write);
        return this._writeChain;
    }
}
