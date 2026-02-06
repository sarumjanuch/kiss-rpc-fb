import { spawn, ChildProcess } from 'child_process';
import { writeFileSync } from 'fs';
import * as flatbuffers from 'flatbuffers';
import { FbRpc } from '../../src';
import {
    schema,
    Method,
    SmallRequestT,
    MediumRequestT,
    LargeRequestT,
    VoidRequestT,
    NotifyRequestT,
    SmallRequest,
    MediumRequest,
    LargeRequest,
} from './schema';
import {
    BenchResult,
    BenchRun,
    bench,
    benchSync,
    printResult,
    printHeader,
    printMeta,
    createMeta,
    tryGc,
} from './utils';

// Parse args
const args = process.argv.slice(2);
const outputJson = args.includes('--json');
const outputFile = args.find((a) => a.startsWith('--out='))?.slice(6);
const title = args.find((a) => a.startsWith('--title='))?.slice(8);

// Test data
const SMALL_REQ = new SmallRequestT(42, BigInt(Date.now()));
const MEDIUM_DATA = new Uint8Array(200).fill(0xab);
const MEDIUM_REQ = new MediumRequestT(
    BigInt(12345),
    'benchmark-test-name',
    ['tag1', 'tag2', 'tag3'],
    Array.from(MEDIUM_DATA)
);
const LARGE_DATA = new Uint8Array(4000).fill(0xcd);
const LARGE_REQ = new LargeRequestT(
    Array.from(LARGE_DATA),
    'large-payload-metadata-string-for-benchmark',
    BigInt(0xdeadbeef)
);
const VOID_REQ = new VoidRequestT(BigInt(Date.now()));
const NOTIFY_REQ = new NotifyRequestT('benchmark-event', [1, 2, 3, 4, 5]);

// Pre-encode for decode benchmarks
const builder = new flatbuffers.Builder(8192);

function encodeSmall(): Uint8Array {
    builder.clear();
    const offset = SMALL_REQ.pack(builder);
    builder.finish(offset);
    return builder.asUint8Array().slice();
}

function encodeMedium(): Uint8Array {
    builder.clear();
    const offset = MEDIUM_REQ.pack(builder);
    builder.finish(offset);
    return builder.asUint8Array().slice();
}

function encodeLarge(): Uint8Array {
    builder.clear();
    const offset = LARGE_REQ.pack(builder);
    builder.finish(offset);
    return builder.asUint8Array().slice();
}

const SMALL_ENCODED = encodeSmall();
const MEDIUM_ENCODED = encodeMedium();
const LARGE_ENCODED = encodeLarge();

// IPC setup
let worker: ChildProcess;
let rpc: FbRpc<typeof schema>;
let ipcBuffer = Buffer.alloc(0);

async function setupIpc(): Promise<void> {
    worker = spawn('npx', ['tsx', 'benchmark/src/bench-worker.ts'], {
        stdio: ['pipe', 'pipe', 'inherit'],
    });

    rpc = new FbRpc(schema);

    worker.stdout!.on('data', (chunk: Buffer) => {
        ipcBuffer = Buffer.concat([ipcBuffer, chunk]);
        while (ipcBuffer.length >= 4) {
            const len = ipcBuffer.readUInt32LE(0);
            if (ipcBuffer.length < 4 + len) break;
            const msg = ipcBuffer.subarray(4, 4 + len);
            ipcBuffer = ipcBuffer.subarray(4 + len);
            rpc.fromTransport(msg, undefined);
        }
    });

    rpc.registerToTransportCallback((data) => {
        const frame = Buffer.alloc(4 + data.length);
        frame.writeUInt32LE(data.length, 0);
        frame.set(data, 4);
        worker.stdin!.write(frame);
    });

    // Wait for worker ready
    await new Promise((r) => setTimeout(r, 500));
}

function teardownIpc(): void {
    rpc.clean('benchmark done');
    worker.kill();
}

// Benchmark functions
async function runEncodingBenchmarks(): Promise<BenchResult[]> {
    const results: BenchResult[] = [];

    tryGc();
    results.push(
        await benchSync(`encode small (${SMALL_ENCODED.length}B)`, () => {
            builder.clear();
            const offset = SMALL_REQ.pack(builder);
            builder.finish(offset);
            builder.asUint8Array();
        })
    );

    tryGc();
    results.push(
        await benchSync(`encode medium (${MEDIUM_ENCODED.length}B)`, () => {
            builder.clear();
            const offset = MEDIUM_REQ.pack(builder);
            builder.finish(offset);
            builder.asUint8Array();
        })
    );

    tryGc();
    results.push(
        await benchSync(`encode large (${LARGE_ENCODED.length}B)`, () => {
            builder.clear();
            const offset = LARGE_REQ.pack(builder);
            builder.finish(offset);
            builder.asUint8Array();
        })
    );

    return results;
}

