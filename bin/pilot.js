#!/usr/bin/env node
/**
 * `pilot` CLI entry: loads the headless server bundle with the package root
 * resolved, so the control panel assets and the version are found no matter
 * which directory the command runs from.
 */
'use strict'

const { existsSync } = require('node:fs')
const { join, resolve } = require('node:path')

const root = resolve(__dirname, '..')
const entry = join(root, 'out', 'server', 'main.js')
if (!existsSync(entry)) {
  process.stderr.write(
    `未找到服务器构建产物：${entry}\n请在 pilot/client 目录执行 \`npm run build:server\`（或 pnpm build:server）后重试。\n`,
  )
  process.exit(1)
}

process.env['PILOT_PACKAGE_ROOT'] = root
process.env['PILOT_PANEL_DIR'] = process.env['PILOT_PANEL_DIR'] || join(root, 'companion')
try {
  process.env['PILOT_VERSION'] = require(join(root, 'package.json')).version
} catch {
  // The bundle falls back to a built-in version.
}

require(entry)
