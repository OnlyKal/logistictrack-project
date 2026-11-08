import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { after, before, describe, it } from 'node:test'
import type { INestApplication } from '@nestjs/common'
import { io } from 'socket.io-client'
import { arrived, assignedDelivery, assignedDeliveryKeep, boot, Client, finishTrips, makeCompany, onHand, PNG, uid, type Co } from './helpers.js'
import type { PrismaClient } from '@prisma/client'

let app: INestApplication
let cleanup: () => Promise<void>
let root: Client
let A: Co
let B: Co
let prisma: PrismaClient

const signature = (co: Co, id: string) => co.driverClient.upload(`/deliveries/${id}/proofs`, { type: 'SIGNATURE' }, { name: 's.png', type: 'image/png', data: PNG })

before(async () => {
  ;({ app, cleanup } = await boot())
  const { PrismaService } = await import('../src/common/prisma.service.js')
  prisma = app.get(PrismaService)
  const bcrypt = (await import('bcryptjs')).default
  await prisma.user.create({ data: { fullName: 'Root', email: 'root@test.local', passwordHash: await bcrypt.hash('Password123', 4), isSuperAdmin: true } })
  root = new Client(app)
  await root.login('root@test.local', 'Password123')
  A = await makeCompany(app, root, 'A')
  B = await makeCompany(app, root, 'B')
})
after(async () => cleanup())

describe('Authentification et cycle de vie des entreprises', () => {
  it('seul le Super Administrateur crée une entreprise', async () => {
    const body = { tradeName: 'Nouvelle', email: 'n@test.local', adminName: 'Admin N', adminEmail: 'admin-n@test.local', adminPassword: 'Password123', monthlyAmount: 75 }
    const before = await prisma.company.count()
    const anon = new Client(app)
    assert.equal((await anon.post('/auth/register-company', { ...body, password: 'Password123' })).status, 404, "plus d'inscription publique")
    assert.equal((await anon.post('/companies', body)).status, 401)
    assert.equal((await A.admin.post('/companies', body)).status, 403)
    assert.equal(await prisma.company.count(), before)
    const res = await root.post('/companies', body)
    assert.equal(res.status, 201)
    assert.equal(res.body.data.status, 'active')
    const user = new Client(app)
    await user.login('admin-n@test.local', 'Password123')
    assert.equal((await user.get('/warehouses')).status, 200)
  })

  it('un mauvais mot de passe est refusé sans détail', async () => {
    const res = await new Client(app).post('/auth/login', { identifier: 'admin-A@test.local', password: 'faux' })
    assert.equal(res.status, 401)
    assert.equal(res.body.success, false)
  })

  it('la session ne se perd pas : réponse perdue, onglets simultanés, ancien format', async () => {
    const data = await new Client(app).login('admin-a@test.local', 'Password123')
    const anon = new Client(app)
    const refresh = (refreshToken: string) => anon.post('/auth/refresh', { refreshToken })
    const sid = data.refreshToken.split('.')[0]
    const stored = await prisma.userSession.findUniqueOrThrow({ where: { id: sid } })
    assert.ok(stored.expiresAt.getTime() > Date.now() + 50 * 365 * 86400_000, 'aucune échéance en pratique')

    const first = await refresh(data.refreshToken)
    assert.equal(first.status, 200)
    assert.notEqual(first.body.data.refreshToken, data.refreshToken, 'le jeton tourne')
    // Réponse perdue : le téléphone renvoie l'ancien jeton, plusieurs fois, et reçoit le jeton courant.
    for (let i = 0; i < 3; i++) assert.equal((await refresh(data.refreshToken)).body.data.refreshToken, first.body.data.refreshToken)
    // Deux onglets en même temps : même résultat pour les deux, aucune déconnexion.
    const [a, b] = await Promise.all([refresh(first.body.data.refreshToken), refresh(first.body.data.refreshToken)])
    assert.equal(a.status, 200)
    assert.equal(b.status, 200)
    assert.equal(a.body.data.refreshToken, b.body.data.refreshToken)
    const me = new Client(app)
    me.token = a.body.data.accessToken
    assert.equal((await me.get('/auth/me')).status, 200)

    // Jeton falsifié : refusé, sans fermer la vraie session.
    assert.equal((await refresh(`${sid}.${a.body.data.refreshToken.split('.')[1]}.faux`)).status, 401)
    assert.equal((await refresh(a.body.data.refreshToken)).status, 200)

    // Un jeton bien plus ancien signale un vol : la session est fermée.
    assert.equal((await refresh(data.refreshToken)).status, 401)
    assert.equal((await refresh(a.body.data.refreshToken)).status, 401)
  })

  it('une session ouverte avant cette version reste ouverte', async () => {
    const user = await prisma.user.findFirstOrThrow({ where: { email: 'admin-a@test.local' } })
    const { createHash } = await import('node:crypto')
    const raw = 'ancien-jeton-de-session'
    const legacy = await prisma.userSession.create({ data: { userId: user.id, companyId: A.companyId, refreshTokenHash: createHash('sha256').update(raw).digest('hex'), expiresAt: new Date(Date.now() + 86400_000) } })
    const anon = new Client(app)
    const converted = await anon.post('/auth/refresh', { refreshToken: `${legacy.id}.${raw}` })
    assert.equal(converted.status, 200, JSON.stringify(converted.body))
    assert.equal(converted.body.data.refreshToken.split('.').length, 3)
    assert.equal((await anon.post('/auth/refresh', { refreshToken: `${legacy.id}.${raw}` })).body.data.refreshToken, converted.body.data.refreshToken, 'réponse perdue pendant la conversion')
    assert.equal((await anon.post('/auth/refresh', { refreshToken: converted.body.data.refreshToken })).status, 200)
  })

  it('seule une déconnexion volontaire ferme la session', async () => {
    const c = new Client(app)
    const data = await c.login('admin-a@test.local', 'Password123')
    await c.post('/auth/logout')
    assert.equal((await new Client(app).post('/auth/refresh', { refreshToken: data.refreshToken })).status, 401)
  })

  it('la déconnexion invalide immédiatement le jeton d\'accès', async () => {
    const c = new Client(app)
    await c.login('admin-a@test.local', 'Password123')
    assert.equal((await c.get('/auth/me')).status, 200)
    await c.post('/auth/logout')
    assert.equal((await c.get('/auth/me')).status, 401)
  })

  it('une entreprise suspendue perd l\'accès, une réactivation le rétablit', async () => {
    assert.equal((await root.post(`/companies/${B.companyId}/suspend`, {})).status, 200)
    assert.equal((await B.admin.get('/warehouses')).status, 403)
    assert.equal((await root.post(`/companies/${B.companyId}/activate`, {})).status, 200)
    assert.equal((await B.admin.get('/warehouses')).status, 200)
  })

  it('un administrateur d\'entreprise n\'accède pas aux routes du Super Administrateur', async () => {
    assert.equal((await A.admin.get('/companies')).status, 403)
    assert.equal((await A.admin.get('/admin/audit-logs')).status, 403)
  })

  it('hors d\'une entreprise, le Super Administrateur n\'agit sur aucune opération', async () => {
    assert.equal((await root.get('/warehouses')).status, 403)
    assert.equal((await root.get('/deliveries')).status, 403)
  })

  it('le Super Administrateur entre dans l\'entreprise de son choix et y fait tout, et ses actions sont tracées', async () => {
    const sa = new Client(app)
    await sa.login('root@test.local', 'Password123')
    const before = await prisma.companyMembership.count({ where: { companyId: A.companyId } })
    assert.equal((await A.admin.post('/auth/enter-company', { companyId: B.companyId })).status, 403, 'réservé au Super Administrateur')
    assert.equal((await sa.post('/auth/enter-company', { companyId: '00000000-0000-4000-8000-000000000000' })).status, 404)

    const entered = await sa.post('/auth/enter-company', { companyId: A.companyId })
    assert.equal(entered.status, 200, JSON.stringify(entered.body))
    sa.token = entered.body.data.accessToken
    assert.equal(entered.body.data.user.managing, true)
    assert.equal(entered.body.data.user.company.id, A.companyId)
    assert.ok(entered.body.data.user.permissions.includes('user.manage'))

    // Il voit et fait ce que fait l'entreprise, sans voir les autres ni rester membre.
    assert.equal((await sa.get(`/warehouses/${A.wh.id}`)).status, 200)
    assert.equal((await sa.get(`/deliveries`)).status, 200)
    const created = await sa.post('/warehouses', { name: 'Par le Super Admin', code: 'SAD' })
    assert.equal(created.status, 201, JSON.stringify(created.body))
    assert.equal(created.body.data.companyId, A.companyId)
    assert.equal((await sa.post('/users', { fullName: 'Chef SA', email: 'chef-sa@test.local', password: 'Password123', role: 'WAREHOUSE_MANAGER' })).status, 201)
    const others = (await sa.get('/users')).body.data as Array<{ email: string }>
    assert.ok(others.every((u) => u.email !== 'root@test.local'), 'il n\'apparaît pas dans le personnel')
    assert.equal((await sa.get(`/warehouses/${B.wh.id}`)).status, 404, 'l\'isolation reste entière')
    assert.equal((await sa.get('/companies')).status, 200, 'il garde ses droits de plateforme')

    // Même une entreprise suspendue et expirée reste sous son contrôle.
    await root.post(`/companies/${A.companyId}/suspend`, {})
    const sub = await prisma.subscription.findFirstOrThrow({ where: { companyId: A.companyId, isCurrent: true } })
    await prisma.subscription.update({ where: { id: sub.id }, data: { status: 'EXPIRED' } })
    assert.equal((await A.admin.post('/warehouses', { name: 'Bloqué', code: 'BLQ' })).status, 403)
    assert.equal((await sa.post('/warehouses', { name: 'Toujours', code: 'SA2' })).status, 201)
    await prisma.subscription.update({ where: { id: sub.id }, data: { status: sub.status } })
    await root.post(`/companies/${A.companyId}/activate`, {})

    // L'entreprise voit dans son journal qui est entré et ce qui a été fait.
    const logs = (await A.admin.get('/audit-logs?limit=100')).body.data as Array<{ action: string; user?: { fullName: string }; metadata?: string }>
    assert.ok(logs.some((l) => l.action === 'admin.enter_company'))
    assert.ok(logs.some((l) => l.action === 'admin.action' && l.user?.fullName === 'Root'))
    assert.ok(!JSON.stringify(logs).includes('Password123'), 'aucun mot de passe dans le journal')
    assert.equal(await prisma.companyMembership.count({ where: { companyId: A.companyId, user: { isSuperAdmin: true } } }), 0)

    const left = await sa.post('/auth/leave-company')
    assert.equal(left.status, 200)
    sa.token = left.body.data.accessToken
    assert.equal(left.body.data.user.company, null)
    assert.equal((await sa.get('/warehouses')).status, 403)
    assert.ok(((await A.admin.get('/audit-logs?limit=100')).body.data as Array<{ action: string }>).some((l) => l.action === 'admin.leave_company'))
    assert.equal(before + 1, await prisma.companyMembership.count({ where: { companyId: A.companyId } }), 'seul le chef créé s\'ajoute')

    // Une entreprise fermée pendant sa visite ne reste pas accessible.
    const temp = await root.post('/companies', { tradeName: 'Temporaire', email: 't@test.local', adminName: 'Admin T', adminEmail: 'admin-temp@test.local', adminPassword: 'Password123', monthlyAmount: 10 })
    sa.token = (await sa.post('/auth/enter-company', { companyId: temp.body.data.id })).body.data.accessToken
    await prisma.company.update({ where: { id: temp.body.data.id }, data: { deletedAt: new Date() } })
    assert.equal((await sa.get('/warehouses')).status, 403)
    assert.equal((await sa.post('/auth/enter-company', { companyId: temp.body.data.id })).status, 404)
  })
})

