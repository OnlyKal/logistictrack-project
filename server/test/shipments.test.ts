/**
 * Expéditions (messagerie) : X1 dépose un colis au guichet de Kinshasa, l'entreprise l'achemine par une
 * escale (Mbandaka) jusqu'à Kisangani, où X2 le retire. Chacun suit le colis étape par étape.
 * Le stock et les livraisons de marchandises ne bougent pas.
 */
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import type { INestApplication } from '@nestjs/common'
import type { PrismaClient } from '@prisma/client'
import { boot, Client, makeCompany, onHand, PNG, type Co } from './helpers.js'

let app: INestApplication
let cleanup: () => Promise<void>
let prisma: PrismaClient
let flush: () => Promise<void>
let A: Co
let B: Co
let mbandaka: { id: string }
let kisangani: { id: string }
let kisPort: { id: string }
let guichetKin: Client
let guichetMba: Client
let guichetKis: Client
const anon = () => new Client(app)

const must = (r: { status: number; body: { data?: unknown } }, what: string, status = 200) => {
  assert.equal(r.status, status, `${what} : ${JSON.stringify(r.body)}`)
  return r.body.data as Record<string, any>
}
const deposit = async (extra: Record<string, unknown> = {}) => must(await guichetKin.post('/shipments', {
  senderName: 'X1 Mukendi', senderPhone: '+243810000001', senderEmail: 'x1@test.local',
  recipientName: 'X2 Lokuli', recipientPhone: '+243820000002', recipientEmail: 'x2@test.local',
  description: 'Carton de vêtements', parcels: 2, weightKg: 12, fee: 25, originWarehouseId: A.wh.id, destinationWarehouseId: kisangani.id, ...extra,
}), 'dépôt', 201)
const agent = async (email: string, warehouseId: string) => {
  must(await A.admin.post('/users', { fullName: email, email, password: 'Password123', role: 'WAREHOUSE_AGENT', warehouseIds: [warehouseId] }), 'agent', 201)
  const c = new Client(app)
  await c.login(email, 'Password123')
  return c
}
const mails = async (kind: string) => {
  await flush()
  return prisma.emailLog.findMany({ where: { kind }, select: { recipient: true } })
}

before(async () => {
  ;({ app, cleanup } = await boot())
  const { PrismaService } = await import('../src/common/prisma.service.js')
  const { EmailsService } = await import('../src/common/emails.service.js')
  prisma = app.get(PrismaService)
  const emails = app.get(EmailsService)
  flush = () => emails.flush()
  const bcrypt = (await import('bcryptjs')).default
  await prisma.user.create({ data: { fullName: 'Root', email: 'root@test.local', passwordHash: await bcrypt.hash('Password123', 4), isSuperAdmin: true } })
  const root = new Client(app)
  await root.login('root@test.local', 'Password123')
  A = await makeCompany(app, root, 'A')
  B = await makeCompany(app, root, 'B')
  const ag = (name: string) => A.admin.post('/agencies', { name }).then((r) => must(r, name, 201))
  const kin = await ag('Agence Kinshasa')
  const mba = await ag('Agence Mbandaka')
  const kis = await ag('Agence Kisangani')
  must(await A.admin.patch(`/warehouses/${A.wh.id}`, { agencyId: kin.id }), 'rattachement')
  mbandaka = must(await A.admin.post('/warehouses', { name: 'Mbandaka Port', code: 'MBA1', agencyId: mba.id }), 'Mbandaka', 201) as never
  kisangani = must(await A.admin.post('/warehouses', { name: 'Kisangani Centre', code: 'KIS1', agencyId: kis.id, address: 'Bd Mobutu', phone: '+243990000000' }), 'Kisangani', 201) as never
  kisPort = must(await A.admin.post('/warehouses', { name: 'Kisangani Port', code: 'KIS2', agencyId: kis.id }), 'Kisangani Port', 201) as never
  guichetKin = await agent('guichet-kin@test.local', A.wh.id)
  guichetMba = await agent('guichet-mba@test.local', mbandaka.id)
  guichetKis = await agent('guichet-kis@test.local', kisangani.id)
})
after(async () => cleanup())

