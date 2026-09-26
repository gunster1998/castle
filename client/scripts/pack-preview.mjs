// Упаковывает dist-preview в один HTML со встроенными моделями (для публикации демо).
import fs from 'node:fs'
import path from 'node:path'
const ROOT = path.dirname(path.dirname(new URL(import.meta.url).pathname))
const dist = path.join(ROOT, 'dist-preview')
let html = fs.readFileSync(path.join(dist, 'preview.html'), 'utf8')
html = html.replace(/<script type="module" crossorigin src="([^"]+)"><\/script>/, (_, src) => {
  const js = fs.readFileSync(path.join(dist, src), 'utf8').replace(/<\/script/g, '<\\/script')
  return `<script type="module">${js}</script>`
})
const assets = {}
for (const f of fs.readdirSync(path.join(ROOT, 'public/assets'))) {
  if (f.endsWith('.glb')) assets[f.slice(0, -4)] = fs.readFileSync(path.join(ROOT, 'public/assets', f)).toString('base64')
}
// текстуры GLB грузим через <img>, а не fetch(blob:) — так работает и под строгой CSP
const boot = `<script>window.createImageBitmap = undefined; window.__castleAssets = ${JSON.stringify(assets)};</script>`
html = html.replace('<head>', `<head>${boot}`)
fs.writeFileSync(path.join(dist, 'castle-3d-demo.html'), html)
console.log('castle-3d-demo.html', (html.length / 1024 / 1024).toFixed(1), 'MB')
