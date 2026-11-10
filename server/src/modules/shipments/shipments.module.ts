import { Body, Controller, Get, Header, HttpCode, Injectable, Module, NotFoundException, Param, Post, Put, Query, Res, StreamableFile, UploadedFile, UseInterceptors } from '@nestjs/common'
import { FileInterceptor } from '@nestjs/platform-express'
import { Throttle } from '@nestjs/throttler'
import type { Response } from 'express'
import { z } from 'zod'
import { SHIPMENT_STATUS_LABELS, type ShipmentStatus } from '../../common/constants.js'
import { Ctx, Public, RequirePerm, type TenantContext } from '../../common/context.js'
import { FileService } from '../../common/core.services.js'
import { Idempotent, Msg, parsePage, zod } from '../../common/http.js'
import { PrismaService } from '../../common/prisma.service.js'
import {
  cancelSchema, dispatchSchema, handoverSchema, placeOf, receiveSchema, redirectSchema, shipmentSchema, ShipmentsService, stopsSchema,
} from './shipments.service.js'

type Q = Record<string, unknown>

@Controller('shipments')
export class ShipmentsController {
  constructor(private readonly svc: ShipmentsService) {}

  @RequirePerm('shipment.view') @Get()
  list(@Ctx() ctx: TenantContext, @Query() q: Q) { return this.svc.list(ctx, parsePage(q)) }

  @RequirePerm('shipment.manage') @Idempotent() @Post() @Msg('Colis enregistré.')
  create(@Ctx() ctx: TenantContext, @Body(zod(shipmentSchema)) body: z.infer<typeof shipmentSchema>) { return this.svc.create(ctx, body) }

  @RequirePerm('shipment.manage') @Idempotent() @Post('dispatch') @HttpCode(200) @Msg('Départ enregistré.')
  dispatch(@Ctx() ctx: TenantContext, @Body(zod(dispatchSchema)) body: z.infer<typeof dispatchSchema>) { return this.svc.dispatch(ctx, body) }

  @RequirePerm('shipment.manage') @Idempotent() @Post('receive') @HttpCode(200) @Msg('Arrivée enregistrée.')
  receive(@Ctx() ctx: TenantContext, @Body(zod(receiveSchema)) body: z.infer<typeof receiveSchema>) { return this.svc.receive(ctx, body) }

  /** Tous les entrepôts actifs de l'entreprise : un agent limité à son guichet expédie quand même partout. */
  @RequirePerm('shipment.view') @Get('destinations')
  destinations(@Ctx() ctx: TenantContext) { return this.svc.destinations(ctx) }

  @RequirePerm('shipment.view') @Get(':id')
  get(@Ctx() ctx: TenantContext, @Param('id') id: string) { return this.svc.detail(ctx, id) }

  @RequirePerm('shipment.manage') @Post(':id/redirect') @HttpCode(200) @Msg('Destination modifiée.')
  redirect(@Ctx() ctx: TenantContext, @Param('id') id: string, @Body(zod(redirectSchema)) body: z.infer<typeof redirectSchema>) { return this.svc.redirect(ctx, id, body) }

  @RequirePerm('shipment.manage') @Put(':id/stops') @Msg('Itinéraire enregistré.')
  replaceStops(@Ctx() ctx: TenantContext, @Param('id') id: string, @Body(zod(stopsSchema)) body: z.infer<typeof stopsSchema>) { return this.svc.replaceStops(ctx, id, body) }

  @RequirePerm('shipment.manage') @Post(':id/handover') @HttpCode(200) @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 10 * 1024 * 1024 } })) @Msg('Colis remis.')
  handover(@Ctx() ctx: TenantContext, @Param('id') id: string, @Body(zod(handoverSchema)) body: z.infer<typeof handoverSchema>, @UploadedFile() file?: Express.Multer.File) {
    return this.svc.handover(ctx, id, body, file)
  }

  @RequirePerm('shipment.manage') @Post(':id/cancel') @HttpCode(200) @Msg('Expédition annulée.')
  cancel(@Ctx() ctx: TenantContext, @Param('id') id: string, @Body(zod(cancelSchema)) body: z.infer<typeof cancelSchema>) { return this.svc.cancel(ctx, id, body) }

  @RequirePerm('shipment.view') @Get(':id/signature')
  signature(@Ctx() ctx: TenantContext, @Param('id') id: string) { return this.svc.signature(ctx, id) }

  @RequirePerm('shipment.view') @Get(':id/receipt') @Header('Content-Type', 'application/pdf')
  async receipt(@Ctx() ctx: TenantContext, @Param('id') id: string, @Res({ passthrough: true }) res: Response) {
    const { buffer, filename } = await this.svc.receipt(ctx, id)
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
    return new StreamableFile(buffer)
  }
}

/** Ce que voit le public : l'état et le parcours du colis, jamais les noms ni les téléphones de l'expéditeur et du destinataire. */
const PUBLIC_HINT: Record<ShipmentStatus, string> = {
  REGISTERED: 'Votre colis est enregistré. Il partira bientôt.',
  IN_TRANSIT: 'Votre colis est en route.',
  AT_WAREHOUSE: 'Votre colis fait escale avant de poursuivre sa route.',
  AVAILABLE: 'Votre colis vous attend. Présentez-vous avec le numéro de suivi et une pièce d’identité.',
  DELIVERED: 'Le colis a été retiré.',
  RETURNED: 'Le colis a été rendu à l’expéditeur.',
  CANCELLED: 'Cette expédition a été annulée.',
}

@Injectable()
export class ShipmentTrackingService {
  constructor(private readonly prisma: PrismaService, private readonly files: FileService) {}

