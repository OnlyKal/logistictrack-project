import { Module } from '@nestjs/common'
import { APP_GUARD } from '@nestjs/core'
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler'
import { AuthGuard } from './common/auth.guard.js'
import { CoreModule } from './common/core.module.js'
import { Public } from './common/context.js'
import { Controller, Get } from '@nestjs/common'
import { AuthModule } from './modules/auth/auth.module.js'
import { CatalogModule } from './modules/catalog/catalog.module.js'
import { DeliveriesModule } from './modules/deliveries/deliveries.module.js'
import { FleetModule } from './modules/fleet/fleet.module.js'
import { OrdersModule } from './modules/orders/orders.module.js'
import { ReportsModule } from './modules/reports/reports.module.js'
import { ImportsModule } from './modules/imports/imports.module.js'
import { JobsService } from './modules/saas/jobs.service.js'
import { RealtimeGateway } from './modules/saas/realtime.gateway.js'
import { SaasModule } from './modules/saas/saas.module.js'
import { StockModule } from './modules/stock/stock.module.js'
import { TrackingModule } from './modules/tracking/tracking.module.js'

@Public()
@Controller()
export class HealthController {
  @Get('health')
  health() { return { status: 'ok' } }
}

@Module({
  imports: [
    ThrottlerModule.forRoot({ throttlers: [{ ttl: 60_000, limit: Number(process.env.RATE_LIMIT_PER_MINUTE ?? 600) }], skipIf: () => process.env.THROTTLE_DISABLED === 'true' }),
    CoreModule, AuthModule, CatalogModule, StockModule, OrdersModule, DeliveriesModule, FleetModule, TrackingModule, SaasModule, ImportsModule, ReportsModule,
  ],
  controllers: [HealthController],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
    RealtimeGateway,
    JobsService,
  ],
})
export class AppModule {}