describe('Expéditions', () => {
  it('Kinshasa → escale Mbandaka → Kisangani : chaque étape est suivie, X2 retire son colis', async () => {
    const stock = await onHand(A)
    const s = await deposit({ paymentMode: 'RECIPIENT' })
    assert.equal(s.status, 'REGISTERED')
    assert.match(s.trackingNumber, /^EX/)
    assert.equal(s.feePaidAt, null)

    // Le public retrouve le colis par son numéro, sans les noms ni les téléphones.
    const found = must(await anon().post('/public/tracking/search', { trackingNumber: s.trackingNumber.toLowerCase() }), 'recherche')
    assert.equal(found.kind, 'shipment')
    const view = async () => must(await anon().get(`/public/shipments/${found.token}`), 'suivi public')
    let pub = await view()
    assert.equal(pub.statusLabel, 'Déposé')
    assert.ok(!JSON.stringify(pub).includes('X1 Mukendi') && !JSON.stringify(pub).includes('+243820000002'), 'aucune donnée personnelle')

    assert.equal((await guichetMba.post('/shipments/dispatch', { shipmentIds: [s.id] })).status, 404, "Mbandaka n'a pas ce colis")
    must(await guichetKin.post('/shipments/dispatch', { shipmentIds: [s.id], toWarehouseId: mbandaka.id, transportInfo: 'Bateau MV Congo' }), 'départ Kinshasa')
    pub = await view()
    assert.equal(pub.statusLabel, 'En route vers Mbandaka Port')

    assert.equal((await guichetKis.post('/shipments/receive', { warehouseId: mbandaka.id, trackingNumbers: [s.trackingNumber] })).status, 403, 'pas dans son entrepôt')
    must(await guichetMba.post('/shipments/receive', { warehouseId: mbandaka.id, trackingNumbers: [s.trackingNumber] }), 'arrivée Mbandaka')
    pub = await view()
    assert.equal(pub.status, 'AT_WAREHOUSE')
    assert.equal(pub.statusLabel, 'Arrivé à Mbandaka Port')
    assert.equal((await mails('shipment.arrived')).length, 2, 'X1 et X2 sont prévenus de l’escale')

    must(await guichetMba.post('/shipments/dispatch', { shipmentIds: [s.id] }), 'départ Mbandaka')
    must(await guichetKis.post('/shipments/receive', { warehouseId: kisangani.id, shipmentIds: [s.id] }), 'arrivée Kisangani')
    pub = await view()
    assert.equal(pub.status, 'AVAILABLE')
    assert.deepEqual(pub.steps.map((x: { label: string; state: string }) => [x.label, x.state]), [
      ['Colis déposé à Entrepôt A (Agence Kinshasa)', 'done'],
      ['Arrivé à Mbandaka Port (Agence Mbandaka)', 'done'],
      ['Disponible au retrait à Kisangani Centre (Agence Kisangani)', 'current'],
      ['Retiré', 'todo'],
    ])
    assert.equal(pub.feeDue, 25)
    assert.deepEqual((await mails('shipment.available')).map((m) => m.recipient).sort(), ['x1@test.local', 'x2@test.local'])

    const noSig = await guichetKis.post(`/shipments/${s.id}/handover`, { name: 'X2 Lokuli' })
    assert.equal(noSig.body.code, 'PROOF_MISSING')
    const sig = { name: 's.png', type: 'image/png', data: PNG }
    assert.equal((await guichetKis.upload(`/shipments/${s.id}/handover`, { name: 'X2 Lokuli' }, sig)).body.code, 'FEE_DUE')
    const done = must(await guichetKis.upload(`/shipments/${s.id}/handover`, { name: 'X2 Lokuli', idDocument: 'CNI 123', feeCollected: 'true' }, sig), 'retrait')
    assert.equal(done.status, 'DELIVERED')
    assert.ok(done.feePaidAt)
    assert.equal(done.events.at(-1).label, 'Retiré à Kisangani Centre (Agence Kisangani)')
    assert.deepEqual((await mails('shipment.delivered')).map((m) => m.recipient), ['x1@test.local'])
    assert.equal((await view()).steps.at(-1).state, 'done')

    assert.deepEqual(await onHand(A), stock, 'le stock ne bouge pas')
    assert.equal((await B.admin.get(`/shipments/${s.id}`)).status, 404, 'une autre entreprise ne voit rien')
  })

  it('X2 demande son colis dans un autre entrepôt, puis le colis retourne à X1', async () => {
    const s = await deposit()
    assert.ok(s.feePaidAt, 'frais payés au dépôt')
    must(await guichetKin.post('/shipments/dispatch', { shipmentIds: [s.id] }), 'départ direct')
    must(await guichetKis.post('/shipments/receive', { warehouseId: kisangani.id, trackingNumbers: [s.trackingNumber] }), 'arrivée')
    const moved = must(await A.admin.post(`/shipments/${s.id}/redirect`, { destinationWarehouseId: kisPort.id }), 'nouvelle destination')
    assert.equal(moved.status, 'AT_WAREHOUSE')
    assert.equal((await guichetKis.post(`/shipments/${s.id}/handover`, { name: 'X2' })).body.code, 'NOT_AVAILABLE')
    must(await guichetKis.post('/shipments/dispatch', { shipmentIds: [s.id] }), 'départ vers le port')
    must(await A.admin.post('/shipments/receive', { warehouseId: kisPort.id, shipmentIds: [s.id] }), 'arrivée au port')
    const back = must(await A.admin.upload(`/shipments/${s.id}/handover`, { name: 'X1 Mukendi', toSender: 'true' }, { name: 's.png', type: 'image/png', data: PNG }), 'rendu')
    assert.equal(back.status, 'RETURNED')
    assert.equal((await A.admin.post(`/shipments/${s.id}/cancel`, {})).status, 409)
  })

  it('itinéraire prévu : plusieurs escales annoncées dès le dépôt, suivies dans l’ordre, sautées ou modifiées', async () => {
    const bumba = must(await A.admin.post('/warehouses', { name: 'Bumba Quai', code: 'BUM1' }), 'Bumba', 201)
    const bad = await guichetKin.post('/shipments', { senderName: 'X1', senderPhone: '+243810000001', recipientName: 'X2', recipientPhone: '+243820000002', description: 'Sac', originWarehouseId: A.wh.id, destinationWarehouseId: kisangani.id, stops: [kisangani.id] })
    assert.equal(bad.status, 422, 'la destination n’est pas une escale')

    const s = await deposit({ stops: [mbandaka.id, bumba.id] })
    assert.deepEqual(s.stops.map((x: { warehouse: { name: string } }) => x.warehouse.name), ['Mbandaka Port', 'Bumba Quai'])
    const token = s.trackingUrl.split('/').pop()
    const steps = async () => must(await anon().get(`/public/shipments/${token}`), 'suivi').steps.map((x: { label: string; state: string }) => `${x.state}:${x.label}`)
    assert.deepEqual(await steps(), [
      'done:Colis déposé à Entrepôt A (Agence Kinshasa)',
      'todo:Escale prévue : Mbandaka Port (Agence Mbandaka)',
      'todo:Escale prévue : Bumba Quai',
      'todo:Disponible au retrait à Kisangani Centre (Agence Kisangani)',
      'todo:Retiré',
    ])

    must(await guichetKin.post('/shipments/dispatch', { shipmentIds: [s.id] }), 'départ')
    let d = must(await A.admin.get(`/shipments/${s.id}`), 'fiche')
    assert.equal(d.nextWarehouse.id, mbandaka.id, 'sans choix, le colis part vers la première escale prévue')
    must(await guichetMba.post('/shipments/receive', { warehouseId: mbandaka.id, shipmentIds: [s.id] }), 'escale Mbandaka')
    must(await guichetMba.post('/shipments/dispatch', { shipmentIds: [s.id] }), 'départ Mbandaka')
    d = must(await A.admin.get(`/shipments/${s.id}`), 'fiche')
    assert.equal(d.nextWarehouse.id, bumba.id, 'puis vers la deuxième')
    assert.ok(d.stops[0].arrivedAt && d.stops[0].departedAt)

    // Le bateau ne s'arrête pas à Bumba : le colis arrive directement à Kisangani.
    must(await guichetKis.post('/shipments/receive', { warehouseId: kisangani.id, shipmentIds: [s.id] }), 'arrivée')
    d = must(await A.admin.get(`/shipments/${s.id}`), 'fiche')
    assert.equal(d.stops[1].skipped, true)
    assert.deepEqual(await steps(), [
      'done:Colis déposé à Entrepôt A (Agence Kinshasa)',
      'done:Arrivé à Mbandaka Port (Agence Mbandaka)',
      'current:Disponible au retrait à Kisangani Centre (Agence Kisangani)',
      'todo:Retiré',
    ])

    // Itinéraire changé après le dépôt.
    const t = await deposit()
    must(await A.admin.put(`/shipments/${t.id}/stops`, { stops: [bumba.id] }), 'nouvel itinéraire')
    must(await guichetKin.post('/shipments/dispatch', { shipmentIds: [t.id] }), 'départ')
    assert.equal(must(await A.admin.get(`/shipments/${t.id}`), 'fiche').nextWarehouse.id, bumba.id)
    assert.equal((await A.admin.put(`/shipments/${t.id}/stops`, { stops: [bumba.id] })).status, 422, 'déjà en route vers cette escale')
  })

  it("annulation avant départ, retrait sur place, et l'agent ne voit que ses entrepôts", async () => {
    const s = await deposit()
    assert.equal((await guichetMba.get(`/shipments/${s.id}`)).status, 404)
    assert.equal(must(await guichetKis.get('/shipments?incoming=' + kisangani.id), 'liste').length, 0)
    must(await guichetKin.post(`/shipments/${s.id}/cancel`, { note: 'Erreur de saisie' }), 'annulation')
    assert.equal((await guichetKin.post('/shipments/dispatch', { shipmentIds: [s.id] })).status, 409)

    const local = await deposit({ destinationWarehouseId: A.wh.id })
    assert.equal(local.status, 'AVAILABLE', 'déposé et retiré au même guichet')
  })
})
