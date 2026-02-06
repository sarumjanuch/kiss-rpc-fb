import { readFileSync } from 'fs';
import { BenchRun, BenchResult, padRight, padLeft, formatUs, formatOpsPerSec } from './utils';

interface CompareResult {
    name: string;
    baseline: BenchResult | null;
    current: BenchResult | null;
    diffUsPerOp: number | null;
    diffPercent: number | null;
    faster: boolean | null;
}

function compare(baseline: BenchRun, current: BenchRun): CompareResult[] {
    const allNames = new Set([
        ...Object.keys(baseline.results),
        ...Object.keys(current.results),
    ]);

    const results: CompareResult[] = [];

    for (const name of allNames) {
        const b = baseline.results[name] ?? null;
        const c = current.results[name] ?? null;

        let diffUsPerOp: number | null = null;
        let diffPercent: number | null = null;
        let faster: boolean | null = null;

        if (b && c) {
            diffUsPerOp = c.usPerOp - b.usPerOp;
            diffPercent = ((c.usPerOp - b.usPerOp) / b.usPerOp) * 100;
            faster = c.usPerOp < b.usPerOp;
        }

        results.push({ name, baseline: b, current: c, diffUsPerOp, diffPercent, faster });
    }

    return results;
}

function colorize(text: string, color: 'green' | 'red' | 'yellow' | 'dim'): string {
    const colors: Record<string, string> = {
        green: '\x1b[32m',
        red: '\x1b[31m',
        yellow: '\x1b[33m',
        dim: '\x1b[90m',
        reset: '\x1b[0m',
    };
    return `${colors[color]}${text}${colors.reset}`;
}

function formatDiff(diffPercent: number | null, faster: boolean | null): string {
    if (diffPercent === null) return padLeft('-', 12);

    const abs = Math.abs(diffPercent);
    let text: string;

    if (abs < 1) {
        text = '~same';
    } else if (faster) {
        text = `-${abs.toFixed(1)}%`;
    } else {
        text = `+${abs.toFixed(1)}%`;
    }

    const padded = padLeft(text, 12);

    if (abs < 1) return colorize(padded, 'dim');
    if (abs < 5) return faster ? colorize(padded, 'green') : colorize(padded, 'yellow');
    return faster ? colorize(padded, 'green') : colorize(padded, 'red');
}

function formatIndicator(faster: boolean | null, diffPercent: number | null): string {
    if (faster === null || diffPercent === null) return ' ';
    const abs = Math.abs(diffPercent);
    if (abs < 1) return ' ';
    if (abs < 5) return faster ? colorize('↑', 'green') : colorize('↓', 'yellow');
    if (abs < 20) return faster ? colorize('▲', 'green') : colorize('▼', 'red');
    return faster ? colorize('⬆', 'green') : colorize('⬇', 'red');
}

