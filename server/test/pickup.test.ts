/**
 * Retrait en entrepôt : ENTR01 expédie depuis son entrepôt de Kinshasa (agence AG01) vers un entrepôt
 * de son agence de Kisangani (AG02), où le client vient chercher sa marchandise. Il peut aussi la retirer
 * dans l'entrepôt de départ, ou la demander dans un autre entrepôt de l'entreprise.
 * La livraison à domicile, elle, ne change pas.
 */
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import type { INestApplication } from '@nestjs/common'
import { arrived, assignedDelivery, boot, Client, finishTrips, makeCompany, onHand, PNG, type Co } from './helpers.js'

let app: INestApplication
let cleanup: () => Promise<void>
let A: Co
let kis1: { id: string; name: string }
let kis2: { id: string; name: string }
let chefKin: Client
let chefKis1: Client

const must = (r: { status: number; body: { data?: unknown } }, what: string, status = 200) => {
  assert.equal(r.status, status, `${what} : ${JSON.stringify(r.body)}`)
  return r.body.data as Record<string, any>
}
const signature = (c: Client, id: string) => c.upload(`/deliveries/${id}/proofs`, { type: 'SIGNATURE' }, { name: 's.png', type: 'image/png', data: PNG })
const stockAt = async (warehouseId: string) => {
  const rows = (await A.admin.get(`/stocks?warehouseId=${warehouseId}&productId=${A.product.id}`)).body.data as Array<{ onHand: number }>
  return rows.reduce((s, r) => s + r.onHand, 0)
}

/** Commande préparée, colis, livraison en retrait validée (prête). */
async function pickupDelivery(quantity: number, pickupWarehouseId: string) {
  const a = A.admin
  const order = must(await a.post('/orders', { customerId: A.customer.id, deliveryPointId: A.point.id, warehouseId: A.wh.id, items: [{ productId: A.product.id, quantity, unitPrice: 12 }] }), 'commande', 201)
  await a.post(`/orders/${order.id}/submit`)
  must(await a.post(`/orders/${order.id}/validate`), 'validation commande')
  must(await a.post(`/orders/${order.id}/prepare`, { items: [{ orderItemId: order.items[0].id, quantity }] }), 'préparation')
  const pack = must(await a.post('/packages', { warehouseId: A.wh.id, orderId: order.id, items: [{ productId: A.product.id, quantity }] }), 'colis', 201)
  const created = must(await a.post('/deliveries', { packageIds: [pack.id], mode: 'PICKUP', pickupWarehouseId }), 'livraison', 201)
  assert.equal(created.mode, 'PICKUP')
  assert.equal(created.pickupWarehouse.id, pickupWarehouseId)
  const ready = must(await a.post(`/deliveries/${created.id}/validate`), 'validation')
  assert.equal(ready.status, 'READY')
  return { order, pack, delivery: ready }
}

before(async () => {
  ;({ app, cleanup } = await boot())
  const { PrismaService } = await import('../src/common/prisma.service.js')
  const prisma = app.get(PrismaService)
  const bcrypt = (await import('bcryptjs')).default
  await prisma.user.create({ data: { fullName: 'Root', email: 'root@test.local', passwordHash: await bcrypt.hash('Password123', 4), isSuperAdmin: true } })
  const root = new Client(app)
  await root.login('root@test.local', 'Password123')
  A = await makeCompany(app, root, 'A')

  const ag01 = must(await A.admin.post('/agencies', { name: 'Agence Kinshasa' }), 'agence 1', 201)
  const ag02 = must(await A.admin.post('/agencies', { name: 'Agence Kisangani' }), 'agence 2', 201)
  must(await A.admin.patch(`/warehouses/${A.wh.id}`, { agencyId: ag01.id }), 'rattachement')
  kis1 = must(await A.admin.post('/warehouses', { name: 'Kisangani Centre', code: 'KIS1', agencyId: ag02.id, address: 'Bd Mobutu, Kisangani' }), 'entrepôt Kis1', 201) as never
  kis2 = must(await A.admin.post('/warehouses', { name: 'Kisangani Port', code: 'KIS2', agencyId: ag02.id }), 'entrepôt Kis2', 201) as never

  must(await A.admin.post('/users', { fullName: 'Chef Kinshasa', email: 'chef-kin@test.local', password: 'Password123', role: 'WAREHOUSE_MANAGER', warehouseIds: [A.wh.id] }), 'chef kin', 201)
  must(await A.admin.post('/users', { fullName: 'Chef Kisangani', email: 'chef-kis@test.local', password: 'Password123', role: 'WAREHOUSE_MANAGER', warehouseIds: [kis1.id] }), 'chef kis', 201)
  chefKin = new Client(app)
  await chefKin.login('chef-kin@test.local', 'Password123')
  chefKis1 = new Client(app)
  await chefKis1.login('chef-kis@test.local', 'Password123')
})
after(async () => cleanup())

