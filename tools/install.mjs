/**
 * 安装/更新本插件到某个 DSH profile。
 *
 * 做两件事，都是幂等的：
 * 1. 把本包**复制**进 `<profile>/node_modules/dsh-session-cost`；
 * 2. 在 `<profile>/cordis.patch.yml` 里补上本插件的 loader 行（已存在就跳过）。
 *
 * 为什么是复制而不是目录联结：Windows 上联结会被 Node realpath 回本仓库路径，
 * 于是 `lib/projection.js` 里的裸导入 `zod` 会从本仓库往上找而**找不到**（工作区没有
 * node_modules），插件在装载阶段就炸。复制进 profile 后，`zod` 从 profile 自己的
 * node_modules 解析，与 profile 里其它本地插件（dsh-skill-panel）完全同构。
 * 代价是改完代码要重跑一次本脚本 —— 它就是为这一步准备的。
 *
 * 用法：
 *   node tools/install.mjs [profileName] [--profileDir <绝对路径>] [--dry-run]
 * 默认 profile 名是 `desktop`。
 */

import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import process from 'node:process'

const ENTRY_ID = 'ui-session-cost'
const PACKAGE_NAME = 'dsh-session-cost'
/** DSH 家目录：与 dsh-home-paths 的默认约定一致，可用 DSH_HOME 覆盖。 */
const DSH_HOME = process.env.DSH_HOME ?? path.join(process.env.USERPROFILE ?? '', '.dsh')
/** 要同步进 profile 的顶层条目（package.json 的 files 字段同源）。 */
const COPY_ENTRIES = ['lib', 'cordis.patch.yml', 'package.json', 'README.md']

const args = process.argv.slice(2)
const profileName = args.find((arg) => !arg.startsWith('--')) ?? 'desktop'
const dryRun = args.includes('--dry-run')
const profileDirArg = args.indexOf('--profileDir')
const profileDir = profileDirArg === -1
  ? path.join(DSH_HOME, 'profiles', profileName)
  : args[profileDirArg + 1]

const pluginDir = path.resolve(import.meta.dirname, '..')
const targetDir = path.join(profileDir, 'node_modules', PACKAGE_NAME)
const patchPath = path.join(profileDir, 'cordis.patch.yml')

if (!fs.existsSync(profileDir)) {
  console.error(`profile 目录不存在：${profileDir}`)
  process.exit(1)
}

/**
 * 递归复制文件或目录。
 *
 * 刻意不用 `fs.cpSync`：它在 Windows 上走 `\\?\` 扩展长度路径，在受限沙箱里会被
 * 判成拒绝访问（EIO），而这里手动走 readdir/copyFile 就没有这个问题。
 * @param {string} from - 源路径。
 * @param {string} to - 目标路径。
 * @returns {void}
 */
function copyRecursive(from, to) {
  const stat = fs.statSync(from)
  if (!stat.isDirectory()) {
    fs.mkdirSync(path.dirname(to), { recursive: true })
    fs.copyFileSync(from, to)
    return
  }
  fs.mkdirSync(to, { recursive: true })
  for (const dirent of fs.readdirSync(from, { withFileTypes: true })) {
    copyRecursive(path.join(from, dirent.name), path.join(to, dirent.name))
  }
}

// ---- 1. 同步文件 ----------------------------------------------------------

const linkStat = fs.lstatSync(targetDir, { throwIfNoEntry: false })
if (linkStat?.isSymbolicLink()) {
  // 早期版本装成过目录联结：先摘掉链接本身（不会碰到链接指向的目录）。
  if (!dryRun) fs.unlinkSync(targetDir)
  console.log(`已摘除旧的目录联结：${targetDir}`)
}

// 只在真正要写的时候建目录：--dry-run 承诺"不写任何文件"，mkdir 也算写。
if (!dryRun) fs.mkdirSync(path.dirname(targetDir), { recursive: true })
for (const entry of COPY_ENTRIES) {
  const from = path.join(pluginDir, entry)
  if (!fs.existsSync(from)) continue
  const to = path.join(targetDir, entry)
  if (dryRun) {
    console.log(`would copy ${entry} → ${to}`)
    continue
  }
  fs.rmSync(to, { recursive: true, force: true })
  copyRecursive(from, to)
}
console.log(dryRun ? `将同步文件到：${targetDir}` : `已同步文件到：${targetDir}`)

// ---- 2. profile patch -----------------------------------------------------

const patch = fs.readFileSync(patchPath, 'utf8')
if (patch.includes(PACKAGE_NAME)) {
  console.log(`patch 已有本插件行，跳过：${patchPath}`)
} else if (dryRun) {
  console.log(`would append loader row to：${patchPath}`)
} else {
  const block = [
    '',
    `# ${PACKAGE_NAME}: 输入框正下方统计栏里的会话费用胶囊（命中/未命中费用 + 按轮明细）`,
    '- insert:',
    `    - id: ${ENTRY_ID}`,
    `      name: '${PACKAGE_NAME}'`,
    '',
  ].join('\n')
  fs.writeFileSync(patchPath, patch.replace(/\s*$/, '') + '\n' + block)
  console.log(`已在 patch 追加 loader 行：${patchPath}`)
}

// ---- 3. 依赖检查 ----------------------------------------------------------

// 宿主半区裸导入 `zod`（投影 schema）。**复制安装不会带依赖**，而缺了它插件会在装载
// 阶段直接失败——界面上什么都看不到，用户完全无从判断。所以这里主动探一次，
// 缺了就给出可执行的补装命令。（走插件市场 / npm 安装时依赖会一起装上，不会触发。）
const zodProbe = createRequire(path.join(profileDir, 'index.js'))
try {
  zodProbe.resolve('zod')
  console.log('依赖检查：profile 里能解析到 zod ✓')
} catch {
  console.warn([
    '',
    '⚠ 这个 profile 里解析不到 zod —— 本插件的宿主半区 import 它做投影 schema，',
    '  缺了它插件会在装载阶段失败（界面上不会出现任何东西）。复制安装不会带依赖。',
    '  在 profile 目录补装一次即可：',
    `    cd "${profileDir}"`,
    '    pnpm add zod      # 或用 npm i zod；DSH 自带 pnpm 在 <DSH 安装目录>/resources/runtime/pnpm',
    '  （用插件市场 / npm 安装本插件则无需这一步：依赖会随之装上。）',
  ].join('\n'))
}

console.log(dryRun ? '\n（dry-run，未改动任何文件）' : '\n完成。宿主半区需要重启 DSH 生效；浏览器半区刷新页面即可。')
