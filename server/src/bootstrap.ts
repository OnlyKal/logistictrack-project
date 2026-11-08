import { type INestApplication, RequestMethod } from '@nestjs/common'
import { NestFactory, Reflector } from '@nestjs/core'
import type { NestExpressApplication } from '@nestjs/platform-express'
import helmet from 'helmet'
import { AppModule } from './app.module.js'
import { AllExceptionsFilter, IdempotencyInterceptor, ResponseInterceptor } from './common/http.js'
import { PrismaService } from './common/prisma.service.js'

/** Application configurée, partagée entre le serveur et les tests. */
export async function createApp(options: { logger?: false } = {}): Promise<INestApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true, ...options })
  app.set('trust proxy', 1)
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }))
  app.enableCors({ origin: (process.env.WEB_ORIGINS ?? 'http://localhost:5173').split(','), credentials: true, exposedHeaders: ['Content-Disposition'] })
  app.setGlobalPrefix('api/v1', { exclude: [{ path: 'health', method: RequestMethod.GET }] })
  const reflector = app.get(Reflector)
  // L'intercepteur d'idempotence enveloppe la réponse finale, identique lors d'un rejeu.
  app.useGlobalInterceptors(new IdempotencyInterceptor(reflector, app.get(PrismaService)), new ResponseInterceptor(reflector))
  app.useGlobalFilters(new AllExceptionsFilter())
  app.enableShutdownHooks()
  return app
}
