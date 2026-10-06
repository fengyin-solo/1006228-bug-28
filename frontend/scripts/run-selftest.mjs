// 自测运行器（不依赖 esbuild 原生二进制）：
// 在 Node 里垫一个内存版 localStorage，用 TypeScript 自带的 transpileModule 逐个转译
// src 与脚本里的 .ts，并把 '@/...' 别名解析到 src，输出到临时目录后执行。
// 用法：node scripts/run-selftest.mjs
import { createRequire } from 'node:module'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, basename } from 'node:path'
import { pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const ts = require('typescript')

const root = process.cwd()
const outDir = mkdtempSync(join(tmpdir(), 'bearing-selftest-'))

const transpiled = new Set()

function resolveId(spec, fromFile) {
  let path
  if (spec.startsWith('@/')) {
    path = join(root, 'src', spec.slice(2))
  } else if (spec.startsWith('.')) {
    path = join(dirname(fromFile), spec)
  } else {
    return null // node 内置或 node_modules，走 Node 自己解析
  }
  for (const candidate of [path, `${path}.ts`, join(path, 'index.ts'), `${path}.mjs`, `${path}.js`]) {
    try {
      if (candidate.endsWith('.ts')) {
        const stat = require('fs').statSync(candidate)
        if (stat.isFile()) return candidate
      }
    } catch {}
  }
  return null
}

function outPathFor(file) {
  if (file.startsWith(join(root, 'src'))) {
    return join(outDir, 'src', file.slice(join(root, 'src').length).replace(/\.ts$/, '.mjs'))
  }
  return join(outDir, basename(file).replace(/\.ts$/, '.mjs'))
}

function transpile(file) {
  if (transpiled.has(file)) return
  transpiled.add(file)
  const source = require('fs').readFileSync(file, 'utf8')
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2020,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      verbatimModuleSyntax: false,
    },
    fileName: file,
  })

  // 把相对路径与 '@/...' 改成转译产物路径。
  const rewritten = outputText.replace(
    /(from\s*['"]|import\s*['"])([^'"]+)(['"])/g,
    (match, head, spec, tail) => {
      const resolved = resolveId(spec, file)
      if (!resolved) return match
      transpile(resolved)
      const target = outPathFor(resolved)
      const rel = './' + require('path').relative(dirname(outPathFor(file)), target)
      return `${head}${rel}${tail}`
    },
  )

  const out = outPathFor(file)
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, rewritten)
}

const storage = new Map()
globalThis.window = {
  localStorage: {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
  },
}

const entry = join(root, 'scripts', 'selftest.ts')
transpile(entry)
const mod = await import(pathToFileURL(outPathFor(entry)).href)
await mod.run()
