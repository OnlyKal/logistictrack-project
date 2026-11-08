import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import type { INestApplication } from '@nestjs/common'
import type { PrismaClient } from '@prisma/client'
import { io, type Socket } from 'socket.io-client'
import { assignedDeliveryKeep, boot, Client, finishTrips, makeCompany, PNG, uid, type Co } from './helpers.js'

let app: INestApplication
let cleanup: () => Promise<void>
let prisma: PrismaClient
let root: Client
let A: Co
let B: Co
let url = ''
let liveKey: (t: string) => string
let publicTrackingUrl: (t: string) => string
const anon = () => new Client(app)

before(async () => {
  ;({ app, cleanup } = await boot())
  await app.listen(0)
  url = await app.getUrl()
  const { PrismaService } = await import('../src/common/prisma.service.js')
  ;({ liveKey, publicTrackingUrl } = await import('../src/common/public-link.js'))
  prisma = app.get(PrismaService)
  const bcrypt = (await import('bcryptjs')).default
  await prisma.user.create({ data: { fullName: 'Root', email: 'root@test.local', passwordHash: await bcrypt.hash('Password123', 4), isSuperAdmin: true } })
  root = new Client(app)
  await root.login('root@test.local', 'Password123')
  A = await makeCompany(app, root, 'PTA')
  B = await makeCompany(app, root, 'PTB')
  await A.admin.patch(`/customers/${A.customer.id}/delivery-points/${A.point.id}`, { latitude: -4.36, longitude: 15.35 })
})
after(async () => cleanup())

const tokenOf = async (deliveryId: string) => (await prisma.package.findFirstOrThrow({ where: { deliveryId } })).trackingToken
const view = async (token: string, key?: string) => (await anon().get(`/public/tracking/${token}${key ? `?k=${key}` : ''}`)).body.data
/** Positions mesurées après le départ, quelques instants après « maintenant ». */
const soon = (ms: number) => new Date(Date.now() + ms).toISOString()

/** Deux livraisons sur une même tournée : le chauffeur part avec les deux. */
async function tour() {
  await finishTrips(A)
  const first = (await assignedDeliveryKeep(A, 1)).delivery
  const second = (await assignedDeliveryKeep(A, 1)).delivery
  for (const d of [first, second]) await A.admin.post(`/deliveries/${d.id}/unassign`).catch(() => undefined)
  const route = await A.admin.post('/routes', { plannedAt: new Date().toISOString(), warehouseId: A.wh.id, driverId: A.driver.id, vehicleId: A.vehicle.id, deliveryIds: [first.id, second.id] })
  return { first, second, route }
}