describe('Isolation multi-entreprises', () => {
  it('une modification partielle n\'écrase pas les autres champs', async () => {
    const p = (await A.admin.post('/products', { name: 'Partiel', reference: 'PATCH-1', physicalNature: 'LIQUID', trackBatches: true, fragility: 'HIGH', baseUnit: 'litre' })).body.data
    const res = await A.admin.patch(`/products/${p.id}`, { name: 'Partiel 2' })
    assert.equal(res.body.data.name, 'Partiel 2')
    assert.equal(res.body.data.physicalNature, 'LIQUID')
    assert.equal(res.body.data.trackBatches, true)
    assert.equal(res.body.data.fragility, 'HIGH')
    assert.equal(res.body.data.baseUnit, 'litre')
  })

  it('une entreprise ne lit pas les données d\'une autre', async () => {
    for (const path of [`/warehouses/${B.wh.id}`, `/products/${B.product.id}`, `/customers/${B.customer.id}`, `/drivers/${B.driver.id}`, `/vehicles/${B.vehicle.id}`]) {
      assert.equal((await A.admin.get(path)).status, 404, path)
    }
    const list = (await A.admin.get('/products')).body.data
    assert.ok(list.every((p: { id: string }) => p.id !== B.product.id))
  })

  it('une entreprise ne modifie pas les données d\'une autre', async () => {
    assert.equal((await A.admin.patch(`/products/${B.product.id}`, { name: 'Piraté' })).status, 404)
    assert.equal((await A.admin.patch(`/customers/${B.customer.id}`, { name: 'Piraté' })).status, 404)
    assert.equal((await A.admin.post('/stocks/receipts', { warehouseId: B.wh.id, items: [{ productId: B.product.id, quantity: 1 }] })).status, 404)
    assert.equal((await A.admin.post('/stocks/receipts', { warehouseId: A.wh.id, items: [{ productId: B.product.id, quantity: 1 }] })).status, 404)
  })

  it('une référence d\'une autre entreprise est refusée dans une commande', async () => {
    const res = await A.admin.post('/orders', { customerId: B.customer.id, deliveryPointId: B.point.id, warehouseId: A.wh.id, items: [{ productId: A.product.id, quantity: 1 }] })
    assert.equal(res.status, 404)
  })

  it('un chauffeur d\'une autre entreprise ne peut pas être affecté', async () => {
    const { delivery } = await assignedDelivery(A, 1)
    const res = await A.admin.post(`/deliveries/${delivery.id}/assign`, { driverId: B.driver.id, vehicleId: A.vehicle.id })
    assert.equal(res.status, 404)
    assert.equal((await B.admin.get(`/deliveries/${delivery.id}`)).status, 404)
    assert.equal((await B.driverClient.post(`/deliveries/${delivery.id}/load`)).status, 404)
  })

  it('le code d\'un entrepôt ou d\'une agence est généré, unique, et jamais fixé par le navigateur', async () => {
    const G = await makeCompany(app, root, 'CODE')
    const wh = await G.admin.post('/warehouses', { name: 'Auto', code: 'PIRATE' })
    assert.equal(wh.status, 201, JSON.stringify(wh.body))
    assert.match(wh.body.data.code, /^ENT-\d{4}-\d{6}$/)
    const ag = await G.admin.post('/agencies', { name: 'Agence auto', code: 'PIRATE' })
    assert.equal(ag.status, 201, JSON.stringify(ag.body))
    assert.match(ag.body.data.code, /^AGC-\d{4}-000001$/)
    assert.equal((await G.admin.patch(`/warehouses/${wh.body.data.id}`, { name: 'Renommé', code: 'PIRATE' })).body.data.code, wh.body.data.code, 'le code ne change pas')
    assert.equal((await G.admin.patch(`/agencies/${ag.body.data.id}`, { name: 'Renommée', code: 'PIRATE' })).body.data.code, ag.body.data.code)
    const many = await Promise.all(Array.from({ length: 4 }, (_, i) => G.admin.post('/warehouses', { name: `Simultané ${i}` })))
    assert.ok(many.every((r) => r.status === 201), JSON.stringify(many.map((r) => r.body.message)))
    assert.equal(new Set(many.map((r) => r.body.data.code)).size, 4, 'créations simultanées : codes distincts')
  })

  it('un point de livraison reste lié à son client, même dans la même entreprise', async () => {
    const other = (await A.admin.post('/customers', { name: 'Autre client' })).body.data
    const otherPoint = (await A.admin.post(`/customers/${other.id}/delivery-points`, { name: 'Site autre', address: '2 avenue' })).body.data
    assert.equal(otherPoint.customerId, other.id)
    assert.deepEqual(((await A.admin.get(`/customers/${A.customer.id}/delivery-points`)).body.data as Array<{ id: string }>).filter((p) => p.id === otherPoint.id), [], 'la liste du client ne montre que ses points')
    const items = [{ productId: A.product.id, quantity: 1 }]
    const mixed = await A.admin.post('/orders', { customerId: A.customer.id, deliveryPointId: otherPoint.id, warehouseId: A.wh.id, items })
    assert.equal(mixed.status, 404, 'commande refusée')
    const order = (await A.admin.post('/orders', { customerId: A.customer.id, deliveryPointId: A.point.id, warehouseId: A.wh.id, items })).body.data
    assert.equal(order.deliveryPoint.id, A.point.id)
    assert.equal((await A.admin.patch(`/orders/${order.id}`, { deliveryPointId: otherPoint.id })).status, 404, 'modification refusée')
    assert.equal((await A.admin.patch(`/orders/${order.id}`, { customerId: other.id })).status, 404, 'changer de client sans changer de point est refusé')
    assert.equal((await A.admin.patch(`/customers/${other.id}/delivery-points/${A.point.id}`, { name: 'Déplacé' })).status, 404, 'un point ne change pas de client')
    const pack = (await A.admin.post('/packages', { warehouseId: A.wh.id, items })).body.data
    const free = await A.admin.post('/deliveries', { customerId: A.customer.id, deliveryPointId: otherPoint.id, packageIds: [pack.id], justification: 'Test' })
    assert.equal(free.status, 404, 'livraison sans commande refusée')
  })

  it('une étape déjà faite par le bureau n\'est pas refusée au téléphone', async () => {
    const op = () => ({ clientOpId: uid(), occurredAt: new Date().toISOString() })
    const { delivery } = await assignedDelivery(A, 1)
    assert.equal((await A.admin.post(`/deliveries/${delivery.id}/load`, {})).status, 200, 'le bureau charge')
    const load = await A.driverClient.post(`/deliveries/${delivery.id}/load`, op())
    assert.equal(load.status, 200, JSON.stringify(load.body))
    assert.equal(load.body.data.status, 'LOADED')
    assert.equal((await A.driverClient.post(`/deliveries/${delivery.id}/start`, op())).body.data.status, 'IN_TRANSIT', 'le chauffeur continue')
    assert.equal((await A.admin.post(`/deliveries/${delivery.id}/load`, {})).status, 409, 'sans opération de téléphone, le bureau voit le conflit')

    // Le chauffeur en retard ne fait pas reculer la mission, et le stock ne sort qu'une fois.
    const stock = await onHand(A)
    assert.equal((await A.driverClient.post(`/deliveries/${delivery.id}/load`, op())).body.data.status, 'IN_TRANSIT')
    assert.equal((await onHand(A)).onHand, stock.onHand)

    await A.driverClient.post(`/deliveries/${delivery.id}/arrive`, op())
    await signature(A, delivery.id)
    assert.equal((await A.admin.post(`/deliveries/${delivery.id}/confirm`, { recipientName: 'Bureau' })).status, 200)
    assert.equal((await A.driverClient.post(`/deliveries/${delivery.id}/confirm`, { ...op(), recipientName: 'Tel' })).status, 200, 'déjà livrée : succès')

    // Un vrai conflit reste signalé au chauffeur.
    const failed = (await assignedDelivery(A, 1)).delivery
    await A.driverClient.post(`/deliveries/${failed.id}/load`)
    await A.driverClient.post(`/deliveries/${failed.id}/start`)
    await A.admin.post(`/deliveries/${failed.id}/fail`, { reason: 'OTHER', comment: 'Annulée' })
    assert.equal((await A.driverClient.post(`/deliveries/${failed.id}/arrive`, op())).status, 409, 'échec : refusé')
    const notMine = (await assignedDelivery(B, 1)).delivery
    assert.equal((await A.driverClient.post(`/deliveries/${notMine.id}/load`, op())).status, 404, 'une mission d\'une autre entreprise reste inaccessible')
  })

  it('le company_id du navigateur est ignoré', async () => {
    const res = await A.admin.post('/warehouses', { name: 'X', code: 'XX1', companyId: B.companyId })
    assert.equal(res.status, 201)
    assert.equal(res.body.data.companyId, A.companyId)
  })

  it('un responsable n\'accède pas aux entrepôts hors de son périmètre', async () => {
    const other = (await A.admin.post('/warehouses', { name: 'Autre', code: 'OTH' })).body.data
    await A.admin.post('/users', { fullName: 'Resp', email: 'resp@test.local', password: 'Password123', role: 'WAREHOUSE_MANAGER', warehouseIds: [A.wh.id] })
    const resp = new Client(app)
    await resp.login('resp@test.local', 'Password123')
    assert.equal((await resp.get(`/warehouses/${A.wh.id}`)).status, 200)
    assert.equal((await resp.get(`/warehouses/${other.id}`)).status, 403)
    assert.equal((await resp.post('/stocks/receipts', { warehouseId: other.id, items: [{ productId: A.product.id, quantity: 1 }] })).status, 403)
    const list = (await resp.get('/warehouses')).body.data
    assert.deepEqual(list.map((w: { id: string }) => w.id), [A.wh.id])
    // Un responsable d'entrepôt n'a pas la permission de gérer les chauffeurs.
    assert.equal((await resp.post('/drivers', { fullName: 'x y', phone: '+243111111', password: 'Password123' })).status, 403)
  })

  it('un chauffeur ne consulte que ses missions', async () => {
    const { delivery } = await assignedDelivery(A, 1)
    const second = (await A.admin.post('/drivers', { fullName: 'Autre chauffeur', phone: '+243555000111', password: 'Password123', licenseExpiry: new Date(Date.now() + 1e10).toISOString() })).body.data
    const other = new Client(app)
    await other.login('+243555000111', 'Password123')
    assert.equal((await A.driverClient.get(`/deliveries/${delivery.id}`)).status, 200)
    assert.equal((await other.get(`/deliveries/${delivery.id}`)).status, 404)
    assert.equal((await other.post(`/deliveries/${delivery.id}/load`)).status, 404)
    assert.equal((await other.get('/drivers/me/missions')).body.data.length, 0)
    assert.equal(second.status, 'available')
    // Un chauffeur ne touche ni aux stocks ni aux prix.
    assert.equal((await A.driverClient.post('/stocks/issues', { warehouseId: A.wh.id, productId: A.product.id, quantity: 1, reason: 'LOSS' })).status, 403)
    assert.equal((await A.driverClient.patch(`/products/${A.product.id}`, { salePrice: 1 })).status, 403)
    assert.equal((await A.driverClient.get('/stocks')).status, 403)
  })

  it('le WebSocket ne diffuse qu\'à l\'entreprise concernée', async () => {
    const { delivery } = await assignedDelivery(A, 1)
    await app.listen(0)
    const port = (app.getHttpServer().address() as { port: number }).port
    const connect = (token: string) => new Promise<ReturnType<typeof io>>((resolve, reject) => {
      const s = io(`http://127.0.0.1:${port}`, { auth: { token }, transports: ['websocket'] })
      s.on('connect', () => setTimeout(() => resolve(s), 100))
      s.on('connect_error', reject)
    })
    const sa = await connect(A.admin.token)
    const sb = await connect(B.admin.token)
    const received: { a: unknown[]; b: unknown[] } = { a: [], b: [] }
    sa.on('delivery.status', (p) => received.a.push(p))
    sb.on('delivery.status', (p) => received.b.push(p))
    await A.driverClient.post(`/deliveries/${delivery.id}/load`)
    await new Promise((r) => setTimeout(r, 200))
    sa.close()
    sb.close()
    assert.equal(received.a.length, 1)
    assert.equal(received.b.length, 0)

    const unauth = io(`http://127.0.0.1:${port}`, { auth: { token: 'invalide' }, transports: ['websocket'] })
    const refused = await new Promise((resolve) => unauth.on('disconnect', () => resolve(true)))
    assert.equal(refused, true)
    unauth.close()
  })
})

