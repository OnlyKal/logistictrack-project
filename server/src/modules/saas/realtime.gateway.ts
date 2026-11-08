import { Logger } from '@nestjs/common'
import { OnGatewayConnection, OnGatewayInit, WebSocketGateway, WebSocketServer } from '@nestjs/websockets'
import { createAdapter } from '@socket.io/redis-adapter'
import { Redis } from 'ioredis'
import type { Server, Socket } from 'socket.io'
import { AuthResolver } from '../../common/auth.guard.js'
import { RealtimeService } from '../../common/core.services.js'
import { PrismaService } from '../../common/prisma.service.js'
import { isLiveKey } from '../../common/public-link.js'

/**
 * Canal WebSocket. Un utilisateur connecté rejoint uniquement les salles de son entreprise :
 * aucun événement ne peut franchir la frontière entre deux entreprises. Une page publique de suivi
 * rejoint seulement la salle de sa livraison, qui ne reçoit que des données filtrées pour le client.
 */
@WebSocketGateway({ cors: { origin: (process.env.WEB_ORIGINS ?? 'http://localhost:5173').split(','), credentials: true } })
export class RealtimeGateway implements OnGatewayInit, OnGatewayConnection {
  private readonly log = new Logger('Realtime')
  @WebSocketServer() server!: Server

  constructor(private readonly realtime: RealtimeService, private readonly resolver: AuthResolver, private readonly prisma: PrismaService) {}

  afterInit(server: Server) {
    this.realtime.server = server
    if (process.env.REDIS_URL) {
      const pub = new Redis(process.env.REDIS_URL)
      const sub = pub.duplicate()
      server.adapter(createAdapter(pub, sub))
      this.log.log('Adaptateur Redis actif')
    }
  }

  async handleConnection(client: Socket) {
    const auth = (client.handshake.auth ?? {}) as { token?: string; trackingToken?: string; key?: string }
    // Page publique de suivi : sans compte, avec le lien signé reçu par e-mail. Une seule salle, celle de cette livraison.
    if (auth.trackingToken) {
      try {
        if (typeof auth.trackingToken !== 'string' || auth.trackingToken.length > 100 || !isLiveKey(auth.trackingToken, auth.key)) throw new Error('lien invalide')
        const pack = await this.prisma.package.findUnique({ where: { trackingToken: auth.trackingToken }, select: { deliveryId: true } })
        if (!pack?.deliveryId) throw new Error('livraison introuvable')
        await client.join(`public:delivery:${pack.deliveryId}`)
      } catch {
        client.emit('auth_error', { message: 'Lien de suivi invalide.' })
        client.disconnect(true)
      }
      return
    }
    try {
      const token = auth.token
      if (!token) throw new Error('jeton manquant')
      const ctx = await this.resolver.fromToken(token)
      await client.join(`user:${ctx.userId}`)
      if (ctx.companyId) {
        await client.join(`company:${ctx.companyId}`)
        if (ctx.permissions.has('tracking.view')) await client.join(`tracking:${ctx.companyId}`)
      }
    } catch {
      client.emit('auth_error', { message: 'Authentification requise.' })
      client.disconnect(true)
    }
  }
}
