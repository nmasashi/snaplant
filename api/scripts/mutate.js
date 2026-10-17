#!/usr/bin/env node
'use strict';

/**
 * 変異を1件ずつ入れて、全テストのどれがそれを捕まえるかを確かめる（api 用）
 *
 * 使い方:
 *   cd api
 *   node scripts/mutate.js <mutations.json> [--out <result.json>]
 *
 * <mutations.json> は配列で、要素は { "file", "old", "new", "name"? }。
 *   file: api/ からの相対パス（例 "src/utils/sortAt.ts"）
 *   old:  置き換える前の文字列。ファイル内にちょうど1回だけ現れること
 *   new:  置き換えた後の文字列。空文字なら削除
 *   name: 報告に使う名前。省略時は file と old・new から作る
 *
 * 変異ごとに「退避 → 置換 → 全テストを実行 → 退避から復元 → バイト比較」を回し、
 * 変異で落ちたテスト（殺した）を報告する。どのテストにも捕まらなかった変異は「生き残り」。
 * 変異を入れる前から落ちているテストは数えない。
 * import 先を壊すなど、スイートが読み込みの時点で落ちた変異は、テストが捕まえたとは言えないので「無効」として分ける。
 * 型だけを変える変異は捕まらない（ts-jest は isolatedModules で型検査をしないため、
 * 実行時の振る舞いが変わらなければ生き残りになる）。実行時の振る舞いが変わる変異を選ぶこと。
 *
 * 終了コード: 復元に失敗したときは 1（退避先のパスを出す）、入力の誤りは 2。
 * 生き残りがあっても 0（残すか直すかの判断は読む側がする）。
 *
 * <mutations.json> はその場で書いて捨て、リポジトリに入れない。
 * scripts/ はデプロイのパッケージ（api/ 丸ごと）に含まれるが、実行時に読み込まれることは無い。
 *
 * なぜ既製の道具を使わないか: 既製の変異テストは変異を機械的に大量に作るが、ここで要るのは
 * 「入口のテストがこの退行を捕まえるか」を、人が選んだ変異で1件ずつ確かめること（test-principles.md 原則7）。
 * 依存も package.json も増やさない。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const apiRoot = path.resolve(__dirname, '..');
const jestBin = path.join(apiRoot, 'node_modules', 'jest', 'bin', 'jest.js');

/** 復元に失敗したときだけ投げる。退避先を必ず伝えるために分ける */
class RestoreError extends Error {}

function usage() {
  console.error('使い方: node scripts/mutate.js <mutations.json> [--out <result.json>]');
}

function parseArgs(argv) {
  const args = { input: null, out: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--out') {
      i += 1;
      if (i >= argv.length) {
        usage();
        process.exit(2);
      }
      args.out = argv[i];
    } else if (arg === '--help' || arg === '-h') {
      usage();
      process.exit(0);
    } else if (args.input === null) {
      args.input = arg;
    } else {
      usage();
      process.exit(2);
    }
  }
  if (args.input === null) {
    usage();
    process.exit(2);
  }
  return args;
}

/** api/ の外を指すパスは受け付けない（`..` で別のファイルを書き換えないため） */
function resolveInsideApi(relativePath) {
  const absolute = path.resolve(apiRoot, relativePath);
  const relative = path.relative(apiRoot, absolute);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`api/ の外のファイルは変異の対象にしない: ${relativePath}`);
  }
  return absolute;
}

