import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = join(project, 'dist-mobile')
const destination = join(project, 'android', 'app', 'src', 'main', 'assets', 'public')

if (!existsSync(join(source, 'index.html'))) {
  console.error('dist-mobile/index.html is missing. Run `npm run build:mobile` first.')
  process.exit(1)
}

rmSync(destination, { recursive: true, force: true })
mkdirSync(dirname(destination), { recursive: true })
cpSync(source, destination, { recursive: true })
console.log(`Copied mobile assets to ${destination}`)
