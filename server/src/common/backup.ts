/**
 * Sauvegarde de la base et des fichiers privés (preuves, photos, signatures, logos).
 * Chaque sauvegarde est un dossier daté, autonome et vérifiable : base, fichiers et manifeste.
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync } from 'node:fs'
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { createGzip } from 'node:zlib'
import type { PrismaClient } from '@prisma/client'

export interface BackupInfo {
  name: string
  createdAt: string
  engine: 'sqlite' | 'mysql'
  databaseFile: string
  databaseBytes: number
  databaseSha256: string
  files: number
  filesBytes: number
  copiedTo: string | null
}

export const backupRoot = () => resolve(process.env.BACKUP_DIR ?? './backups')
const keepDays = () => Number(process.env.BACKUP_KEEP_DAYS ?? 14)
const storageRoot = () => resolve(process.env.STORAGE_DIR ?? './storage')

async function sha256File(path: string) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

async function folderStats(path: string): Promise<{ files: number; bytes: number }> {
  if (!existsSync(path)) return { files: 0, bytes: 0 }
  let files = 0
  let bytes = 0
  for (const entry of await readdir(path, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue
    files++
    bytes += (await stat(join(entry.parentPath, entry.name))).size
  }
  return { files, bytes }
}

/** MySQL : export cohérent par mysqldump, compressé. */
async function dumpMysql(url: string, target: string) {
  const u = new URL(url)
  const args = ['--single-transaction', '--quick', '--routines', '--no-tablespaces', '-h', u.hostname, '-P', u.port || '3306', '-u', decodeURIComponent(u.username), u.pathname.slice(1)]
  const child = spawn(process.env.MYSQLDUMP_PATH ?? 'mysqldump', args, { env: { ...process.env, MYSQL_PWD: decodeURIComponent(u.password) } })
  let error = ''
  child.stderr.on('data', (d) => { error += String(d) })
  const exited = new Promise<number>((done, fail) => { child.on('error', fail); child.on('close', done) })
  await pipeline(child.stdout, createGzip(), createWriteStream(target))
  if ((await exited) !== 0) throw new Error(`mysqldump a échoué : ${error.trim()}`)
}

export async function runBackup(prisma: PrismaClient): Promise<BackupInfo> {
  const url = process.env.DATABASE_URL ?? ''
  const engine = url.startsWith('mysql') ? 'mysql' : 'sqlite'
  const name = new Date().toISOString().replace(/[:.]/g, '-')
  const folder = join(backupRoot(), name)
  await mkdir(folder, { recursive: true })
  try {
    const databaseFile = engine === 'sqlite' ? 'database.sqlite' : 'database.sql.gz'
    const databasePath = join(folder, databaseFile)
    // SQLite : copie cohérente même pendant que le serveur écrit.
    if (engine === 'sqlite') await prisma.$executeRawUnsafe(`VACUUM INTO '${databasePath.replace(/'/g, "''")}'`)
    else await dumpMysql(url, databasePath)
    if (existsSync(storageRoot())) await cp(storageRoot(), join(folder, 'storage'), { recursive: true })
    const files = await folderStats(join(folder, 'storage'))
    let copiedTo: string | null = null
    if (process.env.BACKUP_COPY_DIR) {
      copiedTo = join(resolve(process.env.BACKUP_COPY_DIR), name)
      await cp(folder, copiedTo, { recursive: true })
    }
    const info: BackupInfo = {
      name, createdAt: new Date().toISOString(), engine, databaseFile, databaseBytes: (await stat(databasePath)).size, databaseSha256: await sha256File(databasePath),
      files: files.files, filesBytes: files.bytes, copiedTo,
    }
    await writeFile(join(folder, 'manifest.json'), JSON.stringify(info, null, 2))
    if (copiedTo) await writeFile(join(copiedTo, 'manifest.json'), JSON.stringify(info, null, 2))
    await prune()
    return info
  } catch (error) {
    // Une sauvegarde incomplète ne doit jamais passer pour valide.
    await rm(folder, { recursive: true, force: true })
    throw error
  }
}

export async function listBackups(): Promise<BackupInfo[]> {
  if (!existsSync(backupRoot())) return []
  const out: BackupInfo[] = []
  for (const name of await readdir(backupRoot())) {
    const manifest = join(backupRoot(), name, 'manifest.json')
    if (existsSync(manifest)) out.push(JSON.parse(await readFile(manifest, 'utf8')))
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

/** Conservation : les sauvegardes plus anciennes que BACKUP_KEEP_DAYS sont supprimées, la plus récente toujours gardée. */
async function prune() {
  const all = await listBackups()
  const limit = Date.now() - keepDays() * 86400_000
  for (const b of all.slice(1)) if (new Date(b.createdAt).getTime() < limit) await rm(join(backupRoot(), b.name), { recursive: true, force: true })
}

/** Vrai si la dernière sauvegarde a plus de 24 heures. */
export async function backupDue() {
  const [latest] = await listBackups()
  return !latest || Date.now() - new Date(latest.createdAt).getTime() > 24 * 3600_000
}