describe('Lien de suivi en direct', () => {
  it("le lien est unique, signé et difficile à deviner ; le numéro de suivi n'ouvre jamais la carte", async () => {
    const { delivery } = await assignedDeliveryKeep(A, 1)
    const token = await tokenOf(delivery.id)
    assert.ok(token.length >= 32, 'jeton aléatoire long')
    assert.match(publicTrackingUrl(token), new RegExp(`^https://app.test/suivi-colis/${token}\\?k=[0-9a-f]{40}$`))
    assert.equal((await view(token)).live, false)
    assert.equal((await view(token, 'f'.repeat(40))).live, false, 'clé inventée')
    const other = await tokenOf((await assignedDeliveryKeep(B, 1)).delivery.id)
    assert.equal((await view(token, liveKey(other))).live, false, "la clé d'un autre colis ne vaut rien")
    const ok = await view(token, liveKey(token))
    assert.equal(ok.live, true)
    assert.equal(ok.tracking.state, 'NOT_STARTED', 'pas de position avant le départ')
    assert.equal(ok.destination.latitude, -4.36)
    assert.equal((await view(token)).destination.latitude, null, "sans le lien, jamais l'emplacement exact")
    assert.equal((await anon().get('/public/tracking/inconnu')).status, 404)
    // Le bureau peut transmettre le même lien autrement (SMS, WhatsApp).
    const link = (await A.admin.get(`/deliveries/${delivery.id}/tracking-link`)).body.data
    assert.equal(link.url, publicTrackingUrl(token))
    assert.equal((await B.admin.get(`/deliveries/${delivery.id}/tracking-link`)).status, 404)
  })

  it('pendant le trajet : position, parcours, distance restante, heure du dernier signal ; rien sur le chauffeur', async () => {
    await finishTrips(A)
    const { delivery } = await assignedDeliveryKeep(A, 1)
    const token = await tokenOf(delivery.id)
    await A.driverClient.post(`/deliveries/${delivery.id}/load`)
    await A.driverClient.post(`/deliveries/${delivery.id}/start`)
    assert.equal((await view(token, liveKey(token))).tracking.state, 'WAITING', 'parti, en attente du premier signal')
    const session = (await A.driverClient.post('/tracking/sessions/start', { deliveryId: delivery.id })).body.data
    const positions = [
      { clientId: uid(), latitude: -4.31, longitude: 15.31, accuracyM: 8, headingDeg: 120, recordedAt: soon(100) },
      { clientId: uid(), latitude: -4.32, longitude: 15.32, accuracyM: 500, recordedAt: soon(200) }, // imprécise : écartée
      { clientId: uid(), latitude: -4.33, longitude: 15.33, accuracyM: 10, headingDeg: 130, recordedAt: soon(300) },
    ]
    await A.driverClient.post('/tracking/positions', { sessionId: session.id, positions })
    const v = await view(token, liveKey(token))
    assert.equal(v.status, 'IN_TRANSIT')
    assert.equal(v.statusLabel, 'En route')
    assert.equal(v.tracking.state, 'LIVE')
    assert.deepEqual(v.tracking.trail, [[-4.31, 15.31], [-4.33, 15.33]])
    assert.equal(v.tracking.position.latitude, -4.33)
    assert.equal(v.tracking.position.isLive, true)
    assert.ok(v.tracking.position.recordedAt && v.tracking.position.ageSeconds < 60, 'heure du dernier signal')
    assert.ok(v.tracking.remainingKm > 3.5 && v.tracking.remainingKm < 4.5, String(v.tracking.remainingKm))
    assert.deepEqual(v.steps.map((s: { state: string }) => s.state), ['done', 'done', 'current', 'todo', 'todo'])
    const text = JSON.stringify(v)
    for (const secret of [A.driver.fullName, A.driver.phone, A.driver.id, A.vehicle.registration, A.customer.name, A.wh.name, A.product.name, delivery.id, delivery.number, 'avenue secrète', 'batteryLevel', 'speedMs']) {
      assert.ok(!text.includes(secret), `fuite : ${secret}`)
    }
  })

  it("une tournée : la position est masquée pendant l'arrêt chez un autre client, et son trajet n'est jamais montré", async () => {
    const { first, second, route } = await tour()
    assert.equal(route.status, 201, JSON.stringify(route.body))
    await A.driverClient.post(`/routes/${route.body.data.id}/start`)
    for (const d of [first, second]) {
      await A.driverClient.post(`/deliveries/${d.id}/load`)
      await A.driverClient.post(`/deliveries/${d.id}/start`)
    }
    const token = await tokenOf(second.id)
    const key = liveKey(token)
    assert.equal((await view(token, key)).tracking.stopsBefore, 1, 'une livraison avant la vôtre')
    const session = (await A.driverClient.post('/tracking/sessions/start', { deliveryId: first.id })).body.data
    await A.driverClient.post('/tracking/positions', { sessionId: session.id, positions: [{ clientId: uid(), latitude: -4.40, longitude: 15.20, accuracyM: 5, recordedAt: soon(100) }] })
    await new Promise((r) => setTimeout(r, 250))
    await A.driverClient.post(`/deliveries/${first.id}/arrive`)
    const paused = await view(token, key)
    assert.equal(paused.tracking.state, 'OTHER_STOP')
    assert.equal(paused.tracking.position, null, "jamais l'adresse d'un autre client")
    assert.deepEqual(paused.tracking.trail, [])

    await A.driverClient.post(`/deliveries/${first.id}/fail`, { reason: 'CUSTOMER_ABSENT' })
    const s2 = (await A.driverClient.post('/tracking/sessions/start', { deliveryId: second.id })).body.data
    await new Promise((r) => setTimeout(r, 20))
    await A.driverClient.post('/tracking/positions', { sessionId: s2.id, positions: [{ clientId: uid(), latitude: -4.35, longitude: 15.34, accuracyM: 5, recordedAt: new Date().toISOString() }] })
    const resumed = await view(token, key)
    assert.equal(resumed.tracking.state, 'LIVE')
    assert.equal(resumed.tracking.stopsBefore, 0)
    assert.ok(!JSON.stringify(resumed.tracking.trail).includes('15.2'), "le trajet vers l'autre client n'apparaît pas")

    // Arrivé puis livré : plus aucune position.
    await A.driverClient.post(`/deliveries/${second.id}/arrive`)
    assert.equal((await view(token, key)).tracking.state, 'ARRIVED')
    await A.driverClient.upload(`/deliveries/${second.id}/proofs`, { type: 'SIGNATURE' }, { name: 's.png', type: 'image/png', data: PNG })
    assert.equal((await A.admin.post(`/deliveries/${second.id}/confirm`, { recipientName: 'Réception' })).status, 200)
    const done = await view(token, key)
    assert.equal(done.tracking.state, 'ENDED')
    assert.equal(done.tracking.position, null)
    assert.deepEqual(done.tracking.trail, [])
    assert.deepEqual(done.steps.map((s: { state: string }) => s.state), ['done', 'done', 'done', 'done', 'done'])
  })

  it('échec : la frise se termine sur une étape claire, en rouge', async () => {
    await finishTrips(A)
    const { delivery } = await assignedDeliveryKeep(A, 1)
    await A.driverClient.post(`/deliveries/${delivery.id}/load`)
    await A.driverClient.post(`/deliveries/${delivery.id}/start`)
    await A.driverClient.post(`/deliveries/${delivery.id}/fail`, { reason: 'CUSTOMER_ABSENT' })
    const v = await view(await tokenOf(delivery.id), liveKey(await tokenOf(delivery.id)))
    assert.equal(v.statusLabel, 'Livraison non effectuée')
    assert.deepEqual(v.steps.map((s: { key: string; state: string }) => `${s.key}:${s.state}`), ['REGISTERED:done', 'PREPARED:done', 'IN_TRANSIT:done', 'FAILED:failed'])
  })
})

