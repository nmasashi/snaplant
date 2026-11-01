#!/usr/bin/env node
'use strict';

/**
 * リポジトリ直下の .work/（一時ファイルの置き場。Git の管理外）の中身を消す
 *
 * 使い方（リポジトリ直下で）:
 *   node scripts/clean-work.js                    # 消すものを数えて、リンクを並べるだけ（何も消さない）
 *   node scripts/clean-work.js --apply            # 消す
 *   node scripts/clean-work.js --apply --keep spike-tags --keep notes.md   # 直下の名前を指定して残す
 *
 * なぜ rm -rf を使わないか: .work/ には、ジャンクションやシンボリックリンクが混ざる
 * （api の複製の node_modules を作業ツリーへつなぐジャンクション、flutter pub get が作る
 * .plugin_symlinks の Pub のキャッシュへのリンク）。中をたどって消すと、リンク先の本物
 * （作業ツリーの node_modules、Pub のキャッシュ）まで消えうる。
 *
 * そのため、
 *   1. lstat で歩き、リンクの中には入らない
 *   2. リンクを先に、リンクそのものだけ外す（Windows のジャンクション・ディレクトリへのリンクは
 *      中身の無い rmdir で、ファイルへのリンクは unlink で。どちらもリンク先は消さない）
 *   3. 歩き直して、リンクが残っていないことを確かめてから、ファイルを消し、ディレクトリを深い順に
 *      中身の無い rmdir で消す（再帰的な削除の関数は使わない）
 * 消す前に毎回、消すパスが .work/ の中にあることを確かめる。.work/ そのものは残す。
 *
 * 終了コード: 消せなかったものがあれば 1（使用中のファイルなど。パスを出す）、引数の誤りは 2。
 */

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '.work');

/** 引数を読む */
function parseArgs(argv) {
  const options = { apply: false, keep: new Set() };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--apply') {
      options.apply = true;
    } else if (arg === '--keep' && i + 1 < argv.length) {
      const name = argv[++i];
      // 直下の名前だけを受ける（区切りや .. で .work/ の外や奥を指させない）
      if (name === '' || name === '.' || name === '..' || /[\\/]/.test(name)) {
        throw new Error(`--keep には .work/ の直下の名前を1つずつ渡してください: ${name}`);
      }
      options.keep.add(name);
    } else {
      throw new Error(`知らない引数です: ${arg}`);
    }
  }
  return options;
}

/** [target] が .work/ の中（.work/ そのものは除く）にあるか */
function isInsideRoot(target) {
  const relative = path.relative(root, target);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/**
 * .work/ の直下のうち [keep] に無いものから、リンクの中には入らずに歩く。
 * リンク・ファイル・ディレクトリ（深い順）を分けて返す
 */
function walk(keep) {
  const found = { links: [], files: [], dirs: [] };
  const visit = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const target = path.join(dir, name);
      const stat = fs.lstatSync(target);
      if (stat.isSymbolicLink()) {
        // Node は Windows のジャンクションも isSymbolicLink() で返す
        found.links.push(target);
      } else if (stat.isDirectory()) {
        visit(target);
        found.dirs.push(target);
      } else {
        found.files.push(target);
      }
    }
  };
  for (const name of fs.readdirSync(root)) {
    if (keep.has(name)) continue;
    const target = path.join(root, name);
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink()) {
      found.links.push(target);
    } else if (stat.isDirectory()) {
      visit(target);
      found.dirs.push(target);
    } else {
      found.files.push(target);
    }
  }
  return found;
}

/** リンクの指す先（読めなければ ?） */
function linkTarget(link) {
  try {
    return fs.readlinkSync(link);
  } catch {
    return '?';
  }
}

/** リンクそのものだけを外す。ジャンクション・ディレクトリへのリンクは rmdir、ファイルへのリンクは unlink */
function removeLink(link) {
  try {
    fs.rmdirSync(link);
  } catch {
    fs.unlinkSync(link);
  }
}

/** ファイルを消す。読み取り専用（Git のオブジェクトなど）なら書き込めるようにしてからもう一度 */
function removeFile(file) {
  try {
    fs.unlinkSync(file);
  } catch (error) {
    if (error.code !== 'EPERM' && error.code !== 'EACCES') throw error;
    fs.chmodSync(file, 0o666);
    fs.unlinkSync(file);
  }
}

/** [action] を [targets] に1つずつ行い、消せなかったものを [failures] に足す。消せた数を返す */
function removeEach(targets, action, failures) {
  let removed = 0;
  for (const target of targets) {
    if (!isInsideRoot(target)) {
      failures.push(`${target}: .work/ の外なので消しません`);
      continue;
    }
    try {
      action(target);
      removed++;
    } catch (error) {
      failures.push(`${target}: ${error.code ?? error.message}`);
    }
  }
  return removed;
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    return 2;
  }

  let rootStat;
  try {
    rootStat = fs.lstatSync(root);
  } catch {
    console.log(`${root} がありません。消すものは無し`);
    return 0;
  }
  // .work/ そのものがリンクなら、リンク先を消すことになるので止める
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    console.error(`${root} が普通のディレクトリではないので止めます`);
    return 1;
  }

  const found = walk(options.keep);
  console.log(`対象: ${root}`);
  if (options.keep.size > 0) console.log(`残す: ${[...options.keep].join(', ')}`);
  console.log(`リンク ${found.links.length} 個・ファイル ${found.files.length} 個・ディレクトリ ${found.dirs.length} 個`);
  for (const link of found.links) {
    console.log(`  リンク: ${path.relative(root, link)} -> ${linkTarget(link)}`);
  }
  if (!options.apply) {
    console.log('数えただけです（消すには --apply）');
    return 0;
  }

  const failures = [];
  const links = removeEach(found.links, removeLink, failures);
  if (failures.length > 0) {
    console.error('リンクを外せなかったので、ほかは消さずに止めます:');
    for (const failure of failures) console.error(`  ${failure}`);
    return 1;
  }

  // リンクを外した後の姿で歩き直し、リンクが残っていないことを確かめる（中をたどって消さないため）
  const rest = walk(options.keep);
  if (rest.links.length > 0) {
    console.error('リンクが残っているので止めます:');
    for (const link of rest.links) console.error(`  ${link}`);
    return 1;
  }
  const files = removeEach(rest.files, removeFile, failures);
  const dirs = removeEach(rest.dirs, (dir) => fs.rmdirSync(dir), failures);

  console.log(`外したリンク ${links} 個・消したファイル ${files} 個・消したディレクトリ ${dirs} 個`);
  if (failures.length > 0) {
    console.error(`消せなかったもの ${failures.length} 個:`);
    for (const failure of failures) console.error(`  ${failure}`);
    return 1;
  }
  return 0;
}

process.exitCode = main();
