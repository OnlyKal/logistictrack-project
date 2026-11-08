import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common'
import { Queue, Worker } from 'bullmq'
import { Redis } from 'ioredis'
import { NotificationService } from '../../common/core.services.js'
import { EmailsService } from '../../common/emails.service.js'
import { PrismaService } from '../../common/prisma.service.js'
import { available } from '../stock/stock.service.js'
import { backupDue, runBackup } from '../../common/backup.js'
import { companyTimeZone, formatDate } from '../../common/time.js'

const HOUR = 3600_000
const QUEUE = 'logistictrack-maintenance'

/**
 * Tâches périodiques. Avec REDIS_URL, elles passent par BullMQ (une seule instance les exécute) ;
 * sans Redis (développement), un minuteur local les remplace.
 */
@Injectable()
export class JobsService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger('Jobs')
  private timer?: NodeJS.Timeout
  private queue?: Queue
  private worker?: Worker
  private connection?: Redis

  constructor(private readonly prisma: PrismaService, private readonly notifications: NotificationService, private readonly emails: EmailsService) {}

  async onApplicationBootstrap() {
    if (process.env.JOBS_DISABLED === 'true') return
    if (process.env.REDIS_URL) {
      this.connection = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: null })
      this.queue = new Queue(QUEUE, { connection: this.connection })
      this.worker = new Worker(QUEUE, () => this.runAll(), { connection: this.connection })
      this.worker.on('failed', (_, err) => this.log.error(err))
      await this.queue.upsertJobScheduler('hourly', { every: HOUR }, { name: 'maintenance' })
      this.log.log('Tâches planifiées via BullMQ')
    } else {
      setTimeout(() => this.backup(), 60_000).unref()
      this.timer = setInterval(() => this.runAll().catch((err) => this.log.error(err)), HOUR)
      this.timer.unref()
      this.log.log('Tâches planifiées par minuteur local (REDIS_URL absent)')
    }
  }

  async onModuleDestroy() {
    if (this.timer) clearInterval(this.timer)
    await this.worker?.close()
    await this.queue?.close()
    await this.connection?.quit().catch(() => undefined)
  }

  async runAll() {
    await this.backup()
    await this.subscriptions()
    await this.purgeGps()
    await this.alerts()
    await this.purgeTokens()
  }

  /** Sauvegarde quotidienne de la base et des fichiers, sauf BACKUP_DISABLED=true. */
  async backup() {
    if (process.env.BACKUP_DISABLED === 'true' || !(await backupDue())) return
    try {
      const info = await runBackup(this.prisma)
      this.log.log(`Sauvegarde ${info.name} : ${info.files} fichier(s)`)
    } catch (error) {
      this.log.error(`Sauvegarde impossible : ${(error as Error).message}`)
    }
  }

  /** Cycle d'abonnement : fin de période, période de grâce, puis expiration (lecture seule). Chaque étape est annoncée par e-mail. */
  async subscriptions(now = new Date()) {
    const due = await this.prisma.subscription.findMany({ where: { isCurrent: true, status: { in: ['TRIAL', 'ACTIVE'] }, endsAt: { lt: now } } })
    for (const s of due) {
      // L'essai gratuit n'a pas de période de grâce : l'entreprise doit s'abonner.
      if (s.status === 'TRIAL') {
        const updated = await this.prisma.subscription.update({ where: { id: s.id }, data: { status: 'EXPIRED' } })
        await this.emails.subscriptionEnded(updated, 'EXPIRED')
        continue
      }
      const graceEndsAt = new Date(s.endsAt.getTime() + s.graceDays * 86400_000)
      const updated = await this.prisma.subscription.update({ where: { id: s.id }, data: { status: graceEndsAt > now ? 'GRACE' : 'EXPIRED', graceEndsAt } })
      await this.emails.subscriptionEnded(updated, updated.status as 'GRACE' | 'EXPIRED')
    }
    const graceOver = await this.prisma.subscription.findMany({ where: { isCurrent: true, status: 'GRACE', graceEndsAt: { lt: now } } })
    for (const s of graceOver) {
      const updated = await this.prisma.subscription.update({ where: { id: s.id }, data: { status: 'EXPIRED' } })
      await this.emails.subscriptionEnded(updated, 'EXPIRED')
    }

    // Rappel dans la cloche une fois par jour pendant les 7 derniers jours ; par e-mail à J-7, J-3 et J-1 (la veille seulement pour l'essai).
    const soon = new Date(now.getTime() + 7 * 86400_000)
    const expiring = await this.prisma.subscription.findMany({ where: { isCurrent: true, status: { in: ['TRIAL', 'ACTIVE'] }, endsAt: { gte: now, lte: soon } } })
    for (const s of expiring) {
      await this.once(s.companyId, ['COMPANY_ADMIN'], 'SUBSCRIPTION_EXPIRING', { date: formatDate(s.endsAt, await companyTimeZone(this.prisma, s.companyId)) }, { type: 'Subscription', id: s.id })
      const daysLeft = Math.max(1, Math.ceil((s.endsAt.getTime() - now.getTime()) / 86400_000))
      // Le palier atteint : à 6 jours restants, le rappel de J-7 part encore s'il n'est jamais parti (serveur arrêté ce jour-là).
      const step = (s.status === 'TRIAL' ? [1] : [7, 3, 1]).filter((d) => daysLeft <= d).at(-1)
      if (step) await this.emails.subscriptionReminder(s, step)
    }
  }

  /** Politique de conservation configurable par entreprise. */
  async purgeGps(now = new Date()) {
    const settings = await this.prisma.companySettings.findMany({ select: { companyId: true, gpsRetentionDays: true } })
    for (const s of settings) {
      await this.prisma.gpsPosition.deleteMany({ where: { companyId: s.companyId, recordedAt: { lt: new Date(now.getTime() - s.gpsRetentionDays * 86400_000) } } })
    }
  }

  private async once(companyId: string, roles: string[], type: string, vars: Record<string, unknown>, ref: { type: string; id: string }) {
    const since = new Date(Date.now() - 24 * HOUR)
    const already = await this.prisma.notification.findFirst({ where: { companyId, type, refId: ref.id, createdAt: { gte: since } } })
    if (!already) await this.notifications.notifyRoles(companyId, roles, type, vars, ref)
  }

  async alerts(now = new Date()) {
    const soon = new Date(now.getTime() + 30 * 86400_000)
    const batches = await this.prisma.productBatch.findMany({ where: { expiresAt: { gte: now, lte: soon } }, include: { product: { select: { name: true } } }, take: 500 })
    for (const b of batches) {
      const left = await this.prisma.stockBalance.findMany({ where: { batchId: b.id } })
      if (left.some((x) => available(x).greaterThan(0))) {
        await this.once(b.companyId, ['COMPANY_ADMIN', 'WAREHOUSE_MANAGER'], 'BATCH_EXPIRING', { batch: b.batchNumber, product: b.product.name, date: formatDate(b.expiresAt, await companyTimeZone(this.prisma, b.companyId)) }, { type: 'ProductBatch', id: b.id })
      }
    }
    const drivers = await this.prisma.driver.findMany({ where: { deletedAt: null, licenseExpiry: { gte: now, lte: soon } } })
    for (const d of drivers) {
      await this.once(d.companyId, ['COMPANY_ADMIN', 'FLEET_MANAGER'], 'LICENSE_EXPIRING', { driver: d.fullName, date: formatDate(d.licenseExpiry, await companyTimeZone(this.prisma, d.companyId)) }, { type: 'Driver', id: d.id })
    }
  }

  async purgeTokens(now = new Date()) {
    await this.prisma.userSession.deleteMany({ where: { expiresAt: { lt: now } } })
    await this.prisma.passwordReset.deleteMany({ where: { expiresAt: { lt: now } } })
    await this.prisma.idempotencyKey.deleteMany({ where: { createdAt: { lt: new Date(now.getTime() - 7 * 86400_000) } } })
  }
}
