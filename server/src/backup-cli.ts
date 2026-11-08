/**
 * Sauvegarde et restauration en ligne de commande.
 *   npm run backup                      sauvegarde immédiate
 *   npm run restore -- <dossier>        restauration (serveur arrêté)
 */
import 'dotenv/config'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { cp, copyFile, readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { PrismaClient } from '@prisma/client'
import { backupRoot, runBackup } from './common/backup.js'

const [command, target] = process.argv.slice(2)

async function restore(name: string) {
  const folder = existsSync(name) ? resolve(name) : join(backupRoot(), name)
  const manifest = JSON.parse(await readFile(join(folder, 'manifest.json'), 'utf8'))
  const url = process.env.DATABASE_URL ?? ''
  const database = await readFile(join(folder, manifest.databaseFile))
  if (createHash('sha256').update(database).digest('hex') !== manifest.databaseSha256) throw new Error('Sauvegarde altérée : son empreinte ne correspond pas au manifeste. Restauration annulée.')
  // Filet de sécurité : l'état actuel est sauvegardé avant d'être remplacé.
  const prisma = new PrismaClient()
  try {
    const safety = await runBackup(prisma)
    console.log(`État actuel mis de côté : ${join(backupRoot(), safety.name)}`)
  } finally {
    await prisma.$disconnect()
  }
  if (manifest.engine === 'mysql') {
    console.log(`Base MySQL : gunzip -c "${join(folder, manifest.databaseFile)}" | mysql -h <hôte> -u <utilisateur> -p <base>`)
  } else {
    if (!url.startsWith('file:')) throw new Error('DATABASE_URL doit désigner un fichier SQLite pour cette sauvegarde.')
    const dbPath = resolve('prisma', url.slice('file:'.length))
    for (const suffix of ['-wal', '-shm']) await rm(dbPath + suffix, { force: true })
    await copyFile(join(folder, manifest.databaseFile), dbPath)
    console.log(`Base restaurée : ${dbPath}`)
  }
  if (existsSync(join(folder, 'storage'))) {
    const storage = resolve(process.env.STORAGE_DIR ?? './storage')
    await rm(storage, { recursive: true, force: true })
    await cp(join(folder, 'storage'), storage, { recursive: true })
    console.log(`Fichiers restaurés : ${manifest.files} fichier(s) dans ${storage}`)
  }
}

async function main() {
  if (command === 'restore') {
    if (!target) throw new Error('Indiquez la sauvegarde : npm run restore -- <dossier>')
    await restore(target)
    return
  }
  const prisma = new PrismaClient()
  try {
    const info = await runBackup(prisma)
    console.log(`Sauvegarde ${info.name} : base ${Math.round(info.databaseBytes / 1024)} Ko, ${info.files} fichier(s)${info.copiedTo ? `, copie dans ${info.copiedTo}` : ''}.`)
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((error) => {
  console.error((error as Error).message)
  process.exit(1)
})
