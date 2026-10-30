import { build } from 'esbuild'
import { mkdir, writeFile, readFile } from 'node:fs/promises'

const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
await mkdir(new URL('../dist/', import.meta.url), { recursive: true })
await build({
  entryPoints: ['src/index.ts'], outfile: 'dist/index.js', bundle: true,
  platform: 'node', format: 'esm', target: 'node24', packages: 'external', sourcemap: true,
})
const browser = await build({
  entryPoints: ['src/client/index.ts'], bundle: true, write: false,
  platform: 'browser', format: 'cjs', target: 'es2022', jsx: 'automatic',
  external: ['react', 'react/*', 'react-dom', 'react-dom/*', '@deepseek-ai/*'],
  define: { 'process.env.NODE_ENV': '"production"' },
})
const code = browser.outputFiles[0].text
await writeFile('dist/client.js', `window.__ModuleLoader__.load({id:${JSON.stringify(manifest.name)},factory:(require)=>{const module={exports:{}};const exports=module.exports;\n${code}\nreturn module.exports;}});\n`)
