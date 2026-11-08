import { CustomerMailService } from './customer-mail.service.js'
import { Body, Controller, Get, Header, HttpCode, Module, NotFoundException, Param, Patch, Post, Query, Res, StreamableFile, UploadedFile, UseInterceptors } from '@nestjs/common'
import { Throttle } from '@nestjs/throttler'
import { FileInterceptor } from '@nestjs/platform-express'
import type { Response } from 'express'
import { z } from 'zod'
import { AllowDriver, Ctx, DriverOnly, RequirePerm, type TenantContext, FinishesMission } from '../../common/context.js'
import { Idempotent, Msg, parsePage, zod } from '../../common/http.js'
import { DeliveriesService } from './deliveries.service.js'
import { DOCUMENT_TYPES, DocumentsService, type DocumentType } from './documents.service.js'
import { StockModule } from '../stock/stock.module.js'
import {
  assignSchema, cancelSchema, confirmSchema, deliveryPatch, deliverySchema, failSchema, incidentSchema, opSchema, packageSchema, partialSchema, proofSchema,
  rescheduleSchema, respondSchema, returnSchema, scanSchema, recallSchema } from './deliveries.schemas.js'

type Q = Record<string, unknown>

@Controller('packages')
export class PackagesController {
  constructor(private readonly svc: DeliveriesService) {}

  @RequirePerm('delivery.view', 'package.manage') @Get()
  list(@Ctx() ctx: TenantContext, @Query() q: Q) { return this.svc.listPackages(ctx, parsePage(q)) }

  @RequirePerm('package.manage') @Post() @Msg('Colis créé.')
  create(@Ctx() ctx: TenantContext, @Body(zod(packageSchema)) body: z.infer<typeof packageSchema>) { return this.svc.createPackage(ctx, body) }

  @RequirePerm('package.manage', 'delivery.load') @AllowDriver() @FinishesMission('scan') @Post('scan') @HttpCode(200)
  scan(@Ctx() ctx: TenantContext, @Body(zod(scanSchema)) body: z.infer<typeof scanSchema>) { return this.svc.scan(ctx, body) }

  @RequirePerm('delivery.view', 'package.manage') @Get(':id')
  get(@Ctx() ctx: TenantContext, @Param('id') id: string) { return this.svc.getPackage(ctx, id) }

  @RequirePerm('delivery.view', 'package.manage') @Get(':id/tracking')
  tracking(@Ctx() ctx: TenantContext, @Param('id') id: string) { return this.svc.packageTracking(ctx, id) }

  @RequirePerm('package.manage', 'delivery.view') @Post(':id/generate-qr') @HttpCode(200)
  qr(@Ctx() ctx: TenantContext, @Param('id') id: string) { return this.svc.packageQr(ctx, id) }
}

@Controller('deliveries')
export class DeliveriesController {
  constructor(private readonly svc: DeliveriesService, private readonly docs: DocumentsService) {}

  @RequirePerm('delivery.view') @AllowDriver() @Get()
  list(@Ctx() ctx: TenantContext, @Query() q: Q) { return this.svc.list(ctx, parsePage(q)) }

  @RequirePerm('delivery.create') @Idempotent() @Post() @Msg('Livraison créée.')
  create(@Ctx() ctx: TenantContext, @Body(zod(deliverySchema)) body: z.infer<typeof deliverySchema>) { return this.svc.create(ctx, body) }

  @RequirePerm('delivery.view') @AllowDriver() @Get(':id')
  get(@Ctx() ctx: TenantContext, @Param('id') id: string) { return this.svc.detail(ctx, id) }

  @RequirePerm('delivery.create') @Patch(':id')
  update(@Ctx() ctx: TenantContext, @Param('id') id: string, @Body(zod(deliveryPatch)) body: z.infer<typeof deliveryPatch>) { return this.svc.update(ctx, id, body as never) }

  @RequirePerm('delivery.validate') @Post(':id/validate') @HttpCode(200) @Msg('Livraison validée.')
  validate(@Ctx() ctx: TenantContext, @Param('id') id: string) { return this.svc.validate(ctx, id) }

  @RequirePerm('delivery.assign') @Idempotent() @Post(':id/assign') @HttpCode(200) @Msg('Chauffeur et véhicule affectés.')
  assign(@Ctx() ctx: TenantContext, @Param('id') id: string, @Body(zod(assignSchema)) body: z.infer<typeof assignSchema>) { return this.svc.assign(ctx, id, body) }

  @DriverOnly() @Post(':id/respond') @HttpCode(200)
  respond(@Ctx() ctx: TenantContext, @Param('id') id: string, @Body(zod(respondSchema)) body: z.infer<typeof respondSchema>) { return this.svc.respond(ctx, id, body.accept, body.note) }

  @RequirePerm('delivery.load') @AllowDriver() @Post(':id/load') @HttpCode(200) @Msg('Chargement confirmé.')
  load(@Ctx() ctx: TenantContext, @Param('id') id: string, @Body(zod(opSchema)) body: z.infer<typeof opSchema>) { return this.svc.load(ctx, id, body) }

  @RequirePerm('delivery.assign') @AllowDriver() @FinishesMission('delivery') @Post(':id/start') @HttpCode(200) @Msg('Transport démarré.')
  start(@Ctx() ctx: TenantContext, @Param('id') id: string, @Body(zod(opSchema)) body: z.infer<typeof opSchema>) { return this.svc.start(ctx, id, body) }

