import { FbRpc } from '../../src';
import {
    schema,
    Method,
    SmallResponseT,
    MediumResponseT,
    LargeResponseT,
} from './schema';

const rpc = new FbRpc(schema);

let buffer = Buffer.alloc(0);

process.stdin.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4) {
        const len = buffer.readUInt32LE(0);
        if (buffer.length < 4 + len) break;
        const msg = buffer.subarray(4, 4 + len);
        buffer = buffer.subarray(4 + len);
        rpc.fromTransport(msg, undefined);
    }
});

rpc.registerToTransportCallback((data) => {
    const frame = Buffer.alloc(4 + data.length);
    frame.writeUInt32LE(data.length, 0);
    frame.set(data, 4);
    process.stdout.write(frame);
});

// Echo handlers - just return what we received
rpc.registerHandler(Method.ECHO_SMALL, (req) => {
    return new SmallResponseT(req.value(), req.timestamp());
});

rpc.registerHandler(Method.ECHO_MEDIUM, (req) => {
    return new MediumResponseT(
        req.id(),
        req.name(),
        Array.from({ length: req.tagsLength() }, (_, i) => req.tags(i) ?? ''),
        Array.from({ length: req.dataLength() }, (_, i) => req.data(i) ?? 0)
    );
});

rpc.registerHandler(Method.ECHO_LARGE, (req) => {
    return new LargeResponseT(
        Array.from({ length: req.payloadLength() }, (_, i) => req.payload(i) ?? 0),
        req.metadata(),
        req.checksum()
    );
});

rpc.registerHandler(Method.VOID_OP, () => {
    // No return - void response
});

rpc.registerHandler(Method.NOTIFY, () => {
    // Notification - no response needed
});

// Signal ready
console.error('bench-worker: ready');
