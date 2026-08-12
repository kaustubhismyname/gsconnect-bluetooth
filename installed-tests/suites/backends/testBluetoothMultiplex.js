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
});