describe('Stocks', () => {
  it('refuse une sortie supérieure au stock disponible', async () => {
    const before = await onHand(B)
    const res = await B.admin.post('/stocks/issues', { warehouseId: B.wh.id, productId: B.product.id, quantity: before.available + 1, reason: 'LOSS' })
    assert.equal(res.status, 409)
    assert.equal(res.body.code, 'INSUFFICIENT_STOCK')
    assert.deepEqual(await onHand(B), before)
  })

  it('un mouvement est journalisé avec son avant et son après', async () => {
    const before = await onHand(B)
    assert.equal((await B.admin.post('/stocks/issues', { warehouseId: B.wh.id, productId: B.product.id, quantity: 3, reason: 'DAMAGED', note: 'cassé' })).status, 201)
    const moves = (await B.admin.get(`/stocks/movements?productId=${B.product.id}`)).body.data
    assert.equal(moves[0].reason, 'DAMAGED')
    assert.equal(moves[0].quantity, 3)
    assert.equal(moves[0].quantityBefore - moves[0].quantityAfter, 3)
    assert.equal((await onHand(B)).onHand, before.onHand - 3)
  })

  it('la réservation retire le stock du disponible, l\'annulation le libère', async () => {
    const start = await onHand(A)
    const order = (await A.admin.post('/orders', { customerId: A.customer.id, deliveryPointId: A.point.id, warehouseId: A.wh.id, items: [{ productId: A.product.id, quantity: 40 }] })).body.data
    await A.admin.post(`/orders/${order.id}/submit`)
    assert.equal((await A.admin.post(`/orders/${order.id}/validate`)).status, 200)
    const reserved = await onHand(A)
    assert.equal(reserved.available, start.available - 40)
    assert.equal(reserved.onHand, start.onHand)
    assert.equal((await A.admin.post(`/orders/${order.id}/cancel`, {})).status, 200)
    assert.deepEqual(await onHand(A), start)
  })

  it('refuse une commande sans stock suffisant', async () => {
    const order = (await A.admin.post('/orders', { customerId: A.customer.id, deliveryPointId: A.point.id, warehouseId: A.wh.id, items: [{ productId: A.product.id, quantity: 999999 }] })).body.data
    await A.admin.post(`/orders/${order.id}/submit`)
    const res = await A.admin.post(`/orders/${order.id}/validate`)
    assert.equal(res.status, 409)
    assert.equal((await A.admin.get(`/orders/${order.id}`)).body.data.status, 'SUBMITTED')
  })

  it('le transfert ne crédite la destination qu\'à la réception', async () => {
    const dest = (await B.admin.post('/warehouses', { name: 'Dest', code: 'DST' })).body.data
    const origin = await onHand(B)
    const destStock = async () => (await B.admin.get(`/stocks?warehouseId=${dest.id}`)).body.data
    const t = (await B.admin.post('/stocks/transfers', { fromWarehouseId: B.wh.id, toWarehouseId: dest.id, items: [{ productId: B.product.id, quantity: 150 }] })).body.data
    assert.equal((await B.admin.post(`/stocks/transfers/${t.id}/validate`)).status, 200)
    assert.equal((await onHand(B)).available, origin.available - 150)
    assert.equal((await B.admin.post(`/stocks/transfers/${t.id}/dispatch`)).status, 200)
    assert.equal((await onHand(B)).onHand, origin.onHand - 150)
    assert.equal((await destStock()).length, 0, 'le stock en transit est absent de la destination')
    const item = (await B.admin.get('/stocks/transfers')).body.data.find((x: { id: string }) => x.id === t.id).items[0]
    assert.equal((await B.admin.post(`/stocks/transfers/${t.id}/receive`, { items: [{ itemId: item.id, quantityReceived: 148 }] })).status, 200)
    const rows = await destStock()
    assert.equal(rows[0].onHand, 148)
    assert.equal((await B.admin.post(`/stocks/transfers/${t.id}/receive`, {})).status, 409, 'pas de double réception')
  })

  it('les mouvements concurrents ne survendent jamais le stock', async () => {
    const product = (await A.admin.post('/products', { name: 'Rare', reference: 'RARE-1' })).body.data
    await A.admin.post('/stocks/receipts', { warehouseId: A.wh.id, items: [{ productId: product.id, quantity: 10 }] })
    const results = await Promise.all(Array.from({ length: 12 }, () => A.admin.post('/stocks/issues', { warehouseId: A.wh.id, productId: product.id, quantity: 2, reason: 'LOSS' })))
    const ok = results.filter((r) => r.status === 201).length
    const refused = results.filter((r) => r.status === 409).length
    assert.equal(ok, 5, JSON.stringify(results.map((r) => r.status)))
    assert.equal(refused, 7)
    const rows = (await A.admin.get(`/stocks?productId=${product.id}`)).body.data
    assert.equal(rows.length, 0, 'solde épuisé')
    const balance = await prisma.stockBalance.findFirstOrThrow({ where: { productId: product.id } })
    assert.equal(balance.onHand.toNumber(), 0)
  })

  it('le solde reste réconciliable avec le journal des mouvements', async () => {
    const balances = await prisma.stockBalance.findMany({ where: { companyId: A.companyId } })
    for (const b of balances) {
      const moves = await prisma.stockMovement.findMany({ where: { companyId: A.companyId, warehouseId: b.warehouseId, productId: b.productId, locationId: b.locationId, batchId: b.batchId } })
      const sum = moves.reduce((s, m) => s + (m.direction === 'IN' ? m.quantity.toNumber() : -m.quantity.toNumber()), 0)
      assert.equal(sum, b.onHand.toNumber(), b.id)
    }
  })

  it('une réception partielle garde le bon de commande ouvert', async () => {
    const supplier = (await A.admin.post('/suppliers', { name: 'Fourn' })).body.data
    const po = (await A.admin.post('/purchase-orders', { supplierId: supplier.id, warehouseId: A.wh.id, items: [{ productId: A.product.id, quantity: 100 }] })).body.data
    assert.equal((await A.admin.post('/stocks/receipts', { warehouseId: A.wh.id, purchaseOrderId: po.id, items: [{ productId: A.product.id, quantity: 10 }] })).status, 409, 'non validé')
    await A.admin.post(`/purchase-orders/${po.id}/validate`)
    await A.admin.post('/stocks/receipts', { warehouseId: A.wh.id, purchaseOrderId: po.id, items: [{ productId: A.product.id, quantity: 60 }] })
    const status = async () => (await A.admin.get('/purchase-orders')).body.data.find((x: { id: string }) => x.id === po.id).status
    assert.equal(await status(), 'PARTIALLY_RECEIVED')
    await A.admin.post('/stocks/receipts', { warehouseId: A.wh.id, purchaseOrderId: po.id, items: [{ productId: A.product.id, quantity: 40 }] })
    assert.equal(await status(), 'RECEIVED')
  })

  it('convertit un conditionnement : 10 bidons de 20 litres font 200 litres', async () => {
    const oil = (await A.admin.post('/products', { name: 'Huile', reference: 'OIL-1', physicalNature: 'LIQUID', baseUnit: 'litre' })).body.data
    const pkg = (await A.admin.post(`/products/${oil.id}/packagings`, { name: 'Bidon 20 L', type: 'JERRYCAN', quantityPerUnit: 20 })).body.data
    await A.admin.post('/stocks/receipts', { warehouseId: A.wh.id, items: [{ productId: oil.id, quantity: 10, packagingId: pkg.id, packagingQuantity: 10 }] })
    const rows = (await A.admin.get(`/stocks?productId=${oil.id}`)).body.data
    assert.equal(rows[0].onHand, 200)
  })

  it('FEFO sort d\'abord le lot qui expire le plus tôt et écarte le lot périmé', async () => {
    await A.admin.put('/companies/current/settings', { stockStrategy: 'FEFO' })
    const p = (await A.admin.post('/products', { name: 'Lait', reference: 'MILK-1', trackBatches: true })).body.data
    const day = 86400_000
    await A.admin.post('/stocks/receipts', { warehouseId: A.wh.id, items: [
      { productId: p.id, quantity: 10, batchNumber: 'TARD', expiresAt: new Date(Date.now() + 90 * day).toISOString() },
      { productId: p.id, quantity: 10, batchNumber: 'TOT', expiresAt: new Date(Date.now() + 5 * day).toISOString() },
      { productId: p.id, quantity: 10, batchNumber: 'PERIME', expiresAt: new Date(Date.now() - day).toISOString() },
    ] })
    assert.equal((await A.admin.post('/stocks/receipts', { warehouseId: A.wh.id, items: [{ productId: p.id, quantity: 1 }] })).status, 422, 'lot obligatoire')
    const res = await A.admin.post('/stocks/issues', { warehouseId: A.wh.id, productId: p.id, quantity: 4, reason: 'INTERNAL_USE' })
    assert.equal(res.status, 201)
    const rows = (await A.admin.get(`/stocks?productId=${p.id}`)).body.data
    const by = (n: string) => rows.find((r: { batch: { batchNumber: string } }) => r.batch.batchNumber === n).onHand
    assert.equal(by('TOT'), 6)
    assert.equal(by('TARD'), 10)
    assert.equal((await A.admin.post('/stocks/issues', { warehouseId: A.wh.id, productId: p.id, quantity: 17, reason: 'LOSS' })).status, 409, 'le lot périmé ne compte pas')
    await A.admin.put('/companies/current/settings', { stockStrategy: 'FIFO' })
  })

  it('FIFO sort d\'abord le lot reçu le plus tôt, même s\'il expire plus tard', async () => {
    const p = (await A.admin.post('/products', { name: 'Riz FIFO', reference: 'FIFO-1', trackBatches: true })).body.data
    const day = 86400_000
    await A.admin.post('/stocks/receipts', { warehouseId: A.wh.id, items: [{ productId: p.id, quantity: 10, batchNumber: 'ANCIEN', expiresAt: new Date(Date.now() + 200 * day).toISOString() }] })
    await A.admin.post('/stocks/receipts', { warehouseId: A.wh.id, items: [{ productId: p.id, quantity: 10, batchNumber: 'RECENT', expiresAt: new Date(Date.now() + 20 * day).toISOString() }] })
    await prisma.productBatch.updateMany({ where: { productId: p.id, batchNumber: 'ANCIEN' }, data: { receivedAt: new Date(Date.now() - 30 * day) } })
    const lot = async (n: string) => ((await A.admin.get(`/stocks?productId=${p.id}`)).body.data as Array<{ onHand: number; batch: { batchNumber: string } }>).find((r) => r.batch.batchNumber === n)?.onHand ?? 0
    assert.equal((await A.admin.post('/stocks/issues', { warehouseId: A.wh.id, productId: p.id, quantity: 12, reason: 'INTERNAL_USE' })).status, 201)
    assert.equal(await lot('ANCIEN'), 0, 'le plus ancien est vidé d\'abord')
    assert.equal(await lot('RECENT'), 8)

    // Même stock, stratégie FEFO : c'est cette fois le lot qui expire le plus tôt.
    await A.admin.post('/stocks/receipts', { warehouseId: A.wh.id, items: [{ productId: p.id, quantity: 10, batchNumber: 'ANCIEN' }] })
    await A.admin.put('/companies/current/settings', { stockStrategy: 'FEFO' })
    assert.equal((await A.admin.post('/stocks/issues', { warehouseId: A.wh.id, productId: p.id, quantity: 3, reason: 'INTERNAL_USE' })).status, 201)
    assert.equal(await lot('RECENT'), 5)
    assert.equal(await lot('ANCIEN'), 10)
    await A.admin.put('/companies/current/settings', { stockStrategy: 'FIFO' })
  })

  it('un lot reste utilisable jusqu\'à la fin de son jour d\'expiration, à l\'heure de l\'entreprise', async () => {
    const { isPastDay } = await import('../src/common/time.js')
    const limit = new Date('2026-12-31T00:00:00Z') // saisi « 31/12/2026 »
    assert.equal(isPastDay(limit, 'Africa/Kinshasa', new Date('2026-12-31T08:00:00Z')), false, 'le 31 au matin : utilisable')
    assert.equal(isPastDay(limit, 'Africa/Kinshasa', new Date('2026-12-31T22:30:00Z')), false, 'le 31 à 23 h 30 à Kinshasa : encore utilisable')
    assert.equal(isPastDay(limit, 'Africa/Kinshasa', new Date('2026-12-31T23:30:00Z')), true, 'le 1er janvier à 0 h 30 à Kinshasa : périmé')

    const p = (await A.admin.post('/products', { name: 'Yaourt', reference: 'EXP-1', trackBatches: true })).body.data
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Kinshasa' })
    await A.admin.post('/stocks/receipts', { warehouseId: A.wh.id, items: [{ productId: p.id, quantity: 5, batchNumber: 'AUJOURDHUI', expiresAt: new Date(`${today}T00:00:00Z`).toISOString() }] })
    assert.equal((await A.admin.post('/stocks/issues', { warehouseId: A.wh.id, productId: p.id, quantity: 5, reason: 'INTERNAL_USE' })).status, 201, 'le jour même, le lot sort encore')
  })

  it('un inventaire justifie ses écarts et ajuste le stock', async () => {
    const p = (await A.admin.post('/products', { name: 'Compté', reference: 'INV-1' })).body.data
    await A.admin.post('/stocks/receipts', { warehouseId: A.wh.id, items: [{ productId: p.id, quantity: 50 }] })
    const session = (await A.admin.post('/stocks/inventories', { warehouseId: A.wh.id, kind: 'PARTIAL', productIds: [p.id] })).body.data
    const itemId = session.items[0].id
    await A.admin.post(`/stocks/inventories/${session.id}/count`, { items: [{ itemId, counted: 47 }] })
    assert.equal((await A.admin.post(`/stocks/inventories/${session.id}/close`)).status, 422, 'justification obligatoire')
    await A.admin.post(`/stocks/inventories/${session.id}/count`, { items: [{ itemId, counted: 47, justification: 'Casse constatée' }] })
    assert.equal((await A.admin.post(`/stocks/inventories/${session.id}/close`)).status, 200)
    assert.equal((await A.admin.get(`/stocks?productId=${p.id}`)).body.data[0].onHand, 47)
    assert.equal((await A.admin.post(`/stocks/inventories/${session.id}/close`)).status, 409)
  })

  it('un ajustement est audité avec les quantités avant et après', async () => {
    const p = (await A.admin.post('/products', { name: 'Ajusté', reference: 'ADJ-1' })).body.data
    await A.admin.post('/stocks/receipts', { warehouseId: A.wh.id, items: [{ productId: p.id, quantity: 20 }] })
    const balance = (await A.admin.get(`/stocks?productId=${p.id}`)).body.data[0]
    assert.equal((await A.admin.post('/stocks/adjustments', { balanceId: balance.id, countedQuantity: 18, reason: 'Recomptage' })).status, 201)
    const logs = (await A.admin.get('/audit-logs?q=stock.adjust')).body.data
    assert.equal(JSON.parse(logs[0].details).reason, 'Recomptage')
    assert.equal((await A.admin.get(`/stocks?productId=${p.id}`)).body.data[0].onHand, 18)
  })
})