function printComparison(results: CompareResult[], baseline: BenchRun, current: BenchRun): void {
    console.log('=== fb-rpc Benchmark Comparison ===\n');

    console.log('Baseline:');
    console.log(`  Title: ${baseline.meta.title ?? '(none)'}`);
    console.log(`  Date:  ${baseline.meta.date}`);
    console.log(`  Node:  ${baseline.meta.node}`);

    console.log('\nCurrent:');
    console.log(`  Title: ${current.meta.title ?? '(none)'}`);
    console.log(`  Date:  ${current.meta.date}`);
    console.log(`  Node:  ${current.meta.node}`);

    console.log('\n' + '-'.repeat(95));
    console.log(
        padRight('Benchmark', 35) +
        ' | ' +
        padLeft('Baseline', 14) +
        ' | ' +
        padLeft('Current', 14) +
        ' | ' +
        padLeft('Diff', 12) +
        ' | '
    );
    console.log('-'.repeat(95));

    let fasterCount = 0;
    let slowerCount = 0;
    let sameCount = 0;

    for (const r of results) {
        const name = padRight(r.name, 35);
        const baselineUs = r.baseline ? padLeft(formatUs(r.baseline.usPerOp), 14) : padLeft('-', 14);
        const currentUs = r.current ? padLeft(formatUs(r.current.usPerOp), 14) : padLeft('-', 14);
        const diff = formatDiff(r.diffPercent, r.faster);
        const indicator = formatIndicator(r.faster, r.diffPercent);

        console.log(`${name} | ${baselineUs} | ${currentUs} | ${diff} | ${indicator}`);

        if (r.diffPercent !== null) {
            const abs = Math.abs(r.diffPercent);
            if (abs < 1) sameCount++;
            else if (r.faster) fasterCount++;
            else slowerCount++;
        }
    }

    console.log('-'.repeat(95));

    // Summary
    console.log('\nSummary:');
    if (fasterCount > 0) console.log(colorize(`  ▲ ${fasterCount} faster`, 'green'));
    if (slowerCount > 0) console.log(colorize(`  ▼ ${slowerCount} slower`, 'red'));
    if (sameCount > 0) console.log(colorize(`  ~ ${sameCount} unchanged`, 'dim'));

    // Overall assessment
    console.log();
    if (slowerCount === 0 && fasterCount > 0) {
        console.log(colorize('✓ Overall: Performance improved!', 'green'));
    } else if (fasterCount === 0 && slowerCount > 0) {
        console.log(colorize('✗ Overall: Performance regressed!', 'red'));
    } else if (fasterCount > slowerCount) {
        console.log(colorize('↗ Overall: Mostly improved', 'green'));
    } else if (slowerCount > fasterCount) {
        console.log(colorize('↘ Overall: Mostly regressed', 'yellow'));
    } else {
        console.log(colorize('~ Overall: No significant change', 'dim'));
    }
}

function printJsonComparison(results: CompareResult[], baseline: BenchRun, current: BenchRun): void {
    const output = {
        baseline: baseline.meta,
        current: current.meta,
        results: results.map((r) => ({
            name: r.name,
            baseline_us: r.baseline?.usPerOp ?? null,
            current_us: r.current?.usPerOp ?? null,
            diff_percent: r.diffPercent !== null ? Number(r.diffPercent.toFixed(2)) : null,
            faster: r.faster,
        })),
        summary: {
            faster: results.filter((r) => r.faster === true && Math.abs(r.diffPercent ?? 0) >= 1).length,
            slower: results.filter((r) => r.faster === false && Math.abs(r.diffPercent ?? 0) >= 1).length,
            unchanged: results.filter((r) => r.diffPercent !== null && Math.abs(r.diffPercent) < 1).length,
        },
    };
    console.log(JSON.stringify(output, null, 2));
}

function main(): void {
    const args = process.argv.slice(2);

    if (args.length < 2 || args.includes('--help') || args.includes('-h')) {
        console.log('Usage: npx tsx benchmark/src/compare.ts <baseline.json> <current.json> [--json]');
        console.log();
        console.log('Compare two benchmark runs and show performance differences.');
        console.log();
        console.log('Options:');
        console.log('  --json    Output comparison as JSON');
        console.log();
        console.log('Example:');
        console.log('  npx tsx benchmark/src/compare.ts before.json after.json');
        process.exit(args.includes('--help') ? 0 : 1);
    }

    const outputJson = args.includes('--json');
    const [baselineFile, currentFile] = args.filter((a) => !a.startsWith('--'));

    let baseline: BenchRun;
    let current: BenchRun;

    try {
        baseline = JSON.parse(readFileSync(baselineFile, 'utf-8'));
    } catch (e) {
        console.error(`Error reading baseline file: ${baselineFile}`);
        console.error((e as Error).message);
        process.exit(1);
    }

    try {
        current = JSON.parse(readFileSync(currentFile, 'utf-8'));
    } catch (e) {
        console.error(`Error reading current file: ${currentFile}`);
        console.error((e as Error).message);
        process.exit(1);
    }

    const results = compare(baseline, current);

    if (outputJson) {
        printJsonComparison(results, baseline, current);
    } else {
        printComparison(results, baseline, current);
    }
}

main();
