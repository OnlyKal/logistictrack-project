import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common'
import { Prisma, PrismaClient } from '@prisma/client'

export type Tx = Prisma.TransactionClient

/** Conflit de version optimiste sur un solde de stock : la transaction entière sera rejouée. */
export class VersionConflict extends Error {}

const RETRYABLE = new Set(['P2034', 'P1008', 'P2028'])

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Prisma')

  async onModuleInit() {
    await this.$connect()
    if (process.env.DATABASE_URL?.startsWith('file:')) {
      // SQLite : attente des verrous au lieu d'un échec immédiat, journal WAL pour la concurrence.
      await this.$queryRawUnsafe('PRAGMA journal_mode = WAL')
      await this.$queryRawUnsafe('PRAGMA busy_timeout = 8000')
    }
  }

  async onModuleDestroy() {
    await this.$disconnect()
  }

  /**
   * Transaction atomique portable SQLite/MySQL, rejouée en entier en cas de conflit.
   * Le rejeu complet est nécessaire : en REPEATABLE READ (MySQL), relire dans la même
   * transaction renverrait l'ancien instantané.
   */
  async atomic<T>(fn: (tx: Tx) => Promise<T>, attempts = 8): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.$transaction(fn, { maxWait: 10000, timeout: 30000 })
      } catch (err) {
        const code = err instanceof Prisma.PrismaClientKnownRequestError ? err.code : undefined
        const locked = err instanceof Error && /database is locked|deadlock|write conflict/i.test(err.message)
        const retry = err instanceof VersionConflict || (code && RETRYABLE.has(code)) || locked
        if (!retry || attempt >= attempts) {
          if (retry) this.log.warn(`Transaction abandonnée après ${attempt} tentatives`)
          throw err
        }
        await new Promise((r) => setTimeout(r, 20 * attempt + Math.random() * 40))
      }
    }
  }
}