describe('Livraisons', () => {
  it('livraison complète : stock sorti au chargement, commande clôturée, preuve exigée', async () => {
    const start = await onHand(A)
    const { delivery, order } = await assignedDelivery(A, 100)
    assert.equal((await onHand(A)).reserved, start.reserved + 100)
    await A.driverClient.post(`/deliveries/${delivery.id}/respond`, { accept: true })
    assert.equal((await A.driverClient.post(`/deliveries/${delivery.id}/start`)).status, 409, 'pas de départ avant chargement')
    await arrived(A, delivery.id)
    const loaded = await onHand(A)
    assert.equal(loaded.onHand, start.onHand - 100)
    assert.equal(loaded.reserved, start.reserved)

    const noProof = await A.driverClient.post(`/deliveries/${delivery.id}/confirm`, { recipientName: 'Jean' })
    assert.equal(noProof.status, 422)
    assert.equal(noProof.body.code, 'PROOF_MISSING')
    assert.equal((await signature(A, delivery.id)).status, 201)
    assert.equal((await A.driverClient.post(`/deliveries/${delivery.id}/confirm`, {})).status, 422, 'nom du réceptionnaire exigé')
    const ok = await A.driverClient.post(`/deliveries/${delivery.id}/confirm`, { recipientName: 'Jean Réception' })
    assert.equal(ok.status, 200)
    assert.equal(ok.body.data.status, 'DELIVERED')
    assert.equal((await A.admin.get(`/orders/${order.id}`)).body.data.status, 'CLOSED')
  })

  it('une double confirmation est refusée, un rejeu hors ligne est sans effet', async () => {
    const { delivery } = await assignedDelivery(A, 2)
    await arrived(A, delivery.id)
    await signature(A, delivery.id)
    const opId = uid()
    const first = await A.driverClient.post(`/deliveries/${delivery.id}/confirm`, { recipientName: 'Marie', clientOpId: opId })
    assert.equal(first.status, 200)
    const replay = await A.driverClient.post(`/deliveries/${delivery.id}/confirm`, { recipientName: 'Marie', clientOpId: opId })
    assert.equal(replay.status, 200)
    const twice = await A.driverClient.post(`/deliveries/${delivery.id}/confirm`, { recipientName: 'Marie' })
    assert.equal(twice.status, 409)
    assert.equal(twice.body.code, 'ALREADY_CONFIRMED')
    const events = (await A.admin.get(`/deliveries/${delivery.id}`)).body.data.events.filter((e: { type: string }) => e.type === 'DELIVERED')
    assert.equal(events.length, 1)
  })

  it('l\'heure locale d\'une opération synchronisée est conservée à côté de l\'heure serveur', async () => {
    const { delivery } = await assignedDelivery(A, 1)
    await A.driverClient.post(`/deliveries/${delivery.id}/load`)
    const local = new Date(Date.now() - 3600_000).toISOString()
    await A.driverClient.post(`/deliveries/${delivery.id}/start`, { clientOpId: uid(), occurredAt: local })
    const event = (await A.admin.get(`/deliveries/${delivery.id}`)).body.data.events.find((e: { type: string }) => e.type === 'STARTED')
    assert.equal(new Date(event.occurredAt).toISOString(), local)
    assert.ok(new Date(event.receivedAt).getTime() > new Date(local).getTime())
  })

  it('livraison partielle : quantités cohérentes, retour limité au refusé', async () => {
    const start = await onHand(A)
    const { delivery, order } = await assignedDelivery(A, 100)
    await arrived(A, delivery.id)
    await signature(A, delivery.id)
    const item = delivery.items[0]
    const inconsistent = await A.driverClient.post(`/deliveries/${delivery.id}/partial-confirm`, { recipientName: 'Paul', items: [{ deliveryItemId: item.id, delivered: 50, refused: 10, missing: 0, reason: 'x' }] })
    assert.equal(inconsistent.status, 422)
    const noReason = await A.driverClient.post(`/deliveries/${delivery.id}/partial-confirm`, { recipientName: 'Paul', items: [{ deliveryItemId: item.id, delivered: 80, refused: 15, missing: 5 }] })
    assert.equal(noReason.status, 422)
    const res = await A.driverClient.post(`/deliveries/${delivery.id}/partial-confirm`, { recipientName: 'Paul', items: [{ deliveryItemId: item.id, delivered: 80, refused: 15, missing: 5, reason: 'Sacs abîmés' }] })
    assert.equal(res.status, 200)
    assert.equal(res.body.data.status, 'PARTIALLY_DELIVERED')
    assert.equal((await A.admin.post(`/deliveries/${delivery.id}/return`, { condition: 'DAMAGED' })).status, 200)
    const end = await onHand(A)
    assert.equal(end.onHand, start.onHand - 85, '80 remis + 5 manquants restent sortis')
    assert.equal(end.damaged, start.damaged + 15)
    assert.equal(end.available, start.available - 100, 'le stock endommagé n\'est pas disponible')
    assert.equal((await A.admin.post(`/deliveries/${delivery.id}/return`, {})).status, 409, 'pas de double retour')
    assert.equal((await A.admin.get(`/orders/${order.id}`)).body.data.status, 'CLOSED')
  })

  it('livraison échouée puis reprogrammée : historique conservé, pas de seconde sortie de stock', async () => {
    const { delivery } = await assignedDelivery(A, 10)
    await arrived(A, delivery.id)
    const afterLoad = await onHand(A)
    const failed = await A.driverClient.post(`/deliveries/${delivery.id}/fail`, { reason: 'CUSTOMER_ABSENT', comment: 'Fermé' })
    assert.equal(failed.body.data.status, 'FAILED')
    assert.equal((await A.driverClient.post(`/deliveries/${delivery.id}/reschedule`, { scheduledAt: new Date().toISOString() })).status, 403, 'décision réservée au responsable')
    assert.equal((await A.admin.post(`/deliveries/${delivery.id}/cancel`, {})).status, 409, 'marchandise encore sortie')
    assert.equal((await A.admin.post(`/deliveries/${delivery.id}/reschedule`, { scheduledAt: new Date(Date.now() + 86400_000).toISOString() })).status, 200)
    await arrived(A, delivery.id)
    assert.deepEqual(await onHand(A), afterLoad)
    await signature(A, delivery.id)
    assert.equal((await A.driverClient.post(`/deliveries/${delivery.id}/confirm`, { recipientName: 'Ali' })).status, 200)
    const detail = (await A.admin.get(`/deliveries/${delivery.id}`)).body.data
    assert.equal(detail.attempts, 2)
    assert.ok(detail.history.some((h: { status: string }) => h.status === 'FAILED'))
  })

  it('retour après échec : le stock est réintégré', async () => {
    const start = await onHand(A)
    const { delivery } = await assignedDelivery(A, 10)
    await arrived(A, delivery.id)
    await A.driverClient.post(`/deliveries/${delivery.id}/fail`, { reason: 'WRONG_ADDRESS' })
    assert.equal((await A.admin.post(`/deliveries/${delivery.id}/return`, { condition: 'GOOD' })).status, 200)
    assert.deepEqual(await onHand(A), start)
  })

  it('les transitions interdites sont refusées', async () => {
    const { delivery } = await assignedDelivery(A, 1)
    assert.equal((await A.driverClient.post(`/deliveries/${delivery.id}/arrive`)).status, 409)
    assert.equal((await A.driverClient.post(`/deliveries/${delivery.id}/confirm`, {})).status, 422)
    assert.equal((await A.admin.post(`/deliveries/${delivery.id}/cancel`, {})).status, 200)
    assert.equal((await A.driverClient.get(`/deliveries/${delivery.id}`)).status, 404, 'mission retirée au chauffeur')
    assert.equal((await A.admin.post(`/deliveries/${delivery.id}/assign`, { driverId: A.driver.id, vehicleId: A.vehicle.id })).status, 409)
  })

  it('l\'affectation contrôle permis, capacité, compatibilité et documents', async () => {
    const co = A
    const pack = async (productId: string, quantity: number, unitType = 'CARTON') => {
      const p = (await co.admin.post('/packages', { warehouseId: co.wh.id, unitType, items: [{ productId, quantity }] })).body.data
      const d = await co.admin.post('/deliveries', { packageIds: [p.id], customerId: co.customer.id, deliveryPointId: co.point.id, justification: 'Essai' })
      assert.equal(d.status, 201, JSON.stringify(d.body))
      await co.admin.post(`/deliveries/${d.body.data.id}/validate`)
      return d.body.data.id as string
    }
    const small = (await co.admin.post('/vehicles', { registration: 'SMALL', type: 'VAN', weightCapacityKg: 100, volumeCapacityM3: 1 })).body.data
    const heavy = await pack(co.product.id, 10)
    const overload = await co.admin.post(`/deliveries/${heavy}/assign`, { driverId: co.driver.id, vehicleId: small.id })
    assert.equal(overload.status, 409)
    assert.equal(overload.body.code, 'ASSIGNMENT_REJECTED')

    const fuel = (await co.admin.post('/products', { name: 'Gasoil', reference: 'FUEL-1', physicalNature: 'LIQUID', baseUnit: 'litre', requiredVehicle: 'TANKER' })).body.data
    await co.admin.post('/stocks/receipts', { warehouseId: co.wh.id, items: [{ productId: fuel.id, quantity: 100 }] })
    const liquid = await pack(fuel.id, 10)
    assert.equal((await co.admin.post(`/deliveries/${liquid}/assign`, { driverId: co.driver.id, vehicleId: co.vehicle.id })).status, 409)

    const expired = (await co.admin.post('/drivers', { fullName: 'Permis expiré', phone: '+243777000111', password: 'Password123', licenseExpiry: new Date(Date.now() - 86400_000).toISOString() })).body.data
    assert.equal((await co.admin.post(`/deliveries/${heavy}/assign`, { driverId: expired.id, vehicleId: co.vehicle.id })).status, 409)
    const oldTruck = (await co.admin.post('/vehicles', { registration: 'OLD', type: 'TRUCK', insuranceExpiry: new Date(Date.now() - 86400_000).toISOString() })).body.data
    assert.equal((await co.admin.post(`/deliveries/${heavy}/assign`, { driverId: co.driver.id, vehicleId: oldTruck.id })).status, 409)
    assert.equal((await co.admin.post(`/deliveries/${heavy}/assign`, { driverId: co.driver.id, vehicleId: co.vehicle.id })).status, 200)
  })

  it('une livraison sans commande exige une justification', async () => {
    const p = (await A.admin.post('/packages', { warehouseId: A.wh.id, items: [{ productId: A.product.id, quantity: 1 }] })).body.data
    const res = await A.admin.post('/deliveries', { packageIds: [p.id], customerId: A.customer.id, deliveryPointId: A.point.id })
    assert.equal(res.status, 422)
  })

  it('le point de livraison doit appartenir au client', async () => {
    const other = (await A.admin.post('/customers', { name: 'Autre client' })).body.data
    const p = (await A.admin.post('/packages', { warehouseId: A.wh.id, items: [{ productId: A.product.id, quantity: 1 }] })).body.data
    const res = await A.admin.post('/deliveries', { packageIds: [p.id], customerId: other.id, deliveryPointId: A.point.id, justification: 'x' })
    assert.equal(res.status, 404)
  })

  it('les quantités en colis ne dépassent pas les quantités préparées', async () => {
    const order = (await A.admin.post('/orders', { customerId: A.customer.id, deliveryPointId: A.point.id, warehouseId: A.wh.id, items: [{ productId: A.product.id, quantity: 10 }] })).body.data
    await A.admin.post(`/orders/${order.id}/submit`)
    await A.admin.post(`/orders/${order.id}/validate`)
    assert.equal((await A.admin.post(`/orders/${order.id}/prepare`, { items: [{ orderItemId: order.items[0].id, quantity: 11 }] })).status, 422)
    assert.equal((await A.admin.post(`/orders/${order.id}/prepare`, { items: [{ orderItemId: order.items[0].id, quantity: 4 }] })).body.data.status, 'PARTIALLY_PREPARED')
    assert.equal((await A.admin.post('/packages', { warehouseId: A.wh.id, orderId: order.id, items: [{ productId: A.product.id, quantity: 5 }] })).status, 422)
    assert.equal((await A.admin.post('/packages', { warehouseId: A.wh.id, orderId: order.id, items: [{ productId: A.product.id, quantity: 4 }] })).status, 201)
    await A.admin.post(`/orders/${order.id}/cancel`, {})
  })

  it('la livraison se confirme sans aucun code envoyé au client, GPS absent toléré si non exigé', async () => {
    const { delivery } = await assignedDelivery(A, 1)
    await arrived(A, delivery.id)
    await signature(A, delivery.id)
    assert.equal((await A.driverClient.post(`/deliveries/${delivery.id}/confirm`, { recipientName: 'Aline' })).status, 200)
    const raw = (await A.admin.get(`/deliveries/${delivery.id}`)).body.data
    assert.equal(raw.status, 'DELIVERED')
    assert.ok(raw.proofs.every((p: { type: string }) => p.type !== 'OTP'))
  })

  it('position GPS exigée : la confirmation sans position est refusée', async () => {
    await A.admin.put('/companies/current/settings', { requireGpsOnProof: true })
    const { delivery } = await assignedDelivery(A, 1)
    await arrived(A, delivery.id)
    await signature(A, delivery.id)
    assert.equal((await A.driverClient.post(`/deliveries/${delivery.id}/confirm`, { recipientName: 'Sans GPS' })).status, 422)
    assert.equal((await A.driverClient.post(`/deliveries/${delivery.id}/confirm`, { recipientName: 'Avec GPS', latitude: -4.3, longitude: 15.3 })).status, 200)
    await A.admin.put('/companies/current/settings', { requireGpsOnProof: false })
  })

  it('le QR Code est opaque et le scan respecte l\'affectation', async () => {
    await A.admin.put('/companies/current/settings', { requireQrOnLoad: true })
    const { delivery, pack } = await assignedDelivery(A, 1)
    const qr = (await A.admin.post(`/packages/${pack.id}/generate-qr`)).body.data
    assert.ok(qr.dataUrl.startsWith('data:image/png'))
    assert.ok(!qr.token.includes(pack.trackingNumber))
    assert.equal((await A.driverClient.post(`/deliveries/${delivery.id}/load`)).status, 422)
    assert.equal((await B.driverClient.post('/packages/scan', { token: qr.token, action: 'LOAD' })).status, 404)
    assert.equal((await A.driverClient.post('/packages/scan', { token: qr.token, action: 'LOAD', deliveryId: delivery.id })).status, 200)
    assert.equal((await A.driverClient.post(`/deliveries/${delivery.id}/load`)).status, 200)
    await A.admin.put('/companies/current/settings', { requireQrOnLoad: false })
  })

  it('une clé d\'idempotence ne crée pas deux fois la même commande', async () => {
    const key = uid()
    const body = { customerId: A.customer.id, deliveryPointId: A.point.id, warehouseId: A.wh.id, items: [{ productId: A.product.id, quantity: 1 }] }
    const first = await A.admin.post('/orders', body).set('Idempotency-Key', key)
    const second = await A.admin.post('/orders', body).set('Idempotency-Key', key)
    assert.equal(first.status, 201)
    assert.equal(second.body.data.id, first.body.data.id)
    assert.equal(second.headers['idempotency-replayed'], 'true')
  })

  it('génère les documents PDF, réservés à l\'entreprise', async () => {
    const { delivery } = await assignedDelivery(A, 1)
    await arrived(A, delivery.id)
    await signature(A, delivery.id)
    await A.driverClient.post(`/deliveries/${delivery.id}/confirm`, { recipientName: 'Doc' })
    for (const type of ['delivery-note', 'receipt', 'partial', 'failure', 'return']) {
      const pdf = await A.admin.get(`/deliveries/${delivery.id}/documents/${type}`).buffer(true).parse((res, cb) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => cb(null, Buffer.concat(chunks)))
      })
      assert.equal(pdf.status, 200, type)
      assert.equal(pdf.body.subarray(0, 4).toString(), '%PDF')
    }
    assert.equal((await B.admin.get(`/deliveries/${delivery.id}/documents/receipt`)).status, 404)
  })

  it('les preuves sont protégées par URL temporaire signée', async () => {
    const { delivery } = await assignedDelivery(A, 1)
    await arrived(A, delivery.id)
    const proof = (await signature(A, delivery.id)).body.data
    assert.ok(proof.sha256)
    const signed = (await A.admin.get(`/proofs/${proof.id}/download`)).body.data
    const anon = new Client(app)
    const path = signed.url.replace('/api/v1', '')
    assert.equal((await anon.get(path)).status, 200)
    assert.equal((await anon.get(path.replace(/signature=.*/, 'signature=faux'))).status, 403)
    assert.equal((await anon.get(`/files/${proof.fileId}/content`)).status, 403)
    assert.equal((await B.admin.get(`/proofs/${proof.id}/download`)).status, 404)
    assert.equal((await anon.upload(`/deliveries/${delivery.id}/proofs`, { type: 'SIGNATURE' })).status, 401)
    assert.equal((await A.driverClient.upload(`/deliveries/${delivery.id}/proofs`, { type: 'SIGNATURE' }, { name: 'x.exe', type: 'application/x-msdownload', data: Buffer.from('MZ\x90\x00programme') })).status, 415, 'un exécutable est refusé')
  })

  it('les tournées regroupent des livraisons sans doublon et contrôlent la capacité cumulée', async () => {
    await finishTrips(A)
    const make = async () => {
      const p = (await A.admin.post('/packages', { warehouseId: A.wh.id, items: [{ productId: A.product.id, quantity: 4 }] })).body.data
      const d = (await A.admin.post('/deliveries', { packageIds: [p.id], customerId: A.customer.id, deliveryPointId: A.point.id, justification: 'Tournée' })).body.data
      await A.admin.post(`/deliveries/${d.id}/validate`)
      return d.id as string
    }
    const [d1, d2, d3] = [await make(), await make(), await make()]
    const v = (await A.admin.post('/vehicles', { registration: 'TOUR-1', type: 'TRUCK', weightCapacityKg: 500 })).body.data
    const body = { plannedAt: new Date().toISOString(), warehouseId: A.wh.id, driverId: A.driver.id, vehicleId: v.id }
    const tooHeavy = await A.admin.post('/routes', { ...body, deliveryIds: [d1, d2, d3] })
    assert.equal(tooHeavy.status, 409, 'trois livraisons de 200 kg dépassent 500 kg')
    assert.equal((await A.admin.get(`/deliveries/${d1}`)).body.data.driverId, null, 'échec atomique')
    const route = await A.admin.post('/routes', { ...body, deliveryIds: [d1, d2] })
    assert.equal(route.status, 201)
    assert.deepEqual(route.body.data.stops.map((s: { deliveryId: string }) => s.deliveryId), [d1, d2])
    assert.equal((await A.admin.post('/routes', { ...body, vehicleId: A.vehicle.id, deliveryIds: [d1] })).status, 409, 'déjà sur une tournée')
    const reordered = await A.admin.put(`/routes/${route.body.data.id}/stops`, { deliveryIds: [d2, d1] })
    assert.equal(reordered.body.data.stops[0].deliveryId, d2)
    assert.equal((await A.driverClient.post(`/routes/${route.body.data.id}/start`)).status, 200)
    assert.equal((await A.driverClient.post(`/routes/${route.body.data.id}/finish`)).status, 409, 'arrêts restants')
    assert.equal((await B.driverClient.post(`/routes/${route.body.data.id}/start`)).status, 404)
    for (const id of [d1, d2]) {
      await A.driverClient.post(`/deliveries/${id}/load`)
      await A.driverClient.post(`/deliveries/${id}/start`)
      await A.driverClient.post(`/deliveries/${id}/fail`, { reason: 'NO_ACCESS' })
    }
    assert.equal((await A.driverClient.post(`/routes/${route.body.data.id}/finish`)).status, 200)
  })
})

