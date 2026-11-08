// Génère prisma/mysql/schema.prisma depuis prisma/schema.prisma (provider + types natifs MySQL).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = readFileSync(join(root, 'prisma/schema.prisma'), 'utf8')

const output = source
  .replace('provider = "sqlite"', 'provider = "mysql"')
  .replace(/^(.*?)\s*\/\/ @mysql (.*)$/gm, '$1 $2')

const header = '// FICHIER GÉNÉRÉ — ne pas modifier. Source : prisma/schema.prisma (npm run db:mysql:schema)\n'
mkdirSync(join(root, 'prisma/mysql'), { recursive: true })
writeFileSync(join(root, 'prisma/mysql/schema.prisma'), header + output)
console.log('prisma/mysql/schema.prisma généré')
