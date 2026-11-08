import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import type { INestApplication } from '@nestjs/common'
import type { PrismaClient } from '@prisma/client'
import { arrived, assignedDelivery, boot, Client, makeCompany, PNG, uid, type Co } from './helpers.js'

let app: INestApplication
let cleanup: () => Promise<void>
let prisma: PrismaClient
let A: Co
let B: Co

/** Tout ce que possède l'entreprise B et que A va tenter d'atteindre. */
const b: Record<string, string> = {}

const must = async (res: { status: number; body: { data?: { id?: string } } }, label: string) => {
  assert.ok(res.status < 300, `${label} : ${res.status} ${JSON.stringify(res.body)}`)
  return res.body.data as { id: string; [k: string]: unknown }
}

before(async () => {
  ;({ app, cleanup } = await boot())
  const { PrismaService } = await import('../src/common/prisma.service.js')
  prisma = app.get(PrismaService)
  const bcrypt = (await import('bcryptjs')).default
  await prisma.user.create({ data: { fullName: 'Root', email: 'root@test.local', passwordHash: await bcrypt.hash('Password123', 4), isSuperAdmin: true } })
  const root = new Client(app)
  await root.login('root@test.local', 'Password123')
  A = await makeCompany(app, root, 'A')
  B = await makeCompany(app, root, 'B')

  const x = B.admin
  b.warehouse = B.wh.id
  b.product = B.product.id
  b.customer = B.customer.id
  b.point = B.point.id
  b.driver = B.driver.id
  b.vehicle = B.vehicle.id
  b.agency = (await must(await x.post('/agencies', { name: 'Agence B', code: 'AGB' }), 'agence')).id
  b.category = (await must(await x.post('/products/categories', { name: 'Catégorie B' }), 'catégorie')).id
  b.supplier = (await must(await x.post('/suppliers', { name: 'Fournisseur B' }), 'fournisseur')).id
  b.zone = (await must(await x.post(`/warehouses/${b.warehouse}/zones`, { name: 'Zone B', code: 'ZB' }), 'zone')).id
  b.aisle = (await must(await x.post(`/warehouses/${b.warehouse}/zones/${b.zone}/aisles`, { name: 'Rayon B', code: 'RB' }), 'rayon')).id
  b.location = (await must(await x.post(`/warehouses/${b.warehouse}/locations`, { code: 'LB1', name: 'Empl B' }), 'emplacement')).id
  b.packaging = (await must(await x.post(`/products/${b.product}/packagings`, { name: 'Palette', type: 'PALLET', quantityPerUnit: 10 }), 'conditionnement')).id
  b.batch = (await must(await x.post(`/products/${b.product}/batches`, { batchNumber: 'LOT-B' }), 'lot')).id
  b.purchase = (await must(await x.post('/purchase-orders', { supplierId: b.supplier, warehouseId: b.warehouse, items: [{ productId: b.product, quantity: 5 }] }), 'bon de commande')).id
  const wh2 = await must(await x.post('/warehouses', { name: 'Second B', code: 'WB2' }), 'entrepôt 2')
  b.warehouse2 = wh2.id
  b.transfer = (await must(await x.post('/stocks/transfers', { fromWarehouseId: b.warehouse, toWarehouseId: wh2.id, items: [{ productId: b.product, quantity: 1 }] }), 'transfert')).id
  b.inventory = (await must(await x.post('/stocks/inventories', { warehouseId: b.warehouse2 }), 'inventaire')).id
  b.balance = (await x.get(`/stocks?warehouseId=${b.warehouse}`)).body.data[0].id
  b.user = (await must(await x.post('/users', { fullName: 'Chef B', email: 'chef-b@test.local', password: 'Password123', role: 'WAREHOUSE_MANAGER', warehouseIds: [b.warehouse] }), 'chef')).id

  const { order, pack, delivery } = await assignedDelivery(B, 2)
  b.order = order.id
  b.orderItem = order.items[0].id
  b.package = pack.id
  b.delivery = delivery.id
  await arrived(B, b.delivery)
  const proof = await must(await B.driverClient.upload(`/deliveries/${b.delivery}/proofs`, { type: 'SIGNATURE' }, { name: 's.png', type: 'image/png', data: PNG }), 'preuve')
  b.proof = proof.id
  b.file = proof.fileId as string
  const free = await assignedDelivery(B, 1)
  b.freePackage = free.pack.id
  b.delivery2 = free.delivery.id
  b.session = (await must(await B.driverClient.post('/tracking/sessions/start', { deliveryId: b.delivery2 }), 'session')).id
  b.route = (await must(await x.post('/routes', { plannedAt: new Date().toISOString(), warehouseId: b.warehouse, driverId: b.driver, vehicleId: b.vehicle, deliveryIds: [b.delivery2] }), 'tournée')).id
})
after(async () => cleanup())