describe('Suivi GPS (téléphone) et portail public', () => {
  it('le chauffeur ne transmet sa position que pendant une mission affectée', async () => {
    const { delivery } = await assignedDelivery(A, 1)
    assert.equal((await B.driverClient.post('/tracking/sessions/start', { deliveryId: delivery.id })).status, 403)
    assert.equal((await A.admin.post('/tracking/sessions/start', { deliveryId: delivery.id })).status, 403)
    await A.driverClient.post(`/deliveries/${delivery.id}/load`)
    await A.driverClient.post(`/deliveries/${delivery.id}/start`)
    const session = (await A.driverClient.post('/tracking/sessions/start', { deliveryId: delivery.id })).body.data
    assert.equal((await A.driverClient.post('/tracking/sessions/start', { deliveryId: delivery.id })).body.data.id, session.id, 'une seule session par chauffeur')
    assert.equal((await B.driverClient.post('/tracking/positions', { sessionId: session.id, positions: [{ clientId: uid(), latitude: 0, longitude: 0, recordedAt: new Date().toISOString() }] })).status, 404)

    const clientId = uid()
    const now = new Date().toISOString()
    const positions = [{ clientId, latitude: -4.33, longitude: 15.31, accuracyM: 8, speedMs: 10, headingDeg: 90, batteryLevel: 77, isOnline: true, recordedAt: now }]
    const first = (await A.driverClient.post('/tracking/positions', { sessionId: session.id, positions })).body.data
    assert.equal(first.stored, 1)
    const dup = (await A.driverClient.post('/tracking/positions', { sessionId: session.id, positions })).body.data
    assert.equal(dup.stored, 0, 'synchronisation répétée sans doublon')
    assert.equal(dup.duplicates, 1)
    assert.equal((await A.driverClient.post('/tracking/positions', { sessionId: session.id, positions: [{ ...positions[0], clientId: uid(), latitude: 120 }] })).status, 422)
    const future = (await A.driverClient.post('/tracking/positions', { sessionId: session.id, positions: [{ clientId: uid(), latitude: 1, longitude: 1, recordedAt: new Date(Date.now() + 3600_000).toISOString() }] })).body.data
    assert.equal(future.rejected, 1)

    // Donnée absente sur l'appareil : conservée comme absente, jamais inventée.
    const noSpeed = uid()
    await A.driverClient.post('/tracking/positions', { sessionId: session.id, positions: [{ clientId: noSpeed, latitude: -4.34, longitude: 15.32, recordedAt: new Date().toISOString() }] })
    const stored = await prisma.gpsPosition.findUniqueOrThrow({ where: { clientId: noSpeed } })
    assert.equal(stored.speedMs, null)
    assert.equal(stored.altitudeM, null)

    const live = (await A.admin.get('/tracking/drivers/live')).body.data.find((d: { driver: { id: string } }) => d.driver.id === A.driver.id)
    assert.equal(live.position.isLive, true)
    assert.ok(!(await B.admin.get('/tracking/drivers/live')).body.data.some((d: { driver: { id: string } }) => d.driver.id === A.driver.id))
    assert.equal((await A.driverClient.get('/tracking/drivers/live')).status, 403)
    assert.equal((await A.admin.get(`/tracking/deliveries/${delivery.id}`)).body.data.positions.length, 2)
  })

  it('une mission réalisée hors ligne garde ses positions d\'origine', async () => {
    const { delivery } = await assignedDelivery(B, 1)
    const offlineStart = new Date(Date.now() - 20 * 60_000).toISOString()
    const session = (await B.driverClient.post('/tracking/sessions/start', { deliveryId: delivery.id, startedAt: offlineStart })).body.data
    assert.equal(new Date(session.startedAt).toISOString(), offlineStart)
    const res = (await B.driverClient.post('/tracking/positions', { sessionId: session.id, positions: [{ clientId: uid(), latitude: -4.3, longitude: 15.3, recordedAt: new Date(Date.now() - 10 * 60_000).toISOString() }] })).body.data
    assert.equal(res.stored, 1)
    await B.driverClient.post(`/tracking/sessions/${session.id}/stop`)
    await B.admin.post(`/deliveries/${delivery.id}/cancel`, {})
  })

  it('le suivi en direct donne le tracé du trajet en cours, sans les mesures trop imprécises', async () => {
    const L = await makeCompany(app, root, 'L')
    await L.admin.patch(`/warehouses/${L.wh.id}`, { latitude: -4.30, longitude: 15.30 })
    await L.admin.patch(`/customers/${L.customer.id}/delivery-points/${L.point.id}`, { latitude: -4.40, longitude: 15.40 })
    const { delivery } = await assignedDelivery(L, 1)
    await L.driverClient.post(`/deliveries/${delivery.id}/load`)
    await L.driverClient.post(`/deliveries/${delivery.id}/start`)
    const base = Date.now() - 60_000
    const session = (await L.driverClient.post('/tracking/sessions/start', { deliveryId: delivery.id, startedAt: new Date(base).toISOString() })).body.data
    const point = (lat: number, offset: number, accuracyM?: number) => ({ clientId: uid(), latitude: lat, longitude: 15.3, accuracyM, recordedAt: new Date(base + offset).toISOString() })
    const res = await L.driverClient.post('/tracking/positions', { sessionId: session.id, positions: [point(-4.31, 2000, 8), point(-4.9, 3000, 500), point(-4.30, 1000, 5), point(-4.32, 4000)] })
    assert.equal(res.body.data.stored, 4)
    const row = (await L.admin.get('/tracking/drivers/live')).body.data.find((r: { sessionId: string }) => r.sessionId === session.id)
    assert.deepEqual(row.trail.map((t: number[]) => t[0]), [-4.30, -4.31, -4.32], 'dans l\'ordre réel, sans la mesure à 500 m')
    assert.equal(row.deliveries[0].deliveryPoint.latitude, -4.40)
    assert.equal(row.deliveries[0].warehouse.latitude, -4.30)
    const other = (await makeCompany(app, root, 'L2')).admin
    assert.ok(((await other.get('/tracking/drivers/live')).body.data as unknown[]).length === 0, 'une autre entreprise ne voit rien')
    await L.driverClient.post(`/deliveries/${delivery.id}/arrive`)
    assert.equal((await L.admin.get('/tracking/drivers/live')).body.data.length, 0, 'fin de suivi à l\'arrivée')
  })

  it('le tracé d\'une mission couvre son vrai trajet : hors ligne compris, trajets suivants exclus', async () => {
    const M = await makeCompany(app, root, 'M')
    const op = (minutes: number) => ({ clientOpId: uid(), occurredAt: new Date(Date.now() - minutes * 60_000).toISOString() })
    const at = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()
    const first = (await assignedDelivery(M, 1)).delivery
    const session = (await M.driverClient.post('/tracking/sessions/start', { deliveryId: first.id, startedAt: at(60) })).body.data
    const position = (lat: number, minutes: number) => ({ clientId: uid(), latitude: lat, longitude: 15, recordedAt: at(minutes) })
    await M.driverClient.post('/tracking/positions', { sessionId: session.id, positions: [position(1, 50), position(2, 40)] })
    // Reçus maintenant, mais réalisés il y a 55 et 30 minutes.
    await M.driverClient.post(`/deliveries/${first.id}/load`, op(58))
    await M.driverClient.post(`/deliveries/${first.id}/start`, op(55))
    await M.driverClient.post(`/deliveries/${first.id}/fail`, { ...op(30), reason: 'OTHER', comment: 'Échec' })
    const lats = async () => ((await M.admin.get(`/tracking/deliveries/${first.id}`)).body.data.positions as Array<{ latitude: number }>).map((p) => p.latitude)
    assert.deepEqual(await lats(), [1, 2], 'positions hors ligne conservées')
    // Une autre mission du même chauffeur, ensuite : elle n'apparaît pas sur le tracé de la première.
    const next = (await assignedDelivery(M, 1)).delivery
    await M.driverClient.post(`/deliveries/${next.id}/load`)
    await M.driverClient.post(`/deliveries/${next.id}/start`)
    const nextSession = (await M.driverClient.post('/tracking/sessions/start', { deliveryId: next.id })).body.data
    await M.driverClient.post('/tracking/positions', { sessionId: nextSession.id, positions: [position(9, 0)] })
    assert.deepEqual(await lats(), [1, 2], 'aucun trajet suivant')
  })

  it('téléphone hors ligne pendant que le bureau termine la mission : le trajet déjà mesuré est conservé, rien après', async () => {
    const N = await makeCompany(app, root, 'HORS')
    const { delivery } = await assignedDelivery(N, 1)
    const at = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()
    const op = (minutes: number) => ({ clientOpId: uid(), occurredAt: at(minutes) })
    await N.driverClient.post(`/deliveries/${delivery.id}/load`, op(40))
    await N.driverClient.post(`/deliveries/${delivery.id}/start`, op(30))
    await N.admin.post(`/deliveries/${delivery.id}/arrive`, op(10))
    assert.equal((await N.driverClient.post('/tracking/sessions/start', { deliveryId: delivery.id })).status, 403, 'sans date : pas de nouveau suivi')
    assert.equal((await N.driverClient.post('/tracking/sessions/start', { deliveryId: delivery.id, startedAt: at(5) })).status, 403, 'pas de suivi après l\'arrivée')
    const late = await N.driverClient.post('/tracking/sessions/start', { deliveryId: delivery.id, startedAt: at(30) })
    assert.equal(late.status, 200, JSON.stringify(late.body))
    assert.ok(late.body.data.stoppedAt, 'session fermée d\'emblée')
    const point = (lat: number, minutes: number) => ({ clientId: uid(), latitude: lat, longitude: 15, recordedAt: at(minutes) })
    const res = await N.driverClient.post('/tracking/positions', { sessionId: late.body.data.id, positions: [point(1, 25), point(2, 15), point(3, 5)] })
    assert.equal(res.body.data.stored, 2, 'la position prise sur place est refusée')
    assert.equal((await N.driverClient.post('/tracking/sessions/start', { deliveryId: delivery.id, startedAt: at(30) })).body.data.id, late.body.data.id, 'un nouvel essai reprend la même session')
    assert.equal((await N.admin.get('/tracking/drivers/live')).body.data.length, 0, 'il n\'apparaît pas comme suivi')
    const onSite = (await N.admin.get('/tracking/on-site')).body.data
    assert.equal(onSite.length, 1)
    assert.equal(onSite[0].id, delivery.id)
    assert.ok(onSite[0].arrivedAt)
    assert.equal((await A.admin.get('/tracking/on-site')).body.data.some((d: { id: string }) => d.id === delivery.id), false, 'jamais visible par une autre entreprise')
    assert.equal((await N.driverClient.get('/tracking/on-site')).status, 403)
  })

  it('une arrivée hors ligne ferme le suivi à son heure réelle', async () => {
    const { delivery } = await assignedDelivery(B, 1)
    const startedAt = new Date(Date.now() - 30 * 60_000)
    const session = (await B.driverClient.post('/tracking/sessions/start', { deliveryId: delivery.id, startedAt: startedAt.toISOString() })).body.data
    await B.driverClient.post(`/deliveries/${delivery.id}/load`)
    await B.driverClient.post(`/deliveries/${delivery.id}/start`)
    const arrivedAt = new Date(Date.now() - 10 * 60_000)
    await B.driverClient.post(`/deliveries/${delivery.id}/arrive`, { clientOpId: `arrive-${uid()}`, occurredAt: arrivedAt.toISOString() })
    const row = await prisma.trackingSession.findUniqueOrThrow({ where: { id: session.id } })
    assert.equal(row.stoppedAt?.toISOString(), arrivedAt.toISOString())
    const at = (ms: number) => new Date(arrivedAt.getTime() + ms).toISOString()
    const res = await B.driverClient.post('/tracking/positions', { sessionId: session.id, positions: [
      { clientId: uid(), latitude: 1, longitude: 1, recordedAt: at(-60_000) },
      { clientId: uid(), latitude: 2, longitude: 2, recordedAt: at(60_000) },
    ] })
    assert.equal(res.body.data.stored, 1, 'seule la position du trajet est conservée')
    assert.equal(res.body.data.rejected, 1, 'la position prise sur place est refusée')
    await signature(B, delivery.id)
    await B.driverClient.post(`/deliveries/${delivery.id}/confirm`, { recipientName: 'Fin' })
  })

  it('un chauffeur fait plusieurs livraisons dans une même tournée, le suivi dure jusqu\'à la dernière arrivée', async () => {
    const one = await assignedDelivery(B, 1)
    const two = await assignedDelivery(B, 1)
    const route = (await B.admin.post('/routes', { plannedAt: new Date().toISOString(), warehouseId: B.wh.id, driverId: B.driver.id, vehicleId: B.vehicle.id, deliveryIds: [one.delivery.id, two.delivery.id] })).body.data
    assert.equal((await B.admin.post(`/routes/${route.id}/start`)).status, 200)
    for (const d of [one, two]) {
      await B.driverClient.post(`/deliveries/${d.delivery.id}/load`)
      const started = await B.driverClient.post(`/deliveries/${d.delivery.id}/start`)
      assert.equal(started.status, 200, JSON.stringify(started.body))
    }
    const session = (await B.driverClient.post('/tracking/sessions/start', { deliveryId: one.delivery.id })).body.data
    await B.driverClient.post(`/deliveries/${one.delivery.id}/arrive`)
    assert.equal((await prisma.trackingSession.findUniqueOrThrow({ where: { id: session.id } })).stoppedAt, null)
    await B.driverClient.post(`/deliveries/${two.delivery.id}/arrive`)
    assert.ok((await prisma.trackingSession.findUniqueOrThrow({ where: { id: session.id } })).stoppedAt)
    for (const d of [one, two]) {
      await signature(B, d.delivery.id)
      await B.driverClient.post(`/deliveries/${d.delivery.id}/confirm`, { recipientName: 'Fin' })
    }
    assert.equal((await B.admin.post(`/routes/${route.id}/finish`)).status, 200)
  })

  it('un chauffeur ne fait qu\'un trajet à la fois, hors d\'une même tournée', async () => {
    const Z = await makeCompany(app, root, 'UNTRAJET')
    const first = (await assignedDeliveryKeep(Z, 1)).delivery
    const second = (await assignedDeliveryKeep(Z, 1)).delivery
    for (const id of [first.id, second.id]) await Z.driverClient.post(`/deliveries/${id}/load`)
    assert.equal((await Z.driverClient.post(`/deliveries/${first.id}/start`)).status, 200)

    // Le bureau peut préparer d'autres livraisons pour lui, mais il ne part pas.
    const refused = await Z.driverClient.post(`/deliveries/${second.id}/start`)
    assert.equal(refused.status, 409)
    assert.equal(refused.body.code, 'DRIVER_BUSY')
    assert.match(refused.body.message, new RegExp(first.number))
    assert.equal((await Z.admin.post(`/deliveries/${second.id}/start`)).status, 409, 'le bureau aussi')
    const stock = await onHand(Z)

    // Sur place, il travaille encore : même règle.
    await Z.driverClient.post(`/deliveries/${first.id}/arrive`)
    assert.equal((await Z.driverClient.post(`/deliveries/${second.id}/start`)).status, 409)

    // Une fois terminée, il repart.
    await signature(Z, first.id)
    await Z.driverClient.post(`/deliveries/${first.id}/confirm`, { recipientName: 'Fin' })
    assert.equal((await Z.driverClient.post(`/deliveries/${second.id}/start`)).status, 200)
    assert.equal((await onHand(Z)).onHand, stock.onHand, 'aucun effet sur le stock')

    // Une tournée ne démarre pas pendant un trajet extérieur, et une seule tournée à la fois.
    const third = (await assignedDeliveryKeep(Z, 1)).delivery
    const fourth = (await assignedDeliveryKeep(Z, 1)).delivery
    const body = { plannedAt: new Date().toISOString(), warehouseId: Z.wh.id, driverId: Z.driver.id, vehicleId: Z.vehicle.id }
    const r1 = (await Z.admin.post('/routes', { ...body, deliveryIds: [third.id] })).body.data
    const r2 = (await Z.admin.post('/routes', { ...body, deliveryIds: [fourth.id] })).body.data
    assert.equal((await Z.admin.post(`/routes/${r1.id}/start`)).body.code, 'DRIVER_BUSY')
    await Z.driverClient.post(`/deliveries/${second.id}/arrive`)
    await signature(Z, second.id)
    await Z.driverClient.post(`/deliveries/${second.id}/confirm`, { recipientName: 'Fin' })
    assert.equal((await Z.admin.post(`/routes/${r1.id}/start`)).status, 200)
    assert.equal((await Z.admin.post(`/routes/${r2.id}/start`)).body.code, 'DRIVER_BUSY')

    // Rejeu hors ligne d'un départ déjà reçu : pas d'erreur.
    await Z.driverClient.post(`/deliveries/${third.id}/load`)
    const op = { clientOpId: uid(), occurredAt: new Date().toISOString() }
    assert.equal((await Z.driverClient.post(`/deliveries/${third.id}/start`, op)).status, 200)
    assert.equal((await Z.driverClient.post(`/deliveries/${third.id}/start`, op)).status, 200)
  })

  it('le bureau rappelle un chauffeur en route : mission arrêtée, suivi coupé, chauffeur prévenu', async () => {
    const RC = await makeCompany(app, root, 'RAPPEL')
    const { delivery } = await assignedDelivery(RC, 1)
    assert.equal((await RC.admin.post(`/deliveries/${delivery.id}/recall`, { reason: 'Le client annule' })).body.code, 'NOT_ON_ROAD', 'pas avant le départ')
    await RC.driverClient.post(`/deliveries/${delivery.id}/load`)
    await RC.driverClient.post(`/deliveries/${delivery.id}/start`)
    const session = (await RC.driverClient.post('/tracking/sessions/start', { deliveryId: delivery.id })).body.data
    assert.equal((await RC.driverClient.post(`/deliveries/${delivery.id}/recall`, { reason: 'Moi-même' })).status, 403, 'le chauffeur déclare un échec, il ne se rappelle pas')
    assert.equal((await RC.admin.post(`/deliveries/${delivery.id}/recall`, { reason: '' })).status, 422, 'motif obligatoire')
    assert.equal((await A.admin.post(`/deliveries/${delivery.id}/recall`, { reason: 'Pirate' })).status, 404)
    const res = await RC.admin.post(`/deliveries/${delivery.id}/recall`, { reason: 'Le client annule' })
    assert.equal(res.status, 200, JSON.stringify(res.body))
    assert.equal(res.body.data.status, 'FAILED')
    assert.equal(res.body.data.failureReason, 'RECALLED')
    assert.ok((await prisma.trackingSession.findUniqueOrThrow({ where: { id: session.id } })).stoppedAt, 'suivi arrêté')
    const notes = (await RC.driverClient.get('/notifications')).body.data.items as Array<{ title: string; body: string }>
    assert.ok(notes.some((n) => n.title === 'Mission arrêtée' && n.body.includes(delivery.number)), 'chauffeur prévenu')
    const missions = (await RC.driverClient.get('/drivers/me/missions?scope=history')).body.data as Array<{ id: string; failureReason: string; failureComment: string }>
    assert.equal(missions.find((m) => m.id === delivery.id)?.failureComment, 'Le client annule')
    assert.equal((await RC.driverClient.post(`/deliveries/${delivery.id}/arrive`, { clientOpId: uid() })).status, 409, 'plus d\'arrivée possible')
    assert.equal((await RC.admin.post(`/deliveries/${delivery.id}/cancel`, {})).status, 409, 'annulation après le retour seulement')
    const stock = await onHand(RC)
    assert.equal((await RC.admin.post(`/deliveries/${delivery.id}/return`, { condition: 'GOOD' })).status, 200)
    assert.equal((await onHand(RC)).onHand, stock.onHand + 1, 'la marchandise revient au stock')
  })

  it('un véhicule n\'a qu\'un seul chauffeur à la fois', async () => {
    const V = await makeCompany(app, root, 'UNVEHICULE')
    const licence = { password: 'Password123', licenseNumber: 'L2', licenseExpiry: new Date(Date.now() + 86400_000 * 365).toISOString() }
    const other = (await V.admin.post('/drivers', { fullName: 'Second', phone: `+24375${Math.floor(Math.random() * 1e7)}`, ...licence })).body.data
    const truck2 = (await V.admin.post('/vehicles', { registration: 'V-DEUX', type: 'TRUCK', weightCapacityKg: 100000, volumeCapacityM3: 1000 })).body.data
    const first = (await assignedDelivery(V, 1)).delivery

    const pack = (await V.admin.post('/packages', { warehouseId: V.wh.id, items: [{ productId: V.product.id, quantity: 1 }] })).body.data
    const second = (await V.admin.post('/deliveries', { packageIds: [pack.id], customerId: V.customer.id, deliveryPointId: V.point.id, justification: 'Essai' })).body.data
    await V.admin.post(`/deliveries/${second.id}/validate`)
    const body = { driverId: other.id, vehicleId: V.vehicle.id }
    const refused = await V.admin.post(`/deliveries/${second.id}/assign`, body)
    assert.equal(refused.status, 409)
    assert.equal(refused.body.code, 'ASSIGNMENT_REJECTED')
    assert.ok(JSON.stringify(refused.body).includes('V-CODE') || JSON.stringify(refused.body).includes(first.number), JSON.stringify(refused.body))
    assert.equal((await V.admin.post('/routes', { plannedAt: new Date().toISOString(), warehouseId: V.wh.id, driverId: other.id, vehicleId: V.vehicle.id, deliveryIds: [second.id] })).status, 409, 'même règle pour une tournée')

    // Le même chauffeur peut le garder ; un autre prend un autre véhicule.
    assert.equal((await V.admin.post(`/deliveries/${second.id}/assign`, { driverId: V.driver.id, vehicleId: V.vehicle.id })).status, 200)
    assert.equal((await V.admin.post(`/deliveries/${second.id}/assign`, { driverId: other.id, vehicleId: truck2.id })).status, 200)
    // Les livraisons terminées libèrent le véhicule.
    await V.driverClient.post(`/deliveries/${first.id}/load`)
    await V.driverClient.post(`/deliveries/${first.id}/start`)
    await V.driverClient.post(`/deliveries/${first.id}/arrive`)
    await signature(V, first.id)
    await V.driverClient.post(`/deliveries/${first.id}/confirm`, { recipientName: 'Fin' })
    assert.equal((await V.admin.post(`/deliveries/${second.id}/assign`, body)).status, 200, 'véhicule libre')
  })

  it('une position ancienne n\'est jamais présentée comme en direct', async () => {
    const { freshness } = await import('../src/modules/tracking/tracking.module.js')
    assert.equal(freshness(new Date(Date.now() - 10 * 60_000)).isLive, false)
    assert.equal(freshness(new Date(Date.now() - 30_000)).isLive, true)
  })

  it('les jours des rapports suivent le fuseau horaire de l\'entreprise', async () => {
    const { startOfDay, dayBound } = await import('../src/common/time.js')
    const at = new Date('2026-03-10T23:30:00Z')
    assert.equal(startOfDay(at, 'Africa/Kinshasa').toISOString(), '2026-03-10T23:00:00.000Z', 'déjà le 11 mars à Kinshasa')
    assert.equal(startOfDay(at, 'Asia/Tokyo').toISOString(), '2026-03-10T15:00:00.000Z')
    assert.equal(startOfDay(new Date('2026-07-01T05:00:00Z'), 'America/New_York').toISOString(), '2026-07-01T04:00:00.000Z', 'heure d\'été')
    assert.equal(dayBound('2026-03-11', 'Africa/Kinshasa', true).toISOString(), '2026-03-11T22:59:59.999Z')

    const TZ = await makeCompany(app, root, 'FUSEAU')
    assert.equal((await TZ.admin.put('/companies/current/settings', { timezone: 'Mars/Olympus' })).status, 422)
    await TZ.admin.put('/companies/current/settings', { timezone: 'Asia/Tokyo' })
    const { delivery } = await assignedDelivery(TZ, 1)
    // 16 h UTC le 1er janvier, soit 1 h du matin le 2 janvier à Tokyo.
    await prisma.delivery.update({ where: { id: delivery.id }, data: { createdAt: new Date('2025-01-01T16:00:00Z') } })
    const numbers = async (day: string) => ((await TZ.admin.get(`/reports/deliveries?from=${day}&to=${day}`)).body.data.rows as Array<{ number: string }>).map((r) => r.number)
    assert.deepEqual(await numbers('2025-01-02'), [delivery.number])
    assert.deepEqual(await numbers('2025-01-01'), [])
  })

  it('les PDF de rapports portent le nom et le logo de l\'entreprise', async () => {
    const { inflateSync } = await import('node:zlib')
    const text = (pdf: Buffer) => {
      const raw = pdf.toString('latin1')
      let out = raw
      for (const m of raw.matchAll(/stream\r?\n([\s\S]*?)endstream/g)) {
        try { out += inflateSync(Buffer.from(m[1], 'latin1')).toString('latin1') } catch { /* flux non compressé */ }
      }
      return out
    }
    // Le texte d'un PDF est découpé par l'ajustement des lettres : on recolle les morceaux.
    const words = (content: string) => [...content.matchAll(/<([0-9a-f]+)>/g)].map((m) => Buffer.from(m[1], 'hex').toString('latin1')).join('')
    await A.admin.patch('/companies/current', { tradeName: 'Entreprise A', address: '12 avenue du Port' })
    await A.admin.upload('/companies/current/logo', {}, { name: 'logo.png', type: 'image/png', data: PNG })
    const res = await A.admin.get('/reports/stocks?format=pdf').buffer(true).parse((r, cb) => { const chunks: Buffer[] = []; r.on('data', (c: Buffer) => chunks.push(c)); r.on('end', () => cb(null, Buffer.concat(chunks))) })
    assert.equal(res.status, 200)
    if (process.env.PDF_DUMP) (await import('node:fs')).writeFileSync(process.env.PDF_DUMP, res.body as Buffer)
    const content = text(res.body as Buffer)
    assert.ok(words(content).includes('Entreprise A'), 'nom de l\'entreprise')
    assert.ok(words(content).includes('12 avenue du Port'), 'coordonnées')
    assert.ok(/\/Subtype\s*\/Image/.test(content), 'logo')
    assert.ok(words(content).includes('Page 1 / 1'), 'pied de page numéroté')

    // Même design pour un bon de livraison : en-tête, pied de page et numéro de page.
    const delivery = await prisma.delivery.findFirstOrThrow({ where: { companyId: A.companyId } })
    const note = await A.admin.get(`/deliveries/${delivery.id}/documents/delivery-note`).buffer(true).parse((r, cb) => { const chunks: Buffer[] = []; r.on('data', (c: Buffer) => chunks.push(c)); r.on('end', () => cb(null, Buffer.concat(chunks))) })
    assert.equal(note.status, 200)
    const noteWords = words(text(note.body as Buffer))
    for (const expected of ['Entreprise A', '12 avenue du Port', 'Bon de livraison', 'Page 1 / 1']) assert.ok(noteWords.includes(expected), expected)

    // Excel : même en-tête, puis le tableau.
    const ExcelJS = (await import('exceljs')).default
    const xlsx = await A.admin.get('/reports/stocks?format=xlsx').buffer(true).parse((r, cb) => { const chunks: Buffer[] = []; r.on('data', (c: Buffer) => chunks.push(c)); r.on('end', () => cb(null, Buffer.concat(chunks))) })
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load((xlsx.body as Buffer).buffer as ArrayBuffer)
    const sheet = wb.worksheets[0]
    assert.equal(sheet.getCell('A1').value, 'Entreprise A')
    assert.ok(String(sheet.getCell('A2').value).includes('12 avenue du Port'))
    const values = sheet.getSheetValues().map((r) => (Array.isArray(r) ? r.join('|') : ''))
    assert.ok(values.some((r) => r.includes('Entrepôt')), 'ligne d\'en-tête du tableau')
  })

  it('les soldes et les mouvements de stock se filtrent par période', async () => {
    const S = await makeCompany(app, root, 'S')
    const ids = async (path: string) => {
      const res = await S.admin.get(path)
      assert.equal(res.status, 200, JSON.stringify(res.body))
      return (res.body.data as Array<{ id: string }>).map((r) => r.id)
    }
    const movements = await ids('/stocks/movements')
    assert.ok(movements.length >= 1)
    await prisma.stockMovement.updateMany({ where: { companyId: S.companyId }, data: { createdAt: new Date('2021-05-10T10:00:00Z') } })
    const balances = await ids('/stocks')
    assert.ok(balances.length >= 1)
    const may = 'from=2021-05-01T00:00:00.000Z&to=2021-05-31T23:59:59.999Z'
    assert.deepEqual((await ids(`/stocks/movements?${may}`)).sort(), [...movements].sort())
    assert.equal((await ids('/stocks/movements?to=2021-05-01T00:00:00.000Z')).length, 0)
    assert.equal((await ids('/stocks/movements?from=2021-06-01T00:00:00.000Z')).length, 0)
    assert.equal((await ids(`/stocks?${may}`)).length, 0, 'solde mis à jour aujourd\'hui, pas en 2021')
    assert.deepEqual((await ids(`/stocks?from=${new Date(Date.now() - 86400_000).toISOString()}`)).sort(), [...balances].sort())
    assert.equal((await S.admin.get('/stocks?from=pas-une-date')).status, 400)
    assert.equal((await S.admin.get('/stocks/movements?to=pas-une-date')).status, 400)
    assert.equal((await A.admin.get(`/stocks/movements?${may}`)).body.data.filter((m: { id: string }) => movements.includes(m.id)).length, 0, 'jamais les mouvements d\'une autre entreprise')
  })

  it('l\'historique se filtre par chauffeur et par période', async () => {
    const dated = await assignedDelivery(A, 1)
    const undated = await assignedDelivery(A, 1)
    await prisma.delivery.update({ where: { id: dated.delivery.id }, data: { scheduledAt: new Date('2020-03-10T10:00:00Z') } })
    await prisma.delivery.update({ where: { id: undated.delivery.id }, data: { scheduledAt: null, createdAt: new Date('2020-03-12T10:00:00Z') } })
    const ids = async (query: string) => {
      const res = await A.admin.get(`/deliveries?${query}`)
      assert.equal(res.status, 200, JSON.stringify(res.body))
      return (res.body.data as Array<{ id: string }>).map((d) => d.id)
    }
    const march = 'from=2020-03-01T00:00:00.000Z&to=2020-03-31T23:59:59.999Z'
    assert.deepEqual((await ids(march)).sort(), [dated.delivery.id, undated.delivery.id].sort())
    assert.deepEqual(await ids('from=2020-03-11T00:00:00.000Z&to=2020-03-31T23:59:59.999Z'), [undated.delivery.id], 'sans date prévue : date de création')
    assert.deepEqual(await ids('to=2020-03-11T00:00:00.000Z'), [dated.delivery.id])
    assert.deepEqual(await ids(`${march}&q=${dated.delivery.number}`), [dated.delivery.id], 'la recherche se combine avec la période')
    assert.equal((await ids(`${march}&driverId=${A.driver.id}`)).length, 2)
    assert.equal((await ids(`${march}&driverId=${B.driver.id}`)).length, 0)
    assert.equal((await A.admin.get('/deliveries?from=pas-une-date')).status, 400)
    await A.admin.post(`/deliveries/${dated.delivery.id}/cancel`, {})
    await A.admin.post(`/deliveries/${undated.delivery.id}/cancel`, {})
  })

  it('la collecte commence au départ et s\'arrête à l\'arrivée', async () => {
    const { delivery } = await assignedDelivery(B, 1)
    await B.driverClient.post(`/deliveries/${delivery.id}/load`)
    await B.driverClient.post(`/deliveries/${delivery.id}/start`)
    const session = (await B.driverClient.post('/tracking/sessions/start', { deliveryId: delivery.id })).body.data
    assert.equal((await prisma.trackingSession.findUniqueOrThrow({ where: { id: session.id } })).stoppedAt, null)
    const road = await B.driverClient.post('/tracking/positions', { sessionId: session.id, positions: [{ clientId: uid(), latitude: 1, longitude: 1, recordedAt: new Date().toISOString() }] })
    assert.equal(road.body.data.stored, 1)
    await B.driverClient.post(`/deliveries/${delivery.id}/arrive`)
    const row = await prisma.trackingSession.findUniqueOrThrow({ where: { id: session.id } })
    assert.ok(row.stoppedAt, 'le suivi se ferme à l\'arrivée')
    assert.equal((await prisma.driver.findUniqueOrThrow({ where: { id: row.driverId } })).status, 'on_mission', 'il travaille encore sur place')
    assert.equal((await B.driverClient.post('/tracking/sessions/start', { deliveryId: delivery.id })).status, 403, 'le suivi ne peut pas reprendre sur place')
    assert.equal((await B.driverClient.post('/tracking/sessions/start', {})).status, 422, 'pas de suivi sans mission')
    const live = (await B.admin.get('/tracking/drivers/live')).body.data as Array<{ sessionId: string }>
    assert.ok(live.every((l) => l.sessionId !== session.id), 'il n\'apparaît plus comme suivi')
    await signature(B, delivery.id)
    await B.driverClient.post(`/deliveries/${delivery.id}/confirm`, { recipientName: 'Fin' })
    assert.equal((await prisma.driver.findUniqueOrThrow({ where: { id: row.driverId } })).status, 'available')
    const late = await B.driverClient.post('/tracking/positions', { sessionId: session.id, positions: [{ clientId: uid(), latitude: 1, longitude: 1, recordedAt: new Date(Date.now() + 60_000).toISOString() }] })
    assert.equal(late.body.data.stored, 0)
    assert.equal(late.body.data.sessionActive, false)
  })

  it('le portail public n\'expose aucune donnée interne', async () => {
    const { delivery, pack } = await assignedDelivery(A, 1)
    await arrived(A, delivery.id)
    const anon = new Client(app)
    assert.equal((await anon.post('/public/tracking/search', { trackingNumber: 'INCONNU123' })).status, 404)
    const { token } = (await anon.post('/public/tracking/search', { trackingNumber: pack.trackingNumber })).body.data
    const page = await anon.get(`/public/tracking/${token}`)
    assert.equal(page.status, 200)
    assert.equal(page.body.data.statusLabel, 'Arrivé')
    assert.equal(page.body.data.destination.label, 'Limete, Kinshasa')
    assert.equal(page.body.data.live, false, 'le numéro de suivi ne donne jamais la carte en direct')
    assert.equal(page.body.data.tracking, null)
    const text = JSON.stringify(page.body)
    for (const secret of ['avenue secrète', A.driver.fullName, A.driver.phone, '+243822222222', A.customer.name, A.vehicle.registration, A.product.name, delivery.id]) {
      assert.ok(!text.includes(secret), `fuite : ${secret}`)
    }
    assert.ok(page.body.data.events.length >= 3)
  })
})

