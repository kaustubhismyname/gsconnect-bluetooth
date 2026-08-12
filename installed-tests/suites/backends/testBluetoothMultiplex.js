// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

import GLib from 'gi://GLib';

const Multiplex = await import(`file://${GLib.build_filenamev([
    GLib.getenv('GJS_PATH'),
    'service/backends/bluetooth/multiplex.js',
])}`);


describe('Bluetooth multiplex framing', function () {

    it('round-trips a frame header and body', function () {
        const body = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
        const frame = Multiplex.packMessage(Multiplex.MessageType.WRITE,
            Multiplex.DEFAULT_CHANNEL_UUID, body);

        expect(frame.slice(19)).toEqual(body);
        expect(Multiplex.unpackHeader(frame.slice(0, 19))).toEqual({
            type: Multiplex.MessageType.WRITE,
            size: body.length,
            uuid: Multiplex.DEFAULT_CHANNEL_UUID,
        });
    });

    it('uses network byte order for credit frames', function () {
        const body = new Uint8Array([0x10, 0x00]);
        const frame = Multiplex.packMessage(Multiplex.MessageType.READ,
            Multiplex.DEFAULT_CHANNEL_UUID, body);

        expect(Array.from(frame.slice(0, 3))).toEqual([
            Multiplex.MessageType.READ,
            0,
            2,
        ]);
        expect(Array.from(frame.slice(19))).toEqual(Array.from(body));
    });

    it('accepts Android protocol headers with the zero UUID', function () {
        const frame = Multiplex.packMessage(Multiplex.MessageType.PROTOCOL,
            '00000000-0000-0000-0000-000000000000',
            new Uint8Array([0, 1, 0, 1]));

        expect(Multiplex.unpackHeader(frame.slice(0, 19))).toEqual({
            type: Multiplex.MessageType.PROTOCOL,
            size: 4,
            uuid: '00000000-0000-0000-0000-000000000000',
        });
    });

    it('rejects malformed UUIDs and oversized frames', function () {
        expect(() => Multiplex.packMessage(Multiplex.MessageType.WRITE,
            'not-a-uuid')).toThrow();
        expect(() => Multiplex.packMessage(Multiplex.MessageType.WRITE,
            Multiplex.DEFAULT_CHANNEL_UUID, new Uint8Array(0x10000))).toThrow();
    });

    it('opens and closes a payload channel independently', async function () {
        const frames = [];
        const output = {
            write_all_async(frame, _priority, _cancellable, callback) {
                frames.push(frame);
                callback(this, frame);
            },
            write_all_finish() {
                return [true, 0];
            },
        };
        const socket = {
            get_input_stream() {
                return null;
            },
            get_output_stream() {
                return output;
            },
            close() {
            },
        };
        const connection = new Multiplex.Connection(socket);
        const payload = await connection.openChannel();

        expect(connection.getChannel(payload.uuid)).toBe(payload);
        expect(Multiplex.unpackHeader(frames[0].slice(0, 19))).toEqual({
            type: Multiplex.MessageType.OPEN,
            size: 0,
            uuid: payload.uuid,
        });

        await connection.closeChannel(payload.uuid);
        expect(() => connection.getChannel(payload.uuid)).toThrow();
        expect(Multiplex.unpackHeader(frames[1].slice(0, 19))).toEqual({
            type: Multiplex.MessageType.CLOSE,
            size: 0,
            uuid: payload.uuid,
        });
    });

    it('grants an initial read window for peer payload channels', async function () {
        const frames = [];
        const output = {
            write_all_async(frame, _priority, _cancellable, callback) {
                frames.push(frame);
                callback(this, frame);
            },
            write_all_finish() {
                return [true, 0];
            },
        };
        const socket = {
            get_input_stream() {
                return null;
            },
            get_output_stream() {
                return output;
            },
            close() {
            },
        };
        const connection = new Multiplex.Connection(socket);
        const uuid = 'a4e6f1cc-5b2e-4e33-a8ea-9bdb90f09522';

        connection._receiveOpen({
            type: Multiplex.MessageType.OPEN,
            body: new Uint8Array(),
            uuid,
        });
        await Promise.resolve();
        await Promise.resolve();

        expect(Multiplex.unpackHeader(frames[0].slice(0, 19))).toEqual({
            type: Multiplex.MessageType.READ,
            size: 2,
            uuid,
        });
        expect(Array.from(frames[0].slice(19))).toEqual([0x10, 0x00]);
    });

    it('continues reading an oversized default-channel packet', async function () {
        const frames = [];
        const output = {
            write_all_async(frame, _priority, _cancellable, callback) {
                frames.push(frame);
                callback(this, frame);
            },
            write_all_finish() {
                return [true, 0];
            },
        };
        const socket = {
            get_input_stream() {
                return null;
            },
            get_output_stream() {
                return output;
            },
            close() {
            },
        };
        const connection = new Multiplex.Connection(socket);
        const channel = connection.defaultChannel;

        channel.readCredit = 4096;
        connection._receiveWrite({
            type: Multiplex.MessageType.WRITE,
            body: new Uint8Array(4096),
            uuid: Multiplex.DEFAULT_CHANNEL_UUID,
        });
        await Promise.resolve();
        await Promise.resolve();

        expect(channel.buffer.length).toBe(4096);
        expect(Multiplex.unpackHeader(frames[0].slice(0, 19))).toEqual({
            type: Multiplex.MessageType.READ,
            size: 2,
            uuid: Multiplex.DEFAULT_CHANNEL_UUID,
        });
        expect(Array.from(frames[0].slice(19))).toEqual([0x10, 0x00]);
    });

    it('copies input bytes before their GLib result is released', async function () {
        const raw = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
        const input = {
            read_bytes_async(_length, _priority, _cancellable, callback) {
                callback(this, {});
                raw.fill(0);
            },
            read_bytes_finish() {
                return {
                    toArray() {
                        return raw;
                    },
                };
            },
        };
        const socket = {
            get_input_stream() {
                return input;
            },
            get_output_stream() {
                return null;
            },
            close() {
            },
        };
        const connection = new Multiplex.Connection(socket);

        expect(Array.from(await connection._readExactly(4))).toEqual([
            0xde,
            0xad,
            0xbe,
            0xef,
        ]);
    });
});
