import { FbRpc } from '../../src';
import {
    schema,
    Method,
    AddResponseT,
    MultiplyResponseT,
    GreetResponseT,
    ShutdownResponseT,
} from './schema';

let pingCount = 0;

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

rpc.registerToTransportCallback((data, _appData) => {
    const frame = Buffer.alloc(4 + data.length);
    frame.writeUInt32LE(data.length, 0);
    frame.set(data, 4);
    process.stdout.write(frame);
});

rpc.registerHandler(Method.ADD, (req, _appData) => {
    return new AddResponseT(req.a() + req.b());
});

rpc.registerHandler(Method.MULTIPLY, (req, _appData) => {
    return new MultiplyResponseT(req.a() * req.b());
});

rpc.registerHandler(Method.GREET, (req, _appData) => {
    return new GreetResponseT(`Hello, ${req.name()}!`);
});

rpc.registerHandler(Method.SHUTDOWN, (req, _appData) => {
    console.error(`Worker: shutdown requested - ${req.reason()}`);
    setTimeout(() => process.exit(0), 100);
    return new ShutdownResponseT(true);
});

rpc.registerHandler(Method.PING, (req, _appData) => {
    pingCount++;
    console.error(`Worker: ping received (ts=${req.timestamp()}, count=${pingCount})`);
});

console.error('Worker: ready');