describe('Abonnements et paiements', () => {
  const sign = (body: object) => createHmac('sha256', 'test-webhook').update(JSON.stringify(body)).digest('hex')
  let C: Co

  before(async () => {
    C = await makeCompany(app, root, 'C')
  })

  const invoice = async () => (await C.admin.post('/subscriptions/renew')).body.data

  it('paiement confirmé : facture payée et abonnement actif', async () => {
    const inv = await invoice()
    assert.equal(inv.status, 'UNPAID')
    assert.equal((await C.admin.post('/admin/payments', { invoiceId: inv.id, externalRef: 'X', amount: 100, currency: 'USD' })).status, 403)
    const pay = await root.post('/admin/payments', { invoiceId: inv.id, provider: 'manual', externalRef: 'REF-1', amount: 100, currency: 'USD' })
    assert.equal(pay.status, 201)
    const cur = (await C.admin.get('/subscriptions/current')).body.data.subscription
    assert.equal(cur.status, 'ACTIVE')
    assert.equal(Number(cur.monthlyAmount), 100)
  })

  it('paiement répété : webhook idempotent, sans double effet', async () => {
    const inv = await invoice()
    const body = { externalRef: 'WH-1', invoiceNumber: inv.number, amount: 100, currency: 'USD', status: 'SUCCEEDED' }
    const anon = new Client(app)
    assert.equal((await anon.post('/payments/webhook/mobilemoney', body).set('x-signature', 'faux')).status, 401)
    const first = await anon.post('/payments/webhook/mobilemoney', body).set('x-signature', sign(body))
    assert.equal(first.status, 200, JSON.stringify(first.body))
    const before = (await C.admin.get('/subscriptions/current')).body.data.subscription.endsAt
    const second = await anon.post('/payments/webhook/mobilemoney', body).set('x-signature', sign(body))
    assert.equal(second.body.data.id, first.body.data.id)
    assert.equal((await C.admin.get('/subscriptions/current')).body.data.subscription.endsAt, before)
    assert.equal((await C.admin.get('/subscriptions/payments')).body.data.filter((p: { externalRef: string }) => p.externalRef === 'WH-1').length, 1)
  })

  it('paiement échoué : l\'abonnement n\'est pas activé, montant erroné refusé', async () => {
    const before = (await C.admin.get('/subscriptions/current')).body.data.subscription.id
    const inv = await invoice()
    const body = { externalRef: 'WH-FAIL', invoiceNumber: inv.number, amount: 100, currency: 'USD', status: 'FAILED' }
    await new Client(app).post('/payments/webhook/mobilemoney', body).set('x-signature', sign(body))
    assert.equal((await C.admin.get('/subscriptions/current')).body.data.subscription.id, before)
    assert.equal((await C.admin.get('/subscriptions/invoices')).body.data.find((i: { id: string }) => i.id === inv.id).status, 'UNPAID')
    assert.equal((await root.post('/admin/payments', { invoiceId: inv.id, externalRef: 'LOW', amount: 1, currency: 'USD' })).status, 400)
  })

  it('expiration : période de grâce, puis lecture seule, puis réactivation par renouvellement', async () => {
    const { JobsService } = await import('../src/modules/saas/jobs.service.js')
    const jobs = app.get(JobsService)
    const current = (await C.admin.get('/subscriptions/current')).body.data.subscription
    const past = new Date(Date.now() - 86400_000)
    await prisma.subscription.update({ where: { id: current.id }, data: { endsAt: past } })
    await jobs.subscriptions()
    assert.equal((await C.admin.get('/subscriptions/current')).body.data.subscription.status, 'GRACE')
    assert.equal((await C.admin.post('/warehouses', { name: 'Grâce', code: 'GRC' })).status, 201, 'utilisable pendant la grâce')

    await prisma.subscription.update({ where: { id: current.id }, data: { graceEndsAt: new Date(Date.now() - 1000) } })
    await jobs.subscriptions()
    assert.equal((await C.admin.get('/subscriptions/current')).body.data.subscription.status, 'EXPIRED')
    const blocked = await C.admin.post('/warehouses', { name: 'Bloqué', code: 'BLK' })
    assert.equal(blocked.status, 403)
    assert.equal(blocked.body.code, 'SUBSCRIPTION_INACTIVE')
    assert.equal((await C.admin.get('/warehouses')).status, 200, 'les données restent consultables')

    const renewal = (await C.admin.post('/subscriptions/renew')).body.data
    assert.equal((await C.admin.post('/subscriptions/renew')).body.data.id, renewal.id, 'pas de facture en double')
    await root.post('/admin/payments', { invoiceId: renewal.id, externalRef: 'RENEW-1', amount: 100, currency: 'USD' })
    assert.equal((await C.admin.get('/subscriptions/current')).body.data.subscription.status, 'ACTIVE')
    assert.equal((await C.admin.post('/warehouses', { name: 'Rétabli', code: 'RTB' })).status, 201)
  })

  it('la remise dépend de la durée : 3 mois 5 %, 6 mois 9 %, 12 mois 12 %, 24 mois 25 %', async () => {
    const E = await makeCompany(app, root, 'E')
    const expected: Array<[number, number, number]> = [[1, 0, 100], [3, 5, 285], [6, 9, 546], [12, 12, 1056], [24, 25, 1800]]
    const seen = (await E.admin.get('/subscriptions/current')).body.data.durations as Array<{ durationMonths: number; discountPercent: number; total: number }>
    assert.deepEqual(seen.map((d) => [d.durationMonths, d.discountPercent, Number(d.total)]), expected)
    for (const [months, discount, total] of expected) {
      const inv = (await E.admin.post('/subscriptions/renew', { durationMonths: months })).body.data
      assert.equal(Number(inv.amount), total, `${months} mois`)
      assert.equal(inv.discountPercent, discount)
      assert.equal(inv.durationMonths, months)
      assert.equal(new Date(inv.periodEnd).getUTCMonth(), new Date(new Date(inv.periodStart).setUTCMonth(new Date(inv.periodStart).getUTCMonth() + months)).getUTCMonth())
    }
    const invoices = (await E.admin.get('/subscriptions/invoices')).body.data as Array<{ status: string }>
    assert.equal(invoices.filter((i) => i.status === 'UNPAID').length, 1, 'une seule facture à payer')
    assert.equal((await E.admin.post('/subscriptions/renew', { durationMonths: 2 })).status, 422, 'durée inconnue')
    assert.equal((await E.admin.post('/subscriptions/renew', { durationMonths: 12, amount: 1, monthlyAmount: 1, discountPercent: 90 })).body.data.discountPercent, 12, 'le navigateur ne fixe ni le prix ni la remise')
  })

  it('les centimes sont arrondis exactement', async () => {
    const res = await root.post('/companies', { tradeName: 'Centimes', email: 'c@test.local', adminName: 'Admin C', adminEmail: 'admin-cent@test.local', adminPassword: 'Password123', monthlyAmount: 33.33 })
    assert.equal(res.status, 201, JSON.stringify(res.body))
    const admin = new Client(app)
    await admin.login('admin-cent@test.local', 'Password123')
    assert.equal(Number((await admin.post('/subscriptions/renew', { durationMonths: 3 })).body.data.amount), 94.99)
  })

  it('une entreprise sans montant mensuel ne peut pas être créée', async () => {
    const body = { tradeName: 'Sans prix', email: 'sp@test.local', adminName: 'Admin S', adminEmail: 'admin-sp@test.local', adminPassword: 'Password123' }
    assert.equal((await root.post('/companies', body)).status, 422)
    assert.equal((await root.post('/companies', { ...body, monthlyAmount: 0 })).status, 422)
  })

  it('seul le Super Administrateur fait varier l\'abonnement, et la facture en attente suit le nouveau prix', async () => {
    const F = await makeCompany(app, root, 'F')
    const old = (await F.admin.post('/subscriptions/renew', { durationMonths: 6 })).body.data
    assert.equal((await F.admin.patch(`/companies/${F.companyId}/subscription`, { monthlyAmount: 1 })).status, 403)
    assert.equal((await C.admin.patch(`/companies/${F.companyId}/subscription`, { monthlyAmount: 1 })).status, 403)
    const changed = await root.patch(`/companies/${F.companyId}/subscription`, { monthlyAmount: 200 })
    assert.equal(changed.status, 200, JSON.stringify(changed.body))
    assert.equal(changed.body.data.gpsEnabled, true, 'une modification partielle garde le reste')
    const invoices = (await F.admin.get('/subscriptions/invoices')).body.data as Array<{ id: string; status: string; amount: number; number: string }>
    assert.equal(invoices.find((i) => i.id === old.id)?.status, 'CANCELLED')
    const fresh = invoices.find((i) => i.status === 'UNPAID')
    assert.equal(Number(fresh?.amount), 1092, '200 × 6 moins 9 %')
    assert.equal((await root.post('/admin/payments', { invoiceId: old.id, externalRef: 'OLD', amount: 546, currency: 'USD' })).status, 409, 'une facture annulée ne se paie plus')
    assert.equal((await root.post('/admin/payments', { invoiceId: fresh?.id, externalRef: 'NEW', amount: 1092, currency: 'USD' })).status, 201)
    const current = (await F.admin.get('/subscriptions/current')).body.data.subscription
    assert.equal(current.status, 'ACTIVE')
    assert.equal(current.durationMonths, 6)
    assert.equal((await root.patch('/companies/00000000-0000-4000-8000-000000000000/subscription', { monthlyAmount: 5 })).status, 404)
  })

  it('essai gratuit de 3 jours, sans facture : ensuite, c\'est l\'entreprise qui s\'abonne', async () => {
    const T = await makeCompany(app, root, 'T')
    const trial = (await T.admin.get('/subscriptions/current')).body.data.subscription
    assert.equal(trial.status, 'TRIAL')
    const days = (new Date(trial.endsAt).getTime() - Date.now()) / 86400_000
    assert.ok(days > 2.99 && days <= 3, `essai de ${days} jours`)
    assert.equal((await T.admin.get('/subscriptions/invoices')).body.data.length, 0, 'aucune facture à la création')
    assert.equal((await root.post(`/companies/${T.companyId}/subscription/invoice`, { durationMonths: 3 })).status, 404, 'le Super Administrateur n\'abonne pas à sa place')

    // Abonnement pris pendant l'essai : les jours gratuits restent acquis.
    const early = (await T.admin.post('/subscriptions/renew', { durationMonths: 3 })).body.data
    assert.equal(new Date(early.periodStart).toISOString(), new Date(trial.endsAt).toISOString())
    await prisma.subscriptionInvoice.update({ where: { id: early.id }, data: { status: 'CANCELLED' } })

    await prisma.subscription.update({ where: { id: trial.id }, data: { endsAt: new Date(Date.now() - 1000) } })
    const blocked = await T.admin.post('/warehouses', { name: 'Fin essai', code: 'FIN' })
    assert.equal(blocked.status, 403, 'bloqué dès la fin de l\'essai, même avant la tâche périodique')
    assert.equal(blocked.body.code, 'SUBSCRIPTION_INACTIVE')
    assert.equal((await T.admin.get('/warehouses')).status, 200, 'les données restent consultables')
    const { JobsService } = await import('../src/modules/saas/jobs.service.js')
    await app.get(JobsService).subscriptions()
    assert.equal((await T.admin.get('/subscriptions/current')).body.data.subscription.status, 'EXPIRED', 'pas de période de grâce après un essai')

    const inv = (await T.admin.post('/subscriptions/renew', { durationMonths: 12 })).body.data
    assert.equal(Number(inv.amount), 1056)
    assert.equal((await root.post('/admin/payments', { invoiceId: inv.id, externalRef: 'T-1', amount: 1056, currency: 'USD' })).status, 201)
    assert.equal((await T.admin.post('/warehouses', { name: 'Abonné', code: 'ABO' })).status, 201)
  })

  it('une entreprise active change de durée : elle garde sa période jusqu\'au règlement, puis la nouvelle durée suit l\'échéance', async () => {
    const H = await makeCompany(app, root, 'H')
    const first = (await H.admin.post('/subscriptions/renew')).body.data
    await root.post('/admin/payments', { invoiceId: first.id, externalRef: 'H-1', amount: 100, currency: 'USD' })
    const before = (await H.admin.get('/subscriptions/current')).body.data.subscription
    const inv = (await H.admin.post('/subscriptions/renew', { durationMonths: 12 })).body.data
    assert.equal(new Date(inv.periodStart).toISOString(), new Date(before.endsAt).toISOString(), 'démarre à l\'échéance')
    const waiting = (await H.admin.get('/subscriptions/current')).body.data.subscription
    assert.equal(waiting.durationMonths, 1, 'rien ne change avant le règlement')
    assert.equal(waiting.endsAt, before.endsAt)
    assert.equal(waiting.status, 'ACTIVE')
    assert.equal((await H.admin.post('/warehouses', { name: 'Toujours actif', code: 'ACT' })).status, 201)
    await root.post('/admin/payments', { invoiceId: inv.id, externalRef: 'H-2', amount: Number(inv.amount), currency: 'USD' })
    const after = (await H.admin.get('/subscriptions/current')).body.data.subscription
    assert.equal(after.durationMonths, 12)
    assert.equal(new Date(after.endsAt).toISOString(), new Date(inv.periodEnd).toISOString())
    assert.ok(new Date(after.endsAt) > new Date(before.endsAt))
  })

  it('une entreprise expirée se réabonne avec une autre durée, à partir de maintenant, sans se payer elle-même', async () => {
    const I = await makeCompany(app, root, 'I')
    const { JobsService } = await import('../src/modules/saas/jobs.service.js')
    const current = (await I.admin.get('/subscriptions/current')).body.data.subscription
    await prisma.subscription.update({ where: { id: current.id }, data: { endsAt: new Date(Date.now() - 60 * 86400_000), graceDays: 0 } })
    await prisma.subscriptionInvoice.updateMany({ where: { subscriptionId: current.id }, data: { status: 'CANCELLED' } })
    await app.get(JobsService).subscriptions()
    assert.equal((await I.admin.get('/subscriptions/current')).body.data.subscription.status, 'EXPIRED')
    assert.equal((await I.admin.post('/warehouses', { name: 'Bloqué', code: 'BLQ' })).status, 403)

    const start = Date.now()
    const inv = (await I.admin.post('/subscriptions/renew', { durationMonths: 6 })).body.data
    assert.ok(new Date(inv.periodStart).getTime() >= start - 1000, 'pas de période déjà écoulée')
    assert.equal(Number(inv.amount), 546)
    assert.equal((await I.admin.get('/subscriptions/current')).body.data.subscription.status, 'EXPIRED', 'la demande seule ne rouvre pas l\'accès')
    assert.equal((await I.admin.post('/admin/payments', { invoiceId: inv.id, externalRef: 'I-1', amount: 546, currency: 'USD' })).status, 403)

    // Le règlement arrive dix jours après la demande : ces jours ne sont pas perdus.
    await prisma.subscriptionInvoice.update({ where: { id: inv.id }, data: { periodStart: new Date(Date.now() - 10 * 86400_000), periodEnd: new Date(Date.now() + 170 * 86400_000) } })
    assert.equal((await root.post('/admin/payments', { invoiceId: inv.id, externalRef: 'I-2', amount: 546, currency: 'USD' })).status, 201)
    const after = (await I.admin.get('/subscriptions/current')).body.data.subscription
    assert.equal(after.status, 'ACTIVE')
    assert.equal(after.durationMonths, 6)
    assert.ok(new Date(after.startsAt).getTime() >= start, 'la période démarre au règlement')
    assert.ok(new Date(after.endsAt).getTime() > Date.now() + 175 * 86400_000, 'six mois complets')
    const paid = (await I.admin.get('/subscriptions/invoices')).body.data.find((i: { id: string }) => i.id === inv.id)
    assert.equal(new Date(paid.periodEnd).toISOString(), new Date(after.endsAt).toISOString(), 'la facture indique la période réelle')
    assert.equal((await I.admin.post('/warehouses', { name: 'Rouvert', code: 'RVT' })).status, 201)
  })

  it('abonnement expiré : une mission commencée va jusqu\'au bout, aucune nouvelle ne démarre', async () => {
    const X = await makeCompany(app, root, 'X')
    const enRoute = await assignedDeliveryKeep(X, 1)
    await X.driverClient.post(`/deliveries/${enRoute.delivery.id}/load`)
    await X.driverClient.post(`/deliveries/${enRoute.delivery.id}/start`)
    const session = (await X.driverClient.post('/tracking/sessions/start', { deliveryId: enRoute.delivery.id })).body.data
    const chargee = await assignedDeliveryKeep(X, 1)
    await X.driverClient.post(`/deliveries/${chargee.delivery.id}/load`)
    const nonChargee = await assignedDeliveryKeep(X, 1)
    const stockBefore = await onHand(X)

    const current = (await X.admin.get('/subscriptions/current')).body.data.subscription
    await prisma.subscription.update({ where: { id: current.id }, data: { status: 'EXPIRED' } })
    assert.equal((await X.driverClient.get('/drivers/me')).body.data.rules.subscriptionActive, false)
    assert.equal((await X.admin.get('/subscriptions/status')).body.data.status, 'EXPIRED')
    assert.equal((await X.driverClient.get('/subscriptions/status')).body.data.monthlyAmount, undefined, 'le chauffeur ne voit pas le prix')

    // Aucune nouvelle activité.
    const refused = await X.driverClient.post(`/deliveries/${nonChargee.delivery.id}/load`)
    assert.equal(refused.status, 403)
    assert.equal(refused.body.code, 'SUBSCRIPTION_INACTIVE')
    assert.match(refused.body.message, /contactez votre responsable/)
    assert.equal((await X.driverClient.post(`/deliveries/${nonChargee.delivery.id}/start`)).status, 403)
    assert.equal((await X.driverClient.post('/tracking/sessions/start', { deliveryId: nonChargee.delivery.id })).status, 403)
    assert.equal((await X.admin.post('/orders', { customerId: X.customer.id, deliveryPointId: X.point.id, warehouseId: X.wh.id, items: [{ productId: X.product.id, quantity: 1 }] })).status, 403)
    assert.equal((await X.admin.post(`/deliveries/${enRoute.delivery.id}/reschedule`, { scheduledAt: new Date().toISOString() })).status, 403)

    // La mission en route continue, GPS et preuves compris.
    const positions = await X.driverClient.post('/tracking/positions', { sessionId: session.id, positions: [{ clientId: uid(), latitude: 1, longitude: 1, recordedAt: new Date().toISOString() }] })
    assert.equal(positions.body.data.stored, 1)
    assert.equal((await X.driverClient.post(`/deliveries/${enRoute.delivery.id}/arrive`)).status, 200)
    assert.equal((await signature(X, enRoute.delivery.id)).status, 201)
    assert.equal((await X.driverClient.post(`/deliveries/${enRoute.delivery.id}/confirm`, { recipientName: 'Fin' })).status, 200)
    assert.equal((await X.admin.get(`/deliveries/${enRoute.delivery.id}`)).body.data.status, 'DELIVERED')
    assert.equal((await X.driverClient.post(`/deliveries/${enRoute.delivery.id}/confirm`, { recipientName: 'Fin' })).status, 409, 'une mission finie ne repart pas')

    // Une livraison chargée peut partir ; un échec peut revenir au stock.
    assert.equal((await X.driverClient.post(`/deliveries/${chargee.delivery.id}/start`)).status, 200)
    assert.equal((await X.driverClient.post(`/deliveries/${chargee.delivery.id}/fail`, { reason: 'CUSTOMER_ABSENT', comment: 'Absent' })).status, 200)
    assert.equal((await X.admin.post(`/deliveries/${chargee.delivery.id}/return`, { condition: 'GOOD' })).status, 200)
    assert.equal((await onHand(X)).onHand, stockBefore.onHand + 1, 'la marchandise retournée revient au stock')

    // Une entreprise ne profite pas d'une mission d'une autre, ni d'un identifiant inventé.
    assert.equal((await X.driverClient.post(`/deliveries/${uid()}/arrive`)).status, 403)
  })

  it('les limites propres à l\'abonnement sont appliquées, sinon illimité', async () => {
    const G = await makeCompany(app, root, 'G')
    assert.equal((await G.admin.post('/warehouses', { name: 'Libre', code: 'LIB' })).status, 201, 'sans limite : illimité')
    await root.patch(`/companies/${G.companyId}/subscription`, { maxWarehouses: 2, maxVehicles: 0, gpsEnabled: false })
    const res = await G.admin.post('/warehouses', { name: 'Trop', code: 'TRP' })
    assert.equal(res.status, 403)
    assert.equal(res.body.code, 'LIMIT_REACHED')
    assert.equal((await G.admin.post('/vehicles', { registration: 'NOPE', type: 'VAN' })).status, 403)
    const { delivery } = await assignedDelivery(G, 1)
    assert.equal((await G.driverClient.post('/tracking/sessions/start', { deliveryId: delivery.id })).body.code, 'GPS_NOT_INCLUDED')
    await root.patch(`/companies/${G.companyId}/subscription`, { maxWarehouses: null })
    assert.equal((await G.admin.post('/warehouses', { name: 'Rouvert', code: 'ROU' })).status, 201)
  })

  it('l\'entreprise garde au moins un administrateur principal', async () => {
    const me = (await C.admin.get('/auth/me')).body.data
    assert.equal((await C.admin.post(`/users/${me.id}/deactivate`)).status, 409)
  })
})

