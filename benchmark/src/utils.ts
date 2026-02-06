import { performance } from 'perf_hooks';

export interface BenchResult {
    name: string;
    ops: number;
    totalMs: number;
    usPerOp: number;
    opsPerSec: number;
}

export interface BenchRun {
    meta: {
        date: string;
        node: string;
        platform: string;
        arch: string;
        title?: string;
    };
    results: Record<string, BenchResult>;
}

export function formatNumber(n: number): string {
    return n.toLocaleString('en-US');
}

export function formatUs(us: number): string {
    if (us >= 1000) {
        return (us / 1000).toFixed(2) + ' ms';
    }
    return us.toFixed(2) + ' µs';
}

export function formatOpsPerSec(ops: number): string {
    if (ops >= 1_000_000) {
        return (ops / 1_000_000).toFixed(2) + 'M';
    }
    if (ops >= 1_000) {
        return (ops / 1_000).toFixed(2) + 'K';
    }
    return ops.toFixed(0);
}

export function padRight(s: string, len: number): string {
    return s.length >= len ? s : s + ' '.repeat(len - s.length);
}

export function padLeft(s: string, len: number): string {
    return s.length >= len ? s : ' '.repeat(len - s.length) + s;
}

export function printResult(result: BenchResult): void {
    const name = padRight(result.name, 35);
    const ops = padLeft(formatNumber(result.ops) + ' ops', 15);
    const usPerOp = padLeft(formatUs(result.usPerOp) + '/op', 14);
    const opsPerSec = padLeft(formatOpsPerSec(result.opsPerSec) + ' ops/sec', 16);
    console.log(`${name} | ${ops} | ${usPerOp} | ${opsPerSec}`);
}

export function printHeader(title: string): void {
    console.log();
    console.log(`--- ${title} ---`);
}

export function printMeta(run: BenchRun): void {
    console.log('=== fb-rpc Benchmark Suite ===');
    if (run.meta.title) {
        console.log(`Title: ${run.meta.title}`);
    }
    console.log(`Date: ${run.meta.date}`);
    console.log(`Node: ${run.meta.node}`);
    console.log(`Platform: ${run.meta.platform} ${run.meta.arch}`);
}

export async function bench(
    name: string,
    fn: () => void | Promise<void>,
    options: { warmup?: number; minOps?: number; minMs?: number } = {}
): Promise<BenchResult> {
    const { warmup = 100, minOps = 1000, minMs = 1000 } = options;

    // Warmup
    for (let i = 0; i < warmup; i++) {
        await fn();
    }

    // Run until we have enough samples or time
    let ops = 0;
    const start = performance.now();
    let elapsed = 0;

    while (ops < minOps || elapsed < minMs) {
        await fn();
        ops++;
        elapsed = performance.now() - start;
    }

    const totalMs = elapsed;
    const usPerOp = (totalMs * 1000) / ops;
    const opsPerSec = ops / (totalMs / 1000);

    return { name, ops, totalMs, usPerOp, opsPerSec };
}

export async function benchSync(
    name: string,
    fn: () => void,
    options: { warmup?: number; minOps?: number; minMs?: number } = {}
): Promise<BenchResult> {
    const { warmup = 1000, minOps = 10000, minMs = 1000 } = options;

    // Warmup
    for (let i = 0; i < warmup; i++) {
        fn();
    }

    // Try to trigger GC if available
    if (global.gc) {
        global.gc();
    }

    // Run until we have enough samples or time
    let ops = 0;
    const start = performance.now();
    let elapsed = 0;

    while (ops < minOps || elapsed < minMs) {
        fn();
        ops++;
        // Check time less frequently for fast ops
        if (ops % 1000 === 0) {
            elapsed = performance.now() - start;
        }
    }
    elapsed = performance.now() - start;

    const totalMs = elapsed;
    const usPerOp = (totalMs * 1000) / ops;
    const opsPerSec = ops / (totalMs / 1000);

    return { name, ops, totalMs, usPerOp, opsPerSec };
}

export function createMeta(title?: string): BenchRun['meta'] {
    return {
        date: new Date().toISOString(),
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        title,
    };
}

export function tryGc(): void {
    if (global.gc) {
        global.gc();
    }
}