describe('Retrait en entrepôt', () => {
  it('Kinshasa → Kisangani : transport par chauffeur, réception, remise au guichet', async () => {
    await finishTrips(A)
    const start = await onHand(A)
    const { order, pack, delivery } = await pickupDelivery(10, kis1.id)
    const id = delivery.id

    const early = await A.admin.post(`/deliveries/${id}/pickup/available`)
    assert.equal(early.status, 409)
    assert.equal(early.body.code, 'PICKUP_ELSEWHERE')
    // L'entrepôt de retrait voit la livraison qui lui est destinée, hors de son périmètre de départ.
    must(await chefKis1.get(`/deliveries/${id}`), 'vue Kisangani')
    assert.ok((await chefKis1.get('/deliveries?limit=100')).body.data.some((d: { id: string }) => d.id === id))

    must(await A.admin.post(`/deliveries/${id}/assign`, { driverId: A.driver.id, vehicleId: A.vehicle.id }), 'affectation')
    await arrived(A, id)
    assert.equal((await onHand(A)).onHand, start.onHand - 10, 'le stock sort de Kinshasa au chargement')

    const driverConfirm = await A.driverClient.post(`/deliveries/${id}/confirm`, { recipientName: 'Client' })
    assert.equal(driverConfirm.status, 403, 'le chauffeur ne remet pas au client')
    assert.equal((await A.driverClient.post(`/deliveries/${id}/pickup/receive`)).status, 403)
    assert.equal((await chefKin.post(`/deliveries/${id}/pickup/receive`)).status, 403, "seul l'entrepôt de retrait réceptionne")

    const received = must(await chefKis1.post(`/deliveries/${id}/pickup/receive`), 'réception')
    assert.equal(received.status, 'AWAITING_PICKUP')
    assert.equal(received.heldAtWarehouseId, kis1.id)
    assert.equal(received.packages[0].status, 'AVAILABLE')
    assert.equal((await A.admin.get(`/drivers/${A.driver.id}`)).body.data.status, 'available', 'le chauffeur est libéré')

    const tracking = (await new Client(app).get(`/public/tracking/${pack.trackingToken}`)).body.data
    assert.equal(tracking.mode, 'PICKUP')
    assert.equal(tracking.status, 'AWAITING_PICKUP')
    assert.match(tracking.destination.label, /Kisangani Centre/)
    assert.deepEqual(tracking.steps.map((s: { key: string }) => s.key), ['REGISTERED', 'PREPARED', 'IN_TRANSIT', 'AVAILABLE', 'DELIVERED'])
    assert.equal(tracking.steps[3].state, 'current')

    const noProof = await chefKis1.post(`/deliveries/${id}/pickup/handover`, { recipientName: 'Jean Client' })
    assert.equal(noProof.status, 422)
    assert.equal(noProof.body.code, 'PROOF_MISSING')
    assert.equal((await signature(chefKis1, id)).status, 201)
    const done = must(await chefKis1.post(`/deliveries/${id}/pickup/handover`, { recipientName: 'Jean Client' }), 'remise')
    assert.equal(done.status, 'DELIVERED')
    assert.equal(done.recipientName, 'Jean Client')
    assert.equal((await A.admin.get(`/orders/${order.id}`)).body.data.status, 'CLOSED')
  })

  it("retrait dans l'entrepôt de départ : sans chauffeur", async () => {
    const start = await onHand(A)
    const { delivery } = await pickupDelivery(5, A.wh.id)
    const id = delivery.id
    const assign = await A.admin.post(`/deliveries/${id}/assign`, { driverId: A.driver.id, vehicleId: A.vehicle.id })
    assert.equal(assign.status, 409)
    assert.equal(assign.body.code, 'PICKUP_ON_SITE')
    assert.equal((await chefKis1.post(`/deliveries/${id}/pickup/available`)).status, 404, 'hors périmètre')

    const available = must(await chefKin.post(`/deliveries/${id}/pickup/available`), 'mise à disposition')
    assert.equal(available.status, 'AWAITING_PICKUP')
    assert.equal((await onHand(A)).onHand, start.onHand - 5, 'le stock sort à la mise à disposition')
    await signature(A.admin, id)
    const done = must(await A.admin.post(`/deliveries/${id}/pickup/handover`, { recipientName: 'Marie' }), 'remise')
    assert.equal(done.status, 'DELIVERED')
  })

  it('le client la demande dans un autre entrepôt, puis ne vient pas : retour dans le stock de cet entrepôt', async () => {
    await finishTrips(A)
    const { delivery } = await pickupDelivery(4, kis1.id)
    const id = delivery.id
    must(await A.admin.post(`/deliveries/${id}/assign`, { driverId: A.driver.id, vehicleId: A.vehicle.id }), 'affectation')
    await arrived(A, id)
    must(await chefKis1.post(`/deliveries/${id}/pickup/receive`), 'réception Kis1')
    const kinshasa = await onHand(A)

    assert.equal((await A.admin.post(`/deliveries/${id}/pickup`, { pickupWarehouseId: kis1.id })).status, 409, 'déjà dans cet entrepôt')
    const moved = must(await A.admin.post(`/deliveries/${id}/pickup`, { pickupWarehouseId: kis2.id, note: 'Le client est au port' }), 'redirection')
    assert.equal(moved.status, 'READY')
    assert.equal(moved.heldAtWarehouseId, kis1.id)
    must(await A.admin.post(`/deliveries/${id}/assign`, { driverId: A.driver.id, vehicleId: A.vehicle.id }), 'nouvelle affectation')
    await arrived(A, id)
    assert.equal((await onHand(A)).onHand, kinshasa.onHand, 'le stock ne sort pas une seconde fois')
    assert.equal((await chefKis1.post(`/deliveries/${id}/pickup/receive`)).status, 403, 'Kis1 ne réceptionne plus')
    const atPort = must(await A.admin.post(`/deliveries/${id}/pickup/receive`), 'réception Kis2')
    assert.equal(atPort.heldAtWarehouseId, kis2.id)

    const before = await stockAt(kis2.id)
    const returned = must(await A.admin.post(`/deliveries/${id}/return`, { condition: 'GOOD', note: 'Client jamais venu' }), 'retour')
    assert.equal(returned.status, 'RETURNED')
    assert.equal(await stockAt(kis2.id), before + 4, 'la marchandise entre dans le stock de Kisangani Port')
    assert.equal((await onHand(A)).onHand, kinshasa.onHand, 'Kinshasa ne bouge pas')
  })

  it('la livraison à domicile ne change pas et refuse les étapes de retrait', async () => {
    const bad = await A.admin.post('/deliveries', { packageIds: [A.product.id], mode: 'PICKUP' })
    assert.equal(bad.status, 422)

    const { delivery } = await assignedDelivery(A, 1)
    assert.equal(delivery.mode, 'HOME')
    assert.equal(delivery.pickupWarehouseId, null)
    const id = delivery.id
    assert.equal((await A.admin.post(`/deliveries/${id}/pickup/available`)).body.code, 'NOT_PICKUP')
    await arrived(A, id)
    assert.equal((await A.admin.post(`/deliveries/${id}/pickup/receive`)).body.code, 'NOT_PICKUP')
    await A.driverClient.upload(`/deliveries/${id}/proofs`, { type: 'SIGNATURE' }, { name: 's.png', type: 'image/png', data: PNG })
    assert.equal((await chefKin.post(`/deliveries/${id}/pickup/handover`, { recipientName: 'Xavier' })).body.code, 'NOT_PICKUP', 'pas de clôture au guichet')
    assert.equal((await chefKin.upload(`/deliveries/${id}/proofs`, { type: 'SIGNATURE' }, { name: 's.png', type: 'image/png', data: PNG })).status, 403, "pas de preuve par l'entrepôt")
    const ok = must(await A.driverClient.post(`/deliveries/${id}/confirm`, { recipientName: 'Jean' }), 'confirmation chauffeur')
    assert.equal(ok.status, 'DELIVERED')
  })
})
