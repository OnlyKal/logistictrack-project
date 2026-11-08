import { BadRequestException,
  ArgumentsHost, CallHandler, Catch, ExceptionFilter, ExecutionContext, HttpException, HttpStatus, Injectable, Logger,
  NestInterceptor, PipeTransform, SetMetadata, StreamableFile, UnprocessableEntityException,
} from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { Prisma } from '@prisma/client'
import { from, map, of, switchMap, catchError, throwError, type Observable } from 'rxjs'
import { z, type ZodType } from 'zod'
import { PrismaService } from './prisma.service.js'

export class ZodPipe<T> implements PipeTransform {
  constructor(private readonly schema: ZodType<T>) {}
  transform(value: unknown): T {
    const parsed = this.schema.safeParse(value ?? {})
    if (!parsed.success) {
      throw new UnprocessableEntityException({
        message: 'Données invalides.',
        code: 'VALIDATION_ERROR',
        errors: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      })
    }
    return parsed.data
  }
}
export const zod = <T>(schema: ZodType<T>) => new ZodPipe(schema)

/**
 * Version PATCH d'un schéma : tous les champs deviennent facultatifs et les valeurs par défaut
 * sont retirées. Avec Zod 4, `.partial()` les réappliquerait et écraserait les champs non envoyés.
 */
export function patchOf<S extends z.ZodRawShape>(schema: z.ZodObject<S>) {
  const shape: Record<string, z.ZodType> = {}
  for (const [key, field] of Object.entries(schema.shape)) {
    const inner = field instanceof z.ZodDefault ? (field.removeDefault() as z.ZodType) : (field as z.ZodType)
    shape[key] = inner.optional()
  }
  return z.object(shape) as unknown as z.ZodObject<{ [K in keyof S]: z.ZodOptional<z.ZodType<z.output<S[K]>>> }>
}

// Types de champs communs
export const qty = z.coerce.number().positive().max(1e12)
export const qtyOrZero = z.coerce.number().min(0).max(1e12)
export const money = z.coerce.number().min(0).max(1e13)
export const uuid = z.string().uuid()
export const lat = z.coerce.number().min(-90).max(90)
export const lng = z.coerce.number().min(-180).max(180)
export const optDate = z.coerce.date().optional().nullable()

const pageQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(25),
  q: z.string().trim().max(100).optional(),
  status: z.string().max(40).optional(),
})
export type PageQuery = { page: number; limit: number; q?: string; status?: string; skip: number; take: number; [k: string]: unknown }

export function parsePage(query: Record<string, unknown>): PageQuery {
  const parsed = pageQuery.safeParse(query)
  const data = parsed.success ? parsed.data : { page: 1, limit: 25 }
  return { ...query, ...data, skip: (data.page - 1) * data.limit, take: data.limit } as PageQuery
}

/** Bornes de période en dates complètes : l'écran les calcule dans le fuseau de l'utilisateur. */
export function parsePeriod(p: Record<string, unknown>): { gte?: Date; lte?: Date } | null {
  const read = (value: unknown) => {
    if (!value) return undefined
    const at = new Date(String(value))
    if (Number.isNaN(at.getTime())) throw new BadRequestException('Période invalide.')
    return at
  }
  const gte = read(p.from)
  const lte = read(p.to)
  return gte || lte ? { gte, lte } : null
}

export class Paged<T> {
  constructor(public items: T[], public total: number, public page: number, public limit: number) {}
}
export const paged = <T>(items: T[], total: number, p: PageQuery) => new Paged(items, total, p.page, p.limit)

export const MESSAGE_KEY = 'lt:message'
/** Message de succès renvoyé dans l'enveloppe de réponse. */
export const Msg = (message: string) => SetMetadata(MESSAGE_KEY, message)

/** Convertit les Decimal Prisma en nombres pour tous les clients. */
function plain(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value
  if (value instanceof Date) return value
  if (Prisma.Decimal.isDecimal(value)) return (value as Prisma.Decimal).toNumber()
  if (Array.isArray(value)) return value.map(plain)
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value)) {
    if (k === 'passwordHash' || k === 'refreshTokenHash') continue
    out[k] = plain(v)
  }
  return out
}