  async view(token: string) {
    const place = { select: { id: true, name: true, address: true, phone: true, agency: { select: { name: true } } } }
    const s = await this.prisma.shipment.findUnique({
      where: { trackingToken: token },
      include: {
        company: { select: { id: true, tradeName: true, phone: true, email: true, logoFileId: true } },
        originWarehouse: place, destinationWarehouse: place, currentWarehouse: place, nextWarehouse: place,
        stops: { orderBy: { position: 'asc' }, include: { warehouse: place } },
        events: { where: { isPublic: true }, orderBy: { occurredAt: 'asc' }, select: { type: true, label: true, place: true, warehouseId: true, occurredAt: true } },
      },
    })
    if (!s) throw new NotFoundException('Lien de suivi invalide.')
    const status = s.status as ShipmentStatus
    const dest = s.destinationWarehouse

    // Parcours : le dépôt, chaque escale atteinte, le trajet en cours, puis le retrait à destination.
    const steps: Array<{ key: string; label: string; at: Date | null; state: string }> = []
    s.events.forEach((e, i) => {
      if (e.type === 'DEPOSITED') steps.push({ key: `e${i}`, label: e.label, at: e.occurredAt, state: 'done' })
      // Une disponibilité dans un autre entrepôt que la destination actuelle (destination changée depuis) compte comme une escale.
      if (e.type === 'ARRIVED' || (e.type === 'AVAILABLE' && e.warehouseId !== dest.id)) steps.push({ key: `e${i}`, label: `Arrivé à ${e.place ?? ''}`, at: e.occurredAt, state: 'done' })
    })
    if (status === 'IN_TRANSIT' && s.nextWarehouse && s.nextWarehouse.id !== dest.id) {
      const left = [...s.events].reverse().find((e) => e.type === 'DEPARTED')
      steps.push({ key: 'transit', label: `En route vers ${placeOf(s.nextWarehouse)}`, at: left?.occurredAt ?? null, state: 'current' })
    }
    // Escales prévues encore à faire : visibles dès le dépôt, pour que le client connaisse tout le trajet.
    for (const stop of s.stops) {
      if (stop.arrivedAt || stop.skipped || (status === 'IN_TRANSIT' && stop.warehouseId === s.nextWarehouseId)) continue
      if (['DELIVERED', 'RETURNED', 'CANCELLED'].includes(status)) continue
      steps.push({ key: `stop${stop.position}`, label: `Escale prévue : ${placeOf(stop.warehouse)}`, at: null, state: 'todo' })
    }
    const availableAt = [...s.events].reverse().find((e) => e.type === 'AVAILABLE' && e.warehouseId === dest.id)?.occurredAt ?? null
    const finalLeg = status === 'IN_TRANSIT' && s.nextWarehouse?.id === dest.id
    if (['CANCELLED', 'RETURNED'].includes(status)) {
      steps.push({ key: status, label: SHIPMENT_STATUS_LABELS[status], at: s.pickedUpAt ?? s.events.at(-1)?.occurredAt ?? null, state: 'failed' })
    } else {
      steps.push({
        key: 'available', label: `${finalLeg ? 'En route vers' : 'Disponible au retrait à'} ${placeOf(dest)}`,
        at: finalLeg ? [...s.events].reverse().find((e) => e.type === 'DEPARTED')?.occurredAt ?? null : availableAt,
        state: status === 'DELIVERED' ? 'done' : status === 'AVAILABLE' || finalLeg ? 'current' : 'todo',
      })
      steps.push({ key: 'picked', label: 'Retiré', at: s.pickedUpAt, state: status === 'DELIVERED' ? 'done' : 'todo' })
    }

    let logoUrl: string | null = null
    if (s.company.logoFileId) {
      const signed = await this.files.signedUrl({ companyId: s.company.id } as never, s.company.logoFileId, 3600).catch(() => null)
      logoUrl = signed?.url ?? null
    }
    const where = status === 'IN_TRANSIT' ? (s.nextWarehouse ? `En route vers ${placeOf(s.nextWarehouse)}` : 'En route') : s.currentWarehouse ? placeOf(s.currentWarehouse) : null
    return {
      kind: 'shipment',
      trackingNumber: s.trackingNumber,
      company: { name: s.company.tradeName, phone: s.company.phone, email: s.company.email, logoUrl },
      status, statusLabel: status === 'IN_TRANSIT' && s.nextWarehouse ? `En route vers ${s.nextWarehouse.name}` : status === 'AT_WAREHOUSE' && s.currentWarehouse ? `Arrivé à ${s.currentWarehouse.name}` : SHIPMENT_STATUS_LABELS[status],
      statusHint: PUBLIC_HINT[status],
      origin: placeOf(s.originWarehouse),
      destination: { label: placeOf(dest), address: dest.address, phone: dest.phone },
      location: ['DELIVERED', 'RETURNED', 'CANCELLED'].includes(status) ? null : where,
      parcels: s.parcels, depositedAt: s.createdAt, pickedUpAt: s.pickedUpAt,
      feeDue: s.paymentMode === 'RECIPIENT' && !s.feePaidAt && Number(s.fee) > 0 ? Number(s.fee) : null,
      steps,
      events: s.events.map((e) => ({ label: e.label, place: e.place, occurredAt: e.occurredAt })),
    }
  }
}

@Public()
@Controller('public/shipments')
export class PublicShipmentsController {
  constructor(private readonly svc: ShipmentTrackingService) {}

  @Throttle({ default: { limit: 90, ttl: 60_000 } })
  @Get(':token')
  view(@Param('token') token: string) { return this.svc.view(token) }
}

@Module({
  controllers: [ShipmentsController, PublicShipmentsController],
  providers: [ShipmentsService, ShipmentTrackingService],
})
export class ShipmentsModule {}
