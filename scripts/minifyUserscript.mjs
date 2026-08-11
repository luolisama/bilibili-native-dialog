/**
 * 生成 Tampermonkey 安装用的压缩脚本和更新元数据。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { minify } from 'terser'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const inputPath = resolve(projectRoot, 'bilibili-native-dialog.user.js')
const minifiedPath = resolve(projectRoot, 'bilibili-native-dialog.min.user.js')
const metadataPath = resolve(projectRoot, 'bilibili-native-dialog.meta.js')

const source = await readFile(inputPath, 'utf8')
const metadataMatch = source.match(/\/\/ ==UserScript==[\s\S]*?\/\/ ==\/UserScript==/)
if (!metadataMatch) {
  throw new Error('未找到 Userscript metadata block')
}

const metadata = metadataMatch[0]
const result = await minify(source, {
  format: {
    comments: false,
  },
})

if (!result.code) {
  throw new Error('Terser 未生成脚本内容')
}

await mkdir(projectRoot, { recursive: true })
await writeFile(minifiedPath, `${metadata}\n${result.code}\n`, 'utf8')
await writeFile(metadataPath, `${metadata}\n`, 'utf8')

console.log(`压缩完成: ${minifiedPath}`)
console.log(`元数据完成: ${metadataPath}`)
