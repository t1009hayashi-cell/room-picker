#!/usr/bin/env node
/**
 * `node --test` へのファイル指定を、グロブ文字列に頼らず自前で行う。
 *
 * `node --test "dist/test/*.test.js"` は、Nodeのバージョンによってグロブパターンとして
 * 展開されるかどうかが変わる（Windows・Node 24では動くが、GitHub Actionsのubuntu-latest+
 * Node 20では単体テストのステップが13秒で即失敗した＝グロブが展開されず存在しないファイルとして
 * 扱われたと推測される）。シェルのグロブ展開に頼る手もあるが、cmd.exeは展開しないため
 * Windows側の挙動も不安定になる。
 *
 * ディレクトリを自前で走査し、展開済みのファイルパスを渡すことでOS・シェル・Nodeバージョンに
 * 依存しない形にする。
 */
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const dirs = process.argv.slice(2);
if (dirs.length === 0) {
  console.error('使い方: node scripts/run-tests.mjs <dir1> [dir2 ...]');
  process.exit(1);
}

const files = [];
for (const dir of dirs) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch (err) {
    console.error(`ディレクトリを読めません: ${dir}（${err.code === 'ENOENT' ? 'npm run build を先に実行してください' : err.message}）`);
    process.exit(1);
  }
  for (const name of entries) {
    if (/\.test\.(js|mjs)$/.test(name)) files.push(path.join(dir, name));
  }
}

if (files.length === 0) {
  console.error(`テストファイルが見つかりません: ${dirs.join(', ')}`);
  process.exit(1);
}

const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(result.status ?? 1);
