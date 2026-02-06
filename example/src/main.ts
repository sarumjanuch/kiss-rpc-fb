import { spawn } from 'child_process';
import { FbRpc } from '../../src';
import {
    schema,
    Method,
    AddRequestT,
    MultiplyRequestT,
    GreetRequestT,
    ShutdownRequestT,
    PingRequestT,
} from './schema';

const worker = spawn('npx', ['tsx', 'example/src/worker.ts'], {
    stdio: ['pipe', 'pipe', 'inherit'],
});

type Session = {
    userId: string,
    connectionId: number
}

const rpc = new FbRpc<typeof schema, Session>(schema);

// Length-prefixed framing
let buffer = Buffer.alloc(0);

worker.stdout.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4) {
        const len = buffer.readUInt32LE(0);
        if (buffer.length < 4 + len) break;
        const msg = buffer.subarray(4, 4 + len);
        buffer = buffer.subarray(4 + len);
        rpc.fromTransport(msg, {
            userId: '123123-asdfasd',
            connectionId: 2
        });
    }
});

rpc.registerToTransportCallback((data, appData) => {
    const frame = Buffer.alloc(4 + data.length);
    frame.writeUInt32LE(data.length, 0);
    frame.set(data, 4);
    worker.stdin.write(frame);
});

async function main() {
    // Wait for worker to start
    await new Promise(r => setTimeout(r, 500));

    const session: Session = {
        userId: '123123-asdfasd',
        connectionId: 2
    }

    console.log('Testing ADD...');
    const addResp = await rpc.request(Method.ADD, new AddRequestT(10, 32), session);
    console.log(`  10 + 32 = ${addResp.result()}`);

    console.log('Testing MULTIPLY...');
    const mulResp = await rpc.request(Method.MULTIPLY, new MultiplyRequestT(7, 6), session);
    console.log(`  7 * 6 = ${mulResp.result()}`);

    console.log('Testing GREET...');
    const greetResp = await rpc.request(Method.GREET, new GreetRequestT('World'), session);
    console.log(`  ${greetResp.message()}`);

    // Void response example - returns Promise<void>
    console.log('Testing PING (void response)...');
    const pingResult = await rpc.request(Method.PING, new PingRequestT(BigInt(Date.now())), session);
    console.log(`  ping returned: ${pingResult} (should be undefined)`);

    console.log('Testing SHUTDOWN...');
    const shutResp = await rpc.request(Method.SHUTDOWN, new ShutdownRequestT('test complete'), session);
    console.log(`  ok = ${shutResp.ok()}`);

    rpc.clean('done');
    console.log('\nAll tests passed!');
}

main().catch(console.error);