describe('Mise à jour en temps réel (WebSocket)', () => {
  const connect = (auth: Record<string, string>) => new Promise<{ socket: Socket; ok: boolean }>((resolve) => {
    const socket = io(url, { auth, transports: ['websocket'], reconnection: false })
    socket.on('connect', () => setTimeout(() => resolve({ socket, ok: socket.connected }), 150))
    socket.on('auth_error', () => resolve({ socket, ok: false }))
    socket.on('connect_error', () => resolve({ socket, ok: false }))
  })

  it("sans compte, avec le lien signé : la page reçoit la position, puis l'arrivée ; une fausse clé est refusée", async () => {
    await finishTrips(A)
    const { delivery } = await assignedDeliveryKeep(A, 1)
    const token = await tokenOf(delivery.id)
    const refused = await connect({ trackingToken: token, key: 'a'.repeat(40) })
    assert.equal(refused.ok, false)
    refused.socket.close()

    const { socket, ok } = await connect({ trackingToken: token, key: liveKey(token) })
    assert.equal(ok, true)
    const received: Array<{ event: string; payload: Record<string, unknown> }> = []
    socket.onAny((event, payload) => received.push({ event, payload }))
    await A.driverClient.post(`/deliveries/${delivery.id}/load`)
    await A.driverClient.post(`/deliveries/${delivery.id}/start`)
    const session = (await A.driverClient.post('/tracking/sessions/start', { deliveryId: delivery.id })).body.data
    await A.driverClient.post('/tracking/positions', { sessionId: session.id, positions: [{ clientId: uid(), latitude: -4.30, longitude: 15.30, accuracyM: 6, headingDeg: 90, speedMs: 9, batteryLevel: 50, recordedAt: new Date().toISOString() }] })
    await A.driverClient.post(`/deliveries/${delivery.id}/arrive`)
    await new Promise((r) => setTimeout(r, 300))
    socket.close()

    const position = received.find((r) => r.event === 'public.position')
    assert.ok(position, JSON.stringify(received))
    assert.deepEqual(Object.keys(position.payload).sort(), ['accuracyM', 'headingDeg', 'latitude', 'longitude', 'recordedAt'], 'ni chauffeur, ni batterie, ni vitesse')
    assert.ok(received.some((r) => r.event === 'public.refresh'), "l'arrivée met la page à jour")
    assert.ok(!received.some((r) => ['position.update', 'delivery.status', 'notification'].includes(r.event)), "jamais les événements internes de l'entreprise")
  })
})