/** Enveloppe de réponse unique : { success, message, data, meta }. */
@Injectable()
export class ResponseInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const message = this.reflector.get<string>(MESSAGE_KEY, context.getHandler()) ?? 'Opération effectuée.'
    return next.handle().pipe(
      map((result) => {
        if (result instanceof StreamableFile || Buffer.isBuffer(result)) return result
        if (result instanceof Paged) {
          return {
            success: true, message, data: plain(result.items),
            meta: { page: result.page, limit: result.limit, total: result.total, pages: Math.ceil(result.total / result.limit) },
          }
        }
        return { success: true, message, data: plain(result ?? null), meta: {} }
      }),
    )
  }
}

/** Erreurs cohérentes : { success:false, message, code, errors }. */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('HTTP')
  catch(exception: unknown, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse()
    let status = HttpStatus.INTERNAL_SERVER_ERROR
    let message = 'Erreur interne du serveur.'
    let code: string | undefined
    let errors: unknown
    if (exception instanceof HttpException) {
      status = exception.getStatus()
      const body = exception.getResponse()
      if (typeof body === 'string') message = body
      else {
        const b = body as { message?: string | string[]; code?: string; errors?: unknown }
        message = Array.isArray(b.message) ? b.message.join(', ') : b.message ?? exception.message
        code = b.code
        errors = b.errors
      }
    } else if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      if (exception.code === 'P2002') {
        status = HttpStatus.CONFLICT
        message = 'Cette valeur existe déjà.'
        code = 'DUPLICATE'
      } else if (exception.code === 'P2025') {
        status = HttpStatus.NOT_FOUND
        message = 'Ressource introuvable.'
      } else if (exception.code === 'P2003') {
        status = HttpStatus.CONFLICT
        message = 'Cette ressource est utilisée par un autre élément.'
      } else {
        this.logger.error(exception)
      }
    } else {
      this.logger.error(exception)
    }
    if (response.headersSent) return
    response.status(status).json({ success: false, message, code, errors })
  }
}

export const IDEMPOTENT_KEY = 'lt:idempotent'
/** La route accepte l'en-tête Idempotency-Key : un même appel répété renvoie la réponse initiale. */
export const Idempotent = () => SetMetadata(IDEMPOTENT_KEY, true)

@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector, private readonly prisma: PrismaService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const enabled = this.reflector.get<boolean>(IDEMPOTENT_KEY, context.getHandler())
    const request = context.switchToHttp().getRequest()
    const key = request.headers['idempotency-key'] as string | undefined
    if (!enabled || !key) return next.handle()
    if (key.length > 100) throw new UnprocessableEntityException('Idempotency-Key trop longue.')
    const scope = `${request.auth?.companyId ?? 'public'}:${request.auth?.userId ?? ''}:${request.method}:${request.route?.path}:${request.params?.id ?? ''}`
    const response = context.switchToHttp().getResponse()

    return from(this.claim(scope, key)).pipe(
      switchMap((existing) => {
        if (existing) {
          response.status(existing.httpStatus ?? 200)
          response.setHeader('Idempotency-Replayed', 'true')
          return of(existing.body)
        }
        return next.handle().pipe(
          switchMap((body) =>
            from(
              this.prisma.idempotencyKey.update({
                where: { scope_key: { scope, key } },
                data: { status: 'done', httpStatus: response.statusCode, response: JSON.stringify(body ?? null) },
              }),
            ).pipe(map(() => body)),
          ),
          catchError((err) =>
            // Un échec libère la clé : le client peut relancer son opération après correction.
            from(this.prisma.idempotencyKey.delete({ where: { scope_key: { scope, key } } }).catch(() => null)).pipe(
              switchMap(() => throwError(() => err)),
            ),
          ),
        )
      }),
    )
  }

  private async claim(scope: string, key: string) {
    try {
      await this.prisma.idempotencyKey.create({ data: { scope, key } })
      return null
    } catch (err) {
      if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') throw err
      const row = await this.prisma.idempotencyKey.findUnique({ where: { scope_key: { scope, key } } })
      if (!row || row.status !== 'done') {
        throw new HttpException({ message: 'Cette opération est déjà en cours.', code: 'IDEMPOTENCY_IN_PROGRESS' }, 409)
      }
      return { httpStatus: row.httpStatus, body: row.response ? JSON.parse(row.response) : null }
    }
  }
}