describe('Tableaux de bord et rapports', () => {
  it('les statistiques reflètent les opérations', async () => {
    const start = (await B.admin.get('/dashboard/overview')).body.data
    const { delivery } = await assignedDelivery(B, 5)
    assert.equal((await B.admin.get('/dashboard/overview')).body.data.inProgress, start.inProgress + 1)
    await arrived(B, delivery.id)
    await signature(B, delivery.id)
    await B.driverClient.post(`/deliveries/${delivery.id}/confirm`, { recipientName: 'Stat' })
    const end = (await B.admin.get('/dashboard/overview')).body.data
    assert.equal(end.inProgress, start.inProgress)
    assert.equal(end.deliveredToday, start.deliveredToday + 1)
    assert.equal(end.stockValue, start.stockValue - 50)
    const platform = (await root.get('/admin/dashboard')).body.data
    assert.ok(platform.companies >= 3)
    assert.ok(platform.delivered >= 1)
  })

  it('exporte en CSV, Excel et PDF, sans fuite entre entreprises', async () => {
    const json = (await B.admin.get('/reports/deliveries')).body.data
    assert.ok(json.rows.length > 0)
    assert.ok(json.rows.every((r: { customer: string }) => r.customer === B.customer.name))
    const csv = await B.admin.get('/reports/stocks?format=csv')
    assert.equal(csv.status, 200)
    assert.ok(csv.text.includes('Entrepôt'))
    for (const format of ['xlsx', 'pdf']) {
      const res = await B.admin.get(`/reports/drivers?format=${format}`).buffer(true).parse((r, cb) => {
        const chunks: Buffer[] = []
        r.on('data', (c: Buffer) => chunks.push(c))
        r.on('end', () => cb(null, Buffer.concat(chunks)))
      })
      assert.equal(res.status, 200, format)
      assert.ok(res.body.length > 100)
    }
    assert.equal((await B.driverClient.get('/reports/stocks')).status, 403)
  })

  it('neutralise l\'injection de formules dans les exports CSV', async () => {
    const { escapeCsv } = await import('../src/common/util.js')
    assert.equal(escapeCsv('=HYPERLINK("x")').startsWith("\"'="), true)
    assert.equal(escapeCsv('-12'), '-12')
  })

  it('les opérations critiques sont auditables', async () => {
    const actions = (await B.admin.get('/audit-logs?limit=200')).body.data.map((l: { action: string }) => l.action)
    for (const a of ['delivery.confirm', 'delivery.assign', 'stock.receive']) assert.ok(actions.includes(a), a)
  })

  it('les notifications parviennent au chauffeur et ne fuient pas', async () => {
    const list = (await A.driverClient.get('/notifications')).body.data
    assert.ok(list.items.some((n: { type: string }) => n.type === 'DELIVERY_ASSIGNED'))
    const id = list.items[0].id
    await B.admin.post(`/notifications/${id}/read`)
    assert.equal((await prisma.notification.findUniqueOrThrow({ where: { id } })).readAt, null)
  })
})
