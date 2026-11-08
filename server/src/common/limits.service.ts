import { ForbiddenException, Injectable } from '@nestjs/common'
import { PrismaService } from './prisma.service.js'

export type LimitKey = 'warehouses' | 'users' | 'drivers' | 'vehicles' | 'deliveries'

/** Contrôle les limites propres à l'abonnement de chaque entreprise. Sans valeur : illimité. */
@Injectable()
export class LimitsService {
  constructor(private readonly prisma: PrismaService) {}

  subscription(companyId: string) {
    return this.prisma.subscription.findFirst({ where: { companyId, isCurrent: true } })
  }

  async usage(companyId: string): Promise<Record<LimitKey, number>> {
    const monthStart = new Date()
    monthStart.setUTCDate(1)
    monthStart.setUTCHours(0, 0, 0, 0)
    const [warehouses, users, drivers, vehicles, deliveries] = await Promise.all([
      this.prisma.warehouse.count({ where: { companyId, status: { not: 'closed' } } }),
      this.prisma.companyMembership.count({ where: { companyId, isActive: true, role: { not: 'DRIVER' } } }),
      this.prisma.driver.count({ where: { companyId, deletedAt: null } }),
      this.prisma.vehicle.count({ where: { companyId, deletedAt: null } }),
      this.prisma.delivery.count({ where: { companyId, createdAt: { gte: monthStart } } }),
    ])
    return { warehouses, users, drivers, vehicles, deliveries }
  }

  async assertCanAdd(companyId: string, key: LimitKey) {
    const sub = await this.subscription(companyId)
    if (!sub) return
    const max = { warehouses: sub.maxWarehouses, users: sub.maxUsers, drivers: sub.maxDrivers, vehicles: sub.maxVehicles, deliveries: sub.maxDeliveriesMonth }[key]
    if (max === null || max === undefined) return
    const usage = await this.usage(companyId)
    if (usage[key] >= max) {
      throw new ForbiddenException({ message: `Limite de votre abonnement atteinte (${key} : ${max}).`, code: 'LIMIT_REACHED' })
    }
  }
}
