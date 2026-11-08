import { Global, Module } from '@nestjs/common'
import { JwtModule } from '@nestjs/jwt'
import { PrismaService } from './prisma.service.js'
import { AuditService, FileService, NotificationService, OutboundService, RealtimeService, SequenceService } from './core.services.js'
import { AuthResolver } from './auth.guard.js'
import { LimitsService } from './limits.service.js'
import { EmailsService } from './emails.service.js'
import { secret } from './util.js'

const providers = [PrismaService, AuditService, SequenceService, RealtimeService, NotificationService, OutboundService, FileService, LimitsService, AuthResolver, EmailsService]

@Global()
@Module({
  imports: [
    JwtModule.registerAsync({
      global: true,
      useFactory: () => ({
        secret: secret('JWT_SECRET'),
        signOptions: { expiresIn: Number(process.env.JWT_ACCESS_TTL_SECONDS ?? 900) },
      }),
    }),
  ],
  providers,
  exports: [...providers, JwtModule],
})
export class CoreModule {}