/** 変異の定義を読み、全件の old がちょうど1回現れることを先に確かめる（途中で止まって前の実行が無駄にならないように） */
function loadMutations(inputPath) {
  const parsed = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('変異の定義は、空でない配列にする');
  }
  return parsed.map((entry, index) => {
    const label = `${index + 1} 件目`;
    if (typeof entry.file !== 'string' || entry.file === '') {
      throw new Error(`${label}: "file" は空でない文字列にする`);
    }
    if (typeof entry.old !== 'string' || entry.old === '') {
      throw new Error(`${label}: "old" は空でない文字列にする`);
    }
    if (typeof entry.new !== 'string') {
      throw new Error(`${label}: "new" は文字列にする（削除なら空文字）`);
    }
    if (entry.old === entry.new) {
      throw new Error(`${label}: old と new が同じ`);
    }
    const absolute = resolveInsideApi(entry.file);
    if (!fs.existsSync(absolute)) {
      throw new Error(`${label}: ファイルが無い: ${entry.file}`);
    }
    const occurrences = fs.readFileSync(absolute, 'utf8').split(entry.old).length - 1;
    if (occurrences !== 1) {
      throw new Error(`${label}: old が ${entry.file} に ${occurrences} 回現れる（ちょうど1回にする）`);
    }
    const name =
      typeof entry.name === 'string' && entry.name !== ''
        ? entry.name
        : `${entry.file}: ${JSON.stringify(entry.old)} → ${JSON.stringify(entry.new)}`;
    return { name, file: entry.file, old: entry.old, new: entry.new, absolute };
  });
}