  @RequirePerm('delivery.assign') @AllowDriver() @FinishesMission('delivery') @Post(':id/arrive') @HttpCode(200) @Msg('Arrivée confirmée.')
  arrive(@Ctx() ctx: TenantContext, @Param('id') id: string, @Body(zod(opSchema)) body: z.infer<typeof opSchema>) { return this.svc.arrive(ctx, id, body) }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @RequirePerm('delivery.resolve') @AllowDriver() @FinishesMission('delivery') @Post(':id/confirm') @HttpCode(200) @Msg('Livraison confirmée.')
  confirm(@Ctx() ctx: TenantContext, @Param('id') id: string, @Body(zod(confirmSchema)) body: z.infer<typeof confirmSchema>) { return this.svc.confirm(ctx, id, body) }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @RequirePerm('delivery.resolve') @AllowDriver() @FinishesMission('delivery') @Post(':id/partial-confirm') @HttpCode(200) @Msg('Livraison partielle enregistrée.')
  partial(@Ctx() ctx: TenantContext, @Param('id') id: string, @Body(zod(partialSchema)) body: z.infer<typeof partialSchema>) { return this.svc.partialConfirm(ctx, id, body) }

  /** Rappel par le bureau seulement : le chauffeur, lui, déclare un échec. */
  @RequirePerm('delivery.resolve') @FinishesMission('delivery') @Post(':id/recall') @HttpCode(200) @Msg('Chauffeur rappelé.')
  recall(@Ctx() ctx: TenantContext, @Param('id') id: string, @Body(zod(recallSchema)) body: z.infer<typeof recallSchema>) { return this.svc.recall(ctx, id, body) }

  @RequirePerm('delivery.resolve') @AllowDriver() @FinishesMission('delivery') @Post(':id/fail') @HttpCode(200) @Msg('Échec enregistré.')
  fail(@Ctx() ctx: TenantContext, @Param('id') id: string, @Body(zod(failSchema)) body: z.infer<typeof failSchema>) { return this.svc.fail(ctx, id, body) }

  @RequirePerm('delivery.resolve') @Post(':id/reschedule') @HttpCode(200) @Msg('Livraison reprogrammée.')
  reschedule(@Ctx() ctx: TenantContext, @Param('id') id: string, @Body(zod(rescheduleSchema)) body: z.infer<typeof rescheduleSchema>) { return this.svc.reschedule(ctx, id, body) }

  @RequirePerm('delivery.resolve') @FinishesMission('delivery') @Post(':id/return') @HttpCode(200) @Msg('Retour enregistré.')
  returnGoods(@Ctx() ctx: TenantContext, @Param('id') id: string, @Body(zod(returnSchema)) body: z.infer<typeof returnSchema>) { return this.svc.returnGoods(ctx, id, body) }

  @RequirePerm('delivery.cancel') @Post(':id/cancel') @HttpCode(200) @Msg('Livraison annulée.')
  cancel(@Ctx() ctx: TenantContext, @Param('id') id: string, @Body(zod(cancelSchema)) body: z.infer<typeof cancelSchema>) { return this.svc.cancel(ctx, id, body.note) }

  @RequirePerm('delivery.view') @AllowDriver() @FinishesMission('delivery') @Post(':id/incidents') @Msg('Incident signalé.')
  incident(@Ctx() ctx: TenantContext, @Param('id') id: string, @Body(zod(incidentSchema)) body: z.infer<typeof incidentSchema>) { return this.svc.incident(ctx, id, body) }

  @RequirePerm('delivery.resolve') @AllowDriver() @FinishesMission('delivery') @Post(':id/proofs') @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 10 * 1024 * 1024 } })) @Msg('Preuve enregistrée.')
  addProof(@Ctx() ctx: TenantContext, @Param('id') id: string, @Body(zod(proofSchema)) body: z.infer<typeof proofSchema>, @UploadedFile() file?: Express.Multer.File) {
    return this.svc.addProof(ctx, id, body, file)
  }

  @RequirePerm('delivery.view') @AllowDriver() @Get(':id/proofs')
  proofs(@Ctx() ctx: TenantContext, @Param('id') id: string) { return this.svc.proofs(ctx, id) }

  @RequirePerm('delivery.view') @Get(':id/tracking-link')
  trackingLink(@Ctx() ctx: TenantContext, @Param('id') id: string) { return this.svc.trackingLink(ctx, id) }

  @RequirePerm('delivery.view') @AllowDriver() @Get(':id/documents/:type') @Header('Content-Type', 'application/pdf')
  async document(@Ctx() ctx: TenantContext, @Param('id') id: string, @Param('type') type: string, @Res({ passthrough: true }) res: Response) {
    if (!(type in DOCUMENT_TYPES)) throw new NotFoundException('Type de document inconnu.')
    const { buffer, filename } = await this.docs.delivery(ctx, id, type as DocumentType)
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
    return new StreamableFile(buffer)
  }
}

@Controller('proofs')
export class ProofsController {
  constructor(private readonly svc: DeliveriesService) {}

  @RequirePerm('delivery.view') @Get(':id/download')
  download(@Ctx() ctx: TenantContext, @Param('id') id: string) { return this.svc.proofDownload(ctx, id) }
}

@Module({
  imports: [StockModule],
  controllers: [PackagesController, DeliveriesController, ProofsController],
  providers: [DeliveriesService, DocumentsService, CustomerMailService],
  exports: [DeliveriesService],
})
export class DeliveriesModule {}
