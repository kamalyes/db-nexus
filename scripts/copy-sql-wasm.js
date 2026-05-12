const fs = require('fs')
const path = require('path')

const files = ['sql-wasm.js', 'sql-wasm.wasm']

for (const file of files) {
  const source = path.join(__dirname, '..', 'node_modules', 'sql.js', 'dist', file)
  const target = path.join(__dirname, '..', 'dist', file)

  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.copyFileSync(source, target)
}
