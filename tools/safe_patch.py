#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""可逆补丁工具：改前备份、替换前校验、编译失败自动回滚。

用法:
  python tools/safe_patch.py --file <目标文件> --spec <patch.json>
  python tools/safe_patch.py --file <目标文件> --spec <patch.json> --backup-dir <目录>

patch.json 是一个数组，每项:
  { "old": "原文", "new": "新文本", "max_del": 500, "all": false }

规则:
  - old 必须恰好匹配一次（除非 all=true）
  - 本次替换删除的字符数不得超过 max_del（默认 2000）
  - 改前把原文件备份到 backups/<文件名>.<时间戳>.bak
  - 写回后按扩展名做语法检查（.py → py_compile，.js → node --check）
  - 检查失败自动回滚并退出码 1
"""

import argparse
import datetime
import json
import os
import shutil
import subprocess
import sys

DEFAULT_BACKUP = r'D:\dsh-workspace\chat\backups'


def syntax_ok(path):
    ext = os.path.splitext(path)[1].lower()
    try:
        if ext == '.py':
            r = subprocess.run([sys.executable, '-m', 'py_compile', path],
                               capture_output=True, text=True, timeout=120)
            return r.returncode == 0, (r.stderr or r.stdout)
        if ext in ('.js', '.cjs', '.mjs'):
            node = shutil.which('node') or r'C:\Program Files\nodejs\node.exe'
            r = subprocess.run([node, '--check', path], capture_output=True, text=True, timeout=120)
            return r.returncode == 0, (r.stderr or r.stdout)
        if ext == '.json':
            with open(path, encoding='utf-8') as f:
                json.load(f)
            return True, ''
        if ext == '.ps1':
            cmd = ['powershell.exe', '-NoProfile', '-Command',
                   "$e=$null; [void][System.Management.Automation.Language.Parser]::ParseFile('%s',[ref]$null,[ref]$e); if($e.Count){$e|%%{$_}}else{'ok'}" % path.replace("'", "''")]
            r = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
            return ('ok' in (r.stdout or '')), (r.stdout + r.stderr)
    except Exception as e:
        return False, repr(e)
    return True, ''


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--file', required=True)
    ap.add_argument('--spec', required=True)
    ap.add_argument('--backup-dir', default=DEFAULT_BACKUP)
    args = ap.parse_args()

    path = os.path.abspath(args.file)
    with open(path, encoding='utf-8-sig') as f:
        original = f.read()
    with open(args.spec, encoding='utf-8-sig') as f:
        patches = json.load(f)

    os.makedirs(args.backup_dir, exist_ok=True)
    stamp = datetime.datetime.now().strftime('%Y%m%d-%H%M%S')
    backup = os.path.join(args.backup_dir, os.path.basename(path) + '.' + stamp + '.bak')
    shutil.copyfile(path, backup)
    print('备份:', backup, '(%d 字节)' % os.path.getsize(backup))

    cur = original
    applied = 0
    for i, p in enumerate(patches):
        old = p['old']
        new = p['new']
        max_del = int(p.get('max_del', 2000))
        allow_all = bool(p.get('all', False))
        n = cur.count(old)
        if n == 0:
            print('✗ 第 %d 条：old 未匹配，回滚' % (i + 1))
            shutil.copyfile(backup, path)
            return 1
        if n > 1 and not allow_all:
            print('✗ 第 %d 条：old 匹配了 %d 次（要求唯一），回滚' % (i + 1, n))
            shutil.copyfile(backup, path)
            return 1
        delta = len(old) - len(new) if not allow_all else 0
        if n == 1 and delta > max_del:
            print('✗ 第 %d 条：一次删除 %d 字符，超过上限 %d，回滚' % (i + 1, delta, max_del))
            shutil.copyfile(backup, path)
            return 1
        cur = cur.replace(old, new) if allow_all else cur.replace(old, new, 1)
        applied += 1
        print('✓ 第 %d 条：%+d 字符' % (i + 1, len(new) - len(old)))

    with open(path, 'w', encoding='utf-8') as f:
        f.write(cur)

    ok, detail = syntax_ok(path)
    if not ok:
        print('✗ 语法检查失败，自动回滚：')
        print(detail[:800])
        shutil.copyfile(backup, path)
        return 1

    print('✓ 语法检查通过')
    print('✓ 完成：%d 处，文件 %d → %d 字节' % (applied, len(original), len(cur)))
    return 0


if __name__ == '__main__':
    sys.exit(main())