/** Instantané de ce que A ne doit jamais pouvoir changer chez B. */
async function snapshotB() {
  const companyId = B.companyId
  const [wh, prod, cust, drv, veh, stock, deliveries, users] = await Promise.all([
    prisma.warehouse.findMany({ where: { companyId }, orderBy: { id: 'asc' } }),
    prisma.product.findMany({ where: { companyId }, orderBy: { id: 'asc' } }),
    prisma.customer.findMany({ where: { companyId }, orderBy: { id: 'asc' } }),
    prisma.driver.findMany({ where: { companyId }, orderBy: { id: 'asc' } }),
    prisma.vehicle.findMany({ where: { companyId }, orderBy: { id: 'asc' } }),
    prisma.stockBalance.findMany({ where: { companyId }, orderBy: { id: 'asc' } }),
    prisma.delivery.findMany({ where: { companyId }, orderBy: { id: 'asc' } }),
    prisma.companyMembership.findMany({ where: { companyId }, orderBy: { id: 'asc' } }),
  ])
  return JSON.stringify({ wh, prod, cust, drv, veh, stock, deliveries, users })
}

describe("Attaque de l'entreprise A contre l'entreprise B", () => {
  it('toutes les routes visant un identifiant de B répondent 403 ou 404, sans rien modifier', async () => {
    const before = await snapshotB()
    const a = A.admin
    const reads = [
      `/warehouses/${b.warehouse}`, `/warehouses/${b.warehouse}/locations`, `/products/${b.product}`, `/products/${b.product}/stock`,
      `/customers/${b.customer}`, `/customers/${b.customer}/delivery-points`, `/drivers/${b.driver}`, `/vehicles/${b.vehicle}`, `/routes/${b.route}`,
      `/orders/${b.order}`, `/packages/${b.package}`, `/packages/${b.package}/tracking`, `/deliveries/${b.delivery}`, `/deliveries/${b.delivery}/proofs`,
      `/deliveries/${b.delivery}/documents/delivery-note`, `/proofs/${b.proof}/download`, `/users/${b.user}`, `/stocks/inventories/${b.inventory}`,
      `/tracking/drivers/${b.driver}/position`, `/tracking/deliveries/${b.delivery}`, `/tracking/routes/${b.route}`, `/files/${b.file}/url`,
    ]
    const writes: Array<[string, string, object?]> = [
      ['patch', `/agencies/${b.agency}`, { name: 'Pirate' }],
      ['patch', `/warehouses/${b.warehouse}`, { name: 'Pirate' }],
      ['post', `/warehouses/${b.warehouse}/zones`, { name: 'Pirate', code: 'PZ' }],
      ['post', `/warehouses/${b.warehouse}/zones/${b.zone}/aisles`, { name: 'Pirate', code: 'PA' }],
      ['post', `/warehouses/${b.warehouse}/locations`, { code: 'PL', name: 'Pirate' }],
      ['patch', `/products/${b.product}`, { name: 'Pirate' }],
      ['delete', `/products/${b.product}`],
      ['post', `/products/${b.product}/packagings`, { name: 'Pirate', type: 'PALLET', quantityPerUnit: 2 }],
      ['post', `/products/${b.product}/batches`, { batchNumber: 'PIRATE' }],
      ['patch', `/suppliers/${b.supplier}`, { name: 'Pirate' }],
      ['post', `/purchase-orders/${b.purchase}/validate`],
      ['patch', `/customers/${b.customer}`, { name: 'Pirate' }],
      ['post', `/customers/${b.customer}/delivery-points`, { name: 'Pirate', address: 'x', city: 'y' }],
      ['patch', `/customers/${b.customer}/delivery-points/${b.point}`, { name: 'Pirate' }],
      ['patch', `/orders/${b.order}`, { instructions: 'Pirate' }],
      ['post', `/orders/${b.order}/submit`],
      ['post', `/orders/${b.order}/validate`],
      ['post', `/orders/${b.order}/prepare`, { items: [{ orderItemId: b.orderItem, quantity: 1 }] }],
      ['post', `/orders/${b.order}/cancel`, { reason: 'Pirate' }],
      ['post', `/packages/${b.package}/generate-qr`],
      ['patch', `/deliveries/${b.delivery}`, { instructions: 'Pirate' }],
      ['post', `/deliveries/${b.delivery}/validate`],
      ['post', `/deliveries/${b.delivery2}/assign`, { driverId: A.driver.id, vehicleId: A.vehicle.id }],
      ['post', `/deliveries/${b.delivery}/load`],
      ['post', `/deliveries/${b.delivery}/start`],
      ['post', `/deliveries/${b.delivery}/arrive`],
      ['post', `/deliveries/${b.delivery}/confirm`, { recipientName: 'Pirate' }],
      ['post', `/deliveries/${b.delivery}/partial-confirm`, { items: [{ deliveryItemId: b.orderItem, delivered: 1 }], recipientName: 'Pirate' }],
      ['post', `/deliveries/${b.delivery}/proofs`, { type: 'RECIPIENT', value: 'Pirate' }],
      ['post', `/deliveries/${b.delivery}/fail`, { reason: 'OTHER', note: 'Pirate' }],
      ['post', `/deliveries/${b.delivery}/reschedule`, { scheduledAt: new Date().toISOString() }],
      ['post', `/deliveries/${b.delivery}/return`, { reason: 'Pirate' }],
      ['post', `/deliveries/${b.delivery}/cancel`, { reason: 'Pirate' }],
      ['post', `/deliveries/${b.delivery}/incidents`, { type: 'OTHER', description: 'Pirate' }],
      ['patch', `/drivers/${b.driver}`, { fullName: 'Pirate', status: 'suspended' }],
      ['patch', `/vehicles/${b.vehicle}`, { brand: 'Pirate' }],
      ['post', `/vehicles/${b.vehicle}/maintenance`, { description: 'Pirate' }],
      ['put', `/routes/${b.route}/stops`, { deliveryIds: [b.delivery2] }],
      ['post', `/routes/${b.route}/stops`, { deliveryId: b.delivery2 }],
      ['post', `/routes/${b.route}/start`],
      ['post', `/routes/${b.route}/finish`],
      ['post', '/stocks/adjustments', { balanceId: b.balance, countedQuantity: 0, reason: 'Pirate' }],
      ['post', '/stocks/issues', { warehouseId: b.warehouse, productId: b.product, quantity: 1, reason: 'LOSS' }],
      ['post', `/stocks/transfers/${b.transfer}/validate`],
      ['post', `/stocks/transfers/${b.transfer}/dispatch`],
      ['post', `/stocks/transfers/${b.transfer}/receive`, {}],
      ['post', `/stocks/transfers/${b.transfer}/cancel`],
      ['post', `/stocks/inventories/${b.inventory}/close`],
      ['patch', `/users/${b.user}`, { fullName: 'Pirate' }],
      ['post', `/users/${b.user}/assign-role`, { role: 'WAREHOUSE_AGENT' }],
      ['post', `/users/${b.user}/deactivate`],
      ['post', `/users/${b.user}/activate`],
      ['post', `/users/${b.user}/reset-password`, { password: 'Pirate12345' }],
    ]
    const leaks: string[] = []
    for (const path of reads) {
      const r = await a.get(path)
      if (![403, 404].includes(r.status)) leaks.push(`GET ${path} -> ${r.status}`)
      if (String(r.body.message).startsWith('Cannot ')) leaks.push(`GET ${path} : route inexistante, attaque non testée`)
    }
    for (const [method, path, body] of writes) {
      const c = a as unknown as Record<string, (p: string, b?: object) => Promise<{ status: number; body: { message?: string } }>>
      const r = method === 'delete' ? await deleteAs(path) : await c[method](path, body)
      if (![403, 404].includes(r.status)) leaks.push(`${method.toUpperCase()} ${path} -> ${r.status} ${JSON.stringify(r.body).slice(0, 140)}`)
      if (String(r.body.message).startsWith('Cannot ')) leaks.push(`${method.toUpperCase()} ${path} : route inexistante, attaque non testée`)
    }
    assert.deepEqual(leaks, [])
    assert.equal(await snapshotB(), before, 'Les données de B ont changé.')
  })

  async function deleteAs(path: string) {
    const request = (await import('supertest')).default
    return request(app.getHttpServer()).delete(`/api/v1${path}`).set('Authorization', `Bearer ${A.admin.token}`)
  }

  it("aucun formulaire de A n'accepte une référence vers une donnée de B", async () => {
    const before = await snapshotB()
    const a = A.admin
    const mine = { warehouseId: A.wh.id, product: A.product.id }
    const attempts: Array<[string, object]> = [
      ['/warehouses', { name: 'R1', code: 'R1', agencyId: b.agency }],
      ['/products', { name: 'R2', reference: 'R2', categoryId: b.category }],
      [`/products/${mine.product}/batches`, { batchNumber: 'R3', supplierId: b.supplier }],
      ['/stocks/receipts', { warehouseId: mine.warehouseId, supplierId: b.supplier, items: [{ productId: mine.product, quantity: 1 }] }],
      ['/stocks/receipts', { warehouseId: mine.warehouseId, purchaseOrderId: b.purchase, items: [{ productId: mine.product, quantity: 1 }] }],
      ['/stocks/receipts', { warehouseId: mine.warehouseId, items: [{ productId: mine.product, quantity: 1, locationId: b.location }] }],
      ['/stocks/receipts', { warehouseId: mine.warehouseId, items: [{ productId: mine.product, quantity: 1, packagingId: b.packaging, packagingQuantity: 1 }] }],
      ['/stocks/issues', { warehouseId: mine.warehouseId, productId: mine.product, quantity: 1, reason: 'LOSS', locationId: b.location }],
      ['/stocks/issues', { warehouseId: mine.warehouseId, productId: mine.product, quantity: 1, reason: 'LOSS', batchId: b.batch }],
      ['/stocks/transfers', { fromWarehouseId: mine.warehouseId, toWarehouseId: b.warehouse, items: [{ productId: mine.product, quantity: 1 }] }],
      ['/stocks/transfers', { fromWarehouseId: b.warehouse, toWarehouseId: mine.warehouseId, items: [{ productId: b.product, quantity: 1 }] }],
      ['/stocks/inventories', { warehouseId: b.warehouse }],
      ['/stocks/inventories', { warehouseId: mine.warehouseId, kind: 'PARTIAL', productIds: [b.product] }],
      ['/stocks/inventories', { warehouseId: mine.warehouseId, kind: 'LOCATION', locationId: b.location }],
      ['/purchase-orders', { supplierId: b.supplier, warehouseId: mine.warehouseId, items: [{ productId: mine.product, quantity: 1 }] }],
      ['/purchase-orders', { supplierId: b.supplier, warehouseId: b.warehouse, items: [{ productId: b.product, quantity: 1 }] }],
      ['/orders', { customerId: A.customer.id, deliveryPointId: b.point, warehouseId: mine.warehouseId, items: [{ productId: mine.product, quantity: 1 }] }],
      ['/orders', { customerId: A.customer.id, deliveryPointId: A.point.id, warehouseId: b.warehouse, items: [{ productId: mine.product, quantity: 1 }] }],
      ['/orders', { customerId: A.customer.id, deliveryPointId: A.point.id, warehouseId: mine.warehouseId, items: [{ productId: b.product, quantity: 1 }] }],
      ['/packages', { warehouseId: b.warehouse, items: [{ productId: mine.product, quantity: 1 }] }],
      ['/packages', { warehouseId: mine.warehouseId, orderId: b.order, items: [{ productId: mine.product, quantity: 1 }] }],
      ['/packages', { warehouseId: mine.warehouseId, items: [{ productId: b.product, quantity: 1 }] }],
      ['/deliveries', { packageIds: [b.freePackage] }],
      ['/deliveries', { packageIds: [b.package], orderId: b.order }],
      ['/routes', { plannedAt: new Date().toISOString(), warehouseId: b.warehouse, driverId: A.driver.id, vehicleId: A.vehicle.id, deliveryIds: [b.delivery2] }],
      ['/routes', { plannedAt: new Date().toISOString(), warehouseId: mine.warehouseId, driverId: b.driver, vehicleId: A.vehicle.id, deliveryIds: [b.delivery2] }],
      ['/drivers', { fullName: 'R', phone: `+24370${Math.floor(Math.random() * 1e7)}`, password: 'Password123', warehouseId: b.warehouse }],
      ['/users', { fullName: 'R', email: `r-${uid()}@test.local`, password: 'Password123', role: 'WAREHOUSE_MANAGER', warehouseIds: [b.warehouse] }],
    ]
    const leaks: string[] = []
    for (const [path, body] of attempts) {
      const r = await a.post(path, body)
      if (r.status < 300) leaks.push(`POST ${path} accepté avec ${JSON.stringify(body).slice(0, 150)}`)
      if (r.status >= 500 || r.status === 400) leaks.push(`POST ${path} -> ${r.status} (attaque non testée) ${JSON.stringify(r.body).slice(0, 150)}`)
    }
    assert.deepEqual(leaks, [])
    assert.equal(await snapshotB(), before)
  })

  it("un colis de A n'est jamais rattaché à une ligne de commande de B", async () => {
    const res = await A.admin.post('/packages', { warehouseId: A.wh.id, items: [{ productId: A.product.id, quantity: 1, orderItemId: b.orderItem }] })
    assert.equal(res.status, 201, JSON.stringify(res.body))
    assert.equal(res.body.data.items[0].orderItemId, null)
    assert.equal(await prisma.packageItem.count({ where: { orderItemId: b.orderItem, package: { companyId: A.companyId } } }), 0)
  })

  it('les filtres et les rapports ne révèlent rien de B', async () => {
    const a = A.admin
    const secrets = Object.values(b)
    const paths = [
      `/stocks?warehouseId=${b.warehouse}`, `/stocks?productId=${b.product}`, `/stocks/movements?warehouseId=${b.warehouse}`, `/stocks/movements`, '/stocks/transfers', '/stocks/inventories',
      `/orders?customerId=${b.customer}`, `/deliveries?driverId=${b.driver}`, '/orders', '/deliveries', '/packages', '/routes', '/drivers', '/vehicles', '/customers', '/products',
      '/products/categories', '/warehouses', '/agencies', '/suppliers', '/purchase-orders', '/users', '/audit-logs', '/notifications', '/notification-templates', '/tracking/drivers/live',
      '/dashboard/overview', `/reports/stocks?warehouseId=${b.warehouse}`, `/reports/deliveries?driverId=${b.driver}&customerId=${b.customer}`, '/reports/drivers', '/reports/warehouses',
      '/reports/stocks', '/reports/deliveries',
    ]
    const leaks: string[] = []
    for (const path of paths) {
      const r = await a.get(path)
      const text = JSON.stringify(r.body)
      if (r.status !== 200) leaks.push(`GET ${path} -> ${r.status}`)
      for (const id of secrets) if (text.includes(id)) leaks.push(`GET ${path} contient ${id}`)
      for (const word of ['Entreprise B', 'Client B', 'Chauffeur B', 'Chef B', 'Fournisseur B', 'Catégorie B', 'Agence B', 'CIM-B', 'V-B']) {
        if (text.includes(word)) leaks.push(`GET ${path} contient « ${word} »`)
      }
    }
    assert.deepEqual(leaks, [])
  })

  it('un chauffeur de A ne touche ni aux missions, ni aux sessions GPS, ni aux colis de B', async () => {
    const d = A.driverClient
    assert.equal((await d.get(`/deliveries/${b.delivery}`)).status, 404)
    assert.ok([403, 404].includes((await d.post('/tracking/sessions/start', { deliveryId: b.delivery })).status))
    const positions = { sessionId: b.session, positions: [{ clientId: uid(), latitude: -4.3, longitude: 15.3, recordedAt: new Date().toISOString() }] }
    assert.equal((await d.post('/tracking/positions', positions)).status, 404)
    await d.post(`/tracking/sessions/${b.session}/stop`)
    assert.equal((await prisma.trackingSession.findUnique({ where: { id: b.session } }))?.stoppedAt, null, 'A a arrêté le suivi de B')
    const qr = (await prisma.package.findUnique({ where: { id: b.package } }))!.qrToken
    assert.ok([403, 404].includes((await d.post('/packages/scan', { token: qr, action: 'VIEW' })).status))
    assert.ok([403, 404].includes((await A.admin.post('/packages/scan', { token: qr, action: 'VIEW' })).status))
  })

  it("le rejeu hors ligne ne renvoie jamais une opération de B à A", async () => {
    const opId = `op-${uid()}`
    const incident = await B.driverClient.post(`/deliveries/${b.delivery}/incidents`, { type: 'OTHER', description: 'Secret de B', clientOpId: opId })
    assert.ok(incident.status < 300, JSON.stringify(incident.body))
    const { delivery } = await assignedDelivery(A, 1)
    const r = await A.driverClient.post(`/deliveries/${delivery.id}/incidents`, { type: 'OTHER', description: 'Incident de A', clientOpId: opId })
    assert.ok(!JSON.stringify(r.body).includes('Secret de B'), 'A a reçu un incident de B')
  })
})