/** jest を --json で回し、落ちたテストと実行できなかったスイートを拾う。終了コードは見ない（失敗があれば非 0 になるだけ） */
function runJest(tmpDir, label) {
  const outFile = path.join(tmpDir, `jest-${label}.json`);
  const result = spawnSync(
    process.execPath,
    [jestBin, '--json', `--outputFile=${outFile}`, '--silent'],
    { cwd: apiRoot, stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
  );
  if (result.error) {
    throw result.error;
  }
  if (!fs.existsSync(outFile)) {
    throw new Error(`jest の結果ファイルが作られなかった（jest が起動できていない）:\n${result.stderr}`);
  }
  const json = JSON.parse(fs.readFileSync(outFile, 'utf8'));
  fs.unlinkSync(outFile);
  return summarize(json);
}

function summarize(json) {
  const failedTests = [];
  const brokenSuites = [];
  for (const suite of json.testResults) {
    const file = path.relative(apiRoot, suite.name).split(path.sep).join('/');
    // 読み込みの時点の例外（import 先が無いなど）で1件も実行できなかったスイート。テストが捕まえたのとは区別する
    if (suite.status === 'failed' && suite.assertionResults.length === 0) {
      brokenSuites.push(file);
      continue;
    }
    for (const test of suite.assertionResults) {
      if (test.status === 'failed') {
        failedTests.push(`${file} > ${[...test.ancestorTitles, test.title].join(' > ')}`);
      }
    }
  }
  failedTests.sort();
  brokenSuites.sort();
  return { failedTests, brokenSuites, numTotalTests: json.numTotalTests };
}

/** 退避してから置換する。old の出現回数は読み直して確かめる（前の変異と同じファイルでも、復元済みなので元の内容） */
function applyMutation(mutation, tmpDir, index) {
  const original = fs.readFileSync(mutation.absolute);
  const backupPath = path.join(tmpDir, `${index + 1}-${path.basename(mutation.file)}.bak`);
  fs.writeFileSync(backupPath, original);
  const parts = original.toString('utf8').split(mutation.old);
  if (parts.length !== 2) {
    throw new Error(`"${mutation.name}": old が ${mutation.file} に ${parts.length - 1} 回現れる（ちょうど1回にする）`);
  }
  // split/join にしているのは、String.replace の置換文字列で `$` が特別扱いされるのを避けるため
  fs.writeFileSync(mutation.absolute, parts.join(mutation.new));
  return { original, backupPath };
}

function restore(mutation, original, backupPath) {
  try {
    fs.writeFileSync(mutation.absolute, original);
  } catch (error) {
    throw new RestoreError(`復元に失敗: ${mutation.file}（退避: ${backupPath}）: ${error.message}`);
  }
  const after = fs.readFileSync(mutation.absolute);
  if (!after.equals(original)) {
    throw new RestoreError(`復元後の内容が退避と一致しない: ${mutation.file}（退避: ${backupPath}）`);
  }
}

function printList(indent, items) {
  for (const item of items) {
    console.log(`${indent}${item}`);
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const mutations = loadMutations(args.input);
  if (!fs.existsSync(jestBin)) {
    throw new Error(`jest が見つからない（先に npm ci）: ${jestBin}`);
  }
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snaplant-mutate-'));
  console.log(`退避先: ${tmpDir}`);

  // Ctrl+C はテスト実行中の jest にも届いて止まる。親はここで死なずに復元まで進んでから止まる
  let interrupted = false;
  const onSignal = () => {
    interrupted = true;
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  console.log('変異を入れずに全テストを実行（基準）...');
  const baseline = runJest(tmpDir, 'baseline');
  if (baseline.failedTests.length > 0 || baseline.brokenSuites.length > 0) {
    console.log(
      `  注意: 変異を入れる前から ${baseline.failedTests.length} 件のテストが落ち、` +
        `${baseline.brokenSuites.length} 件のスイートが実行できない。これらは数えない`
    );
    printList('    落ちている: ', baseline.failedTests);
    printList('    実行できない: ', baseline.brokenSuites);
  } else {
    console.log(`  ${baseline.numTotalTests} 件すべて通過`);
  }
  if (interrupted) {
    throw new Error('中断された');
  }

  const baselineFailed = new Set(baseline.failedTests);
  const baselineBroken = new Set(baseline.brokenSuites);
  const results = [];
  for (let i = 0; i < mutations.length; i++) {
    const mutation = mutations[i];
    console.log(`\n[${i + 1}/${mutations.length}] ${mutation.name}`);
    const { original, backupPath } = applyMutation(mutation, tmpDir, i);
    let run;
    try {
      run = runJest(tmpDir, `mutation-${i + 1}`);
    } finally {
      restore(mutation, original, backupPath);
    }
    if (interrupted) {
      throw new Error('中断された（変異は戻した）');
    }
    const killedBy = run.failedTests.filter((test) => !baselineFailed.has(test));
    const brokenSuites = run.brokenSuites.filter((suite) => !baselineBroken.has(suite));
    const status = killedBy.length > 0 ? 'killed' : brokenSuites.length > 0 ? 'invalid' : 'survived';
    results.push({ name: mutation.name, file: mutation.file, old: mutation.old, new: mutation.new, status, killedBy, brokenSuites });

    if (status === 'killed') {
      console.log(`  殺した: ${killedBy.length} 件のテストが落ちた`);
      printList('    ', killedBy);
      if (brokenSuites.length > 0) {
        console.log(`  あわせて ${brokenSuites.length} 件のスイートが実行できなかった`);
        printList('    ', brokenSuites);
      }
    } else if (status === 'invalid') {
      console.log(`  無効: テストは落ちず、${brokenSuites.length} 件のスイートが実行できなかった（読み込みで落ちた。変異を選び直す）`);
      printList('    ', brokenSuites);
    } else {
      console.log('  生き残り: どのテストも落ちなかった');
    }
  }

  const survived = results.filter((r) => r.status === 'survived');
  const invalid = results.filter((r) => r.status === 'invalid');
  console.log(
    `\n合計: ${results.length} 件の変異。殺した ${results.length - survived.length - invalid.length}、` +
      `生き残り ${survived.length}、無効 ${invalid.length}`
  );
  printList('  生き残り: ', survived.map((r) => r.name));

  if (args.out) {
    fs.writeFileSync(args.out, JSON.stringify({ baseline, mutations: results }, null, 2) + '\n');
    console.log(`結果を書いた: ${args.out}`);
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

try {
  main();
} catch (error) {
  console.error(`エラー: ${error.message}`);
  process.exit(error instanceof RestoreError ? 1 : 2);
}