async function runDecodingBenchmarks(): Promise<BenchResult[]> {
    const results: BenchResult[] = [];

    tryGc();
    results.push(
        await benchSync(`decode small (${SMALL_ENCODED.length}B)`, () => {
            const bb = new flatbuffers.ByteBuffer(SMALL_ENCODED);
            const obj = new SmallRequest();
            obj.__init(bb.readInt32(bb.position()) + bb.position(), bb);
            obj.value();
            obj.timestamp();
        })
    );

    tryGc();
    results.push(
        await benchSync(`decode medium (${MEDIUM_ENCODED.length}B)`, () => {
            const bb = new flatbuffers.ByteBuffer(MEDIUM_ENCODED);
            const obj = new MediumRequest();
            obj.__init(bb.readInt32(bb.position()) + bb.position(), bb);
            obj.id();
            obj.name();
            obj.tagsLength();
            obj.dataLength();
        })
    );

    tryGc();
    results.push(
        await benchSync(`decode large (${LARGE_ENCODED.length}B)`, () => {
            const bb = new flatbuffers.ByteBuffer(LARGE_ENCODED);
            const obj = new LargeRequest();
            obj.__init(bb.readInt32(bb.position()) + bb.position(), bb);
            obj.payloadLength();
            obj.metadata();
            obj.checksum();
        })
    );

    return results;
}

async function runRoundtripBenchmarks(): Promise<BenchResult[]> {
    const results: BenchResult[] = [];

    tryGc();
    results.push(
        await bench(
            `roundtrip small (${SMALL_ENCODED.length}B)`,
            async () => {
                await rpc.request(Method.ECHO_SMALL, SMALL_REQ, undefined);
            },
            { warmup: 500, minOps: 5000, minMs: 2000 }
        )
    );

    tryGc();
    results.push(
        await bench(
            `roundtrip medium (${MEDIUM_ENCODED.length}B)`,
            async () => {
                await rpc.request(Method.ECHO_MEDIUM, MEDIUM_REQ, undefined);
            },
            { warmup: 500, minOps: 5000, minMs: 2000 }
        )
    );

    tryGc();
    results.push(
        await bench(
            `roundtrip large (${LARGE_ENCODED.length}B)`,
            async () => {
                await rpc.request(Method.ECHO_LARGE, LARGE_REQ, undefined);
            },
            { warmup: 500, minOps: 5000, minMs: 2000 }
        )
    );

    tryGc();
    results.push(
        await bench(
            'roundtrip void response',
            async () => {
                await rpc.request(Method.VOID_OP, VOID_REQ, undefined);
            },
            { warmup: 500, minOps: 5000, minMs: 2000 }
        )
    );

    return results;
}

async function runParallelBenchmarks(): Promise<BenchResult[]> {
    const results: BenchResult[] = [];

    for (const parallelism of [10, 100]) {
        tryGc();

        const name = `parallel small x${parallelism}`;
        let ops = 0;
        const warmup = 100;

        // Warmup
        for (let i = 0; i < warmup; i++) {
            await Promise.all(
                Array.from({ length: parallelism }, () =>
                    rpc.request(Method.ECHO_SMALL, SMALL_REQ, undefined)
                )
            );
        }

        const start = performance.now();
        const minMs = 2000;
        let elapsed = 0;

        while (elapsed < minMs) {
            await Promise.all(
                Array.from({ length: parallelism }, () =>
                    rpc.request(Method.ECHO_SMALL, SMALL_REQ, undefined)
                )
            );
            ops += parallelism;
            elapsed = performance.now() - start;
        }

        const totalMs = elapsed;
        const usPerOp = (totalMs * 1000) / ops;
        const opsPerSec = ops / (totalMs / 1000);

        results.push({ name, ops, totalMs, usPerOp, opsPerSec });
    }

    return results;
}

async function runNotificationBenchmarks(): Promise<BenchResult[]> {
    const results: BenchResult[] = [];

    // Notifications are fire-and-forget, so we measure send rate
    tryGc();
    results.push(
        await benchSync('notification send', () => {
            rpc.notify(Method.NOTIFY, NOTIFY_REQ, undefined);
        })
    );

    return results;
}


async function main(): Promise<void> {
    const run: BenchRun = {
        meta: createMeta(title),
        results: {},
    };

    if (!outputJson) {
        printMeta(run);
    }

    // Local encoding/decoding benchmarks
    if (!outputJson) printHeader('Encoding (local)');
    for (const r of await runEncodingBenchmarks()) {
        run.results[r.name] = r;
        if (!outputJson) printResult(r);
    }

    if (!outputJson) printHeader('Decoding (local)');
    for (const r of await runDecodingBenchmarks()) {
        run.results[r.name] = r;
        if (!outputJson) printResult(r);
    }

    // IPC benchmarks
    await setupIpc();

    if (!outputJson) printHeader('Round-trip Latency (IPC)');
    for (const r of await runRoundtripBenchmarks()) {
        run.results[r.name] = r;
        if (!outputJson) printResult(r);
    }

    if (!outputJson) printHeader('Throughput (IPC, parallel)');
    for (const r of await runParallelBenchmarks()) {
        run.results[r.name] = r;
        if (!outputJson) printResult(r);
    }

    if (!outputJson) printHeader('Notifications (fire-and-forget)');
    for (const r of await runNotificationBenchmarks()) {
        run.results[r.name] = r;
        if (!outputJson) printResult(r);
    }

    // Note: Guard benchmarks removed - they need worker-side guards to be meaningful
    // The overhead is negligible for client-side guard checks

    teardownIpc();

    // Output
    if (outputJson) {
        console.log(JSON.stringify(run, null, 2));
    }

    if (outputFile) {
        writeFileSync(outputFile, JSON.stringify(run, null, 2));
        if (!outputJson) {
            console.log(`\nResults saved to: ${outputFile}`);
        }
    }

    if (!outputJson) {
        console.log('\nDone.');
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