describe("Ce que l'administrateur gère dans son entreprise", () => {
  it("modifie son entreprise, crée entrepôts, chefs d'entrepôt et chauffeurs", async () => {
    const a = A.admin
    await must(await a.patch('/companies/current', { tradeName: 'Entreprise A renommée' }), 'entreprise')
    const wh = await must(await a.post('/warehouses', { name: 'Nouveau dépôt', code: 'ND1' }), 'entrepôt')
    const chef = await must(await a.post('/users', { fullName: 'Chef A', email: 'chef-a@test.local', password: 'Password123', role: 'WAREHOUSE_MANAGER', warehouseIds: [wh.id] }), 'chef')
    assert.deepEqual(chef.warehouseIds, [wh.id])
    const c = new Client(app)
    await c.login('chef-a@test.local', 'Password123')
    const list = (await c.get('/warehouses')).body.data as Array<{ id: string }>
    assert.deepEqual(list.map((w) => w.id), [wh.id], "Le chef ne voit que l'entrepôt qui lui est confié")
    assert.ok([403, 404].includes((await c.get(`/warehouses/${A.wh.id}`)).status))
    assert.equal((await c.post('/users', { fullName: 'X', email: 'x@test.local', password: 'Password123', role: 'COMPANY_ADMIN' })).status, 403)
    assert.equal((await c.post('/drivers', { fullName: 'X', phone: '+243700000099', password: 'Password123' })).status, 403)
  })

  it("réinitialise le mot de passe d'un chef d'entrepôt et d'un chauffeur, et ferme leurs sessions", async () => {
    const a = A.admin
    const chef = await must(await a.post('/users', { fullName: 'Chef Oubli', email: 'oubli@test.local', password: 'Password123', role: 'WAREHOUSE_AGENT' }), 'chef')
    const c = new Client(app)
    await c.login('oubli@test.local', 'Password123')
    await must(await a.post(`/users/${chef.id}/reset-password`, { password: 'Nouveau12345' }), 'réinitialisation')
    assert.equal((await c.get('/auth/me')).status, 401, "L'ancienne session reste ouverte")
    await new Client(app).login('oubli@test.local', 'Nouveau12345')

    const phone = `+24371${Math.floor(Math.random() * 1e7)}`
    const driver = await must(await a.post('/drivers', { fullName: 'Chauffeur Oubli', phone, password: 'Password123' }), 'chauffeur')
    await must(await a.post(`/drivers/${driver.id}/reset-password`, { password: 'Nouveau12345' }), 'réinitialisation chauffeur')
    await new Client(app).login(phone, 'Nouveau12345')
  })

  it("le responsable de flotte ne prend pas la main sur un administrateur par ce biais", async () => {
    const a = A.admin
    await must(await a.post('/users', { fullName: 'Flotte', email: 'flotte@test.local', password: 'Password123', role: 'FLEET_MANAGER' }), 'flotte')
    const f = new Client(app)
    await f.login('flotte@test.local', 'Password123')
    const me = (await a.get('/auth/me')).body.data as { id: string }
    assert.equal((await f.post(`/users/${me.id}/reset-password`, { password: 'Pirate12345' })).status, 403)
    assert.equal((await f.post(`/drivers/${me.id}/reset-password`, { password: 'Pirate12345' })).status, 404)
  })

  it('un chauffeur retiré perd immédiatement son accès, et le retrouve à sa réactivation', async () => {
    const a = A.admin
    const phone = `+24372${Math.floor(Math.random() * 1e7)}`
    const driver = await must(await a.post('/drivers', { fullName: 'Chauffeur Parti', phone, password: 'Password123' }), 'chauffeur')
    const d = new Client(app)
    await d.login(phone, 'Password123')
    assert.equal((await d.get('/drivers/me')).status, 200)
    await must(await a.patch(`/drivers/${driver.id}`, { status: 'inactive' }), 'retrait')
    assert.ok([401, 403].includes((await d.get('/drivers/me')).status), 'La session du chauffeur retiré reste active')
    const again = await new Client(app).post('/auth/login', { identifier: phone, password: 'Password123' })
    assert.ok([401, 403].includes(again.status), 'Le chauffeur retiré peut encore se connecter')
    await must(await a.patch(`/drivers/${driver.id}`, { status: 'available' }), 'réactivation')
    await new Client(app).login(phone, 'Password123')
  })

  it('un chauffeur avec une mission en cours ne peut pas être retiré sans la réaffecter', async () => {
    const { delivery } = await assignedDelivery(A, 1)
    const res = await A.admin.patch(`/drivers/${A.driver.id}`, { status: 'inactive' })
    assert.equal(res.status, 409, JSON.stringify(res.body))
    await A.admin.post(`/deliveries/${delivery.id}/cancel`, { reason: 'Fin du test' })
  })

  it('changer le téléphone du chauffeur change son identifiant de connexion', async () => {
    const a = A.admin
    const first = `+24373${Math.floor(Math.random() * 1e7)}`
    const next = `+24374${Math.floor(Math.random() * 1e7)}`
    const driver = await must(await a.post('/drivers', { fullName: 'Chauffeur Numéro', phone: first, password: 'Password123' }), 'chauffeur')
    await must(await a.patch(`/drivers/${driver.id}`, { phone: next }), 'téléphone')
    await new Client(app).login(next, 'Password123')
    assert.equal((await new Client(app).post('/auth/login', { identifier: first, password: 'Password123' })).status, 401)
    const taken = await a.patch(`/drivers/${driver.id}`, { phone: B.driver.phone })
    assert.equal(taken.status, 409, JSON.stringify(taken.body))
    assert.ok(!JSON.stringify(taken.body).includes('Entreprise B'))
  })
})
