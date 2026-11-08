import 'reflect-metadata'
import { execSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { INestApplication } from '@nestjs/common'
import request from 'supertest'

/** Base SQLite isolée, migrée avec les vraies migrations du projet. */
export async function boot() {
  const dir = mkdtempSync(join(tmpdir(), 'lt-test-'))
  const databaseUrl = `file:${join(dir, 'test.db')}`
  Object.assign(process.env, {
    NODE_ENV: 'test', DATABASE_URL: databaseUrl, JWT_SECRET: 'test-secret-test-secret-test-secret', FILE_URL_SECRET: 'test-files',
    PAYMENT_WEBHOOK_SECRET: 'test-webhook', STORAGE_DIR: join(dir, 'storage'), JOBS_DISABLED: 'true', THROTTLE_DISABLED: 'true', MAIL_TRANSPORT: 'json', BACKUP_DIR: join(dir, 'backups'), BACKUP_COPY_DIR: join(dir, 'copie'), MAIL_FROM: 'LogisticTrack <test@logistictrack.local>', WEB_PUBLIC_URL: 'https://app.test',
  })
  delete process.env.REDIS_URL
  execSync('npx prisma migrate deploy', { env: { ...process.env, DATABASE_URL: databaseUrl }, stdio: 'ignore' })
  const { createApp } = await import('../src/bootstrap.js')
  const app = await createApp({ logger: false })
  await app.init()
  return { app, cleanup: async () => { await app.close(); rmSync(dir, { recursive: true, force: true }) } }
}

export class Client {
  token = ''
  constructor(private readonly app: INestApplication) {}
  private auth(r: request.Test) { return this.token ? r.set('Authorization', `Bearer ${this.token}`) : r }
  get(path: string) { return this.auth(request(this.app.getHttpServer()).get(`/api/v1${path}`)) }
  post(path: string, body?: object) { return this.auth(request(this.app.getHttpServer()).post(`/api/v1${path}`)).send(body ?? {}) }
  patch(path: string, body?: object) { return this.auth(request(this.app.getHttpServer()).patch(`/api/v1${path}`)).send(body ?? {}) }
  put(path: string, body?: object) { return this.auth(request(this.app.getHttpServer()).put(`/api/v1${path}`)).send(body ?? {}) }
  delete(path: string) { return this.auth(request(this.app.getHttpServer()).delete(`/api/v1${path}`)) }
  upload(path: string, fields: Record<string, string>, file?: { name: string; type: string; data: Buffer }) {
    const r = this.auth(request(this.app.getHttpServer()).post(`/api/v1${path}`))
    for (const [k, v] of Object.entries(fields)) r.field(k, v)
    if (file) r.attach('file', file.data, { filename: file.name, contentType: file.type })
    return r
  }
  async login(identifier: string, password: string) {
    const res = await this.post('/auth/login', { identifier, password })
    if (res.status !== 200) throw new Error(`login ${identifier}: ${res.status} ${JSON.stringify(res.body)}`)
    this.token = res.body.data.accessToken
    return res.body.data
  }
}

/** PNG 1×1 valide, utilisé comme signature et photo. */
export const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')

export const uid = () => randomUUID()

/** Valeurs prêtes à l'emploi pour une entreprise active et son administrateur. */
export async function makeCompany(app: INestApplication, superAdmin: Client, label: string) {
  const email = `admin-${label}@test.local`
  const created = await superAdmin.post('/companies', { tradeName: `Entreprise ${label}`, email: `contact-${label}@test.local`, adminName: `Admin ${label}`, adminEmail: email, adminPassword: 'Password123', monthlyAmount: 100 })
  if (created.status !== 201) throw new Error(JSON.stringify(created.body))
  const admin = new Client(app)
  await admin.login(email, 'Password123')
  // Par défaut les tests ne réclament que la signature et le nom.
  const wh = (await admin.post('/warehouses', { name: `Entrepôt ${label}`, code: 'WH1' })).body.data
  const product = (await admin.post('/products', { name: 'Ciment', reference: `CIM-${label}`, baseUnit: 'sac', unitWeightKg: 50, unitVolumeM3: 0.03, unitCost: 10, salePrice: 12 })).body.data
  const customer = (await admin.post('/customers', { name: `Client ${label}`, phone: '+243811111111' })).body.data
  const point = (await admin.post(`/customers/${customer.id}/delivery-points`, { name: 'Dépôt', address: '1 avenue secrète', commune: 'Limete', city: 'Kinshasa', phone: '+243822222222' })).body.data
  const driverPhone = `+2439${Math.floor(Math.random() * 1e8)}`
  const driver = (await admin.post('/drivers', { fullName: `Chauffeur ${label}`, phone: driverPhone, password: 'Password123', licenseNumber: 'L1', licenseExpiry: new Date(Date.now() + 86400_000 * 365).toISOString() })).body.data
  const vehicle = (await admin.post('/vehicles', { registration: `V-${label}`, type: 'TRUCK', weightCapacityKg: 100000, volumeCapacityM3: 1000 })).body.data
  const driverClient = new Client(app)
  await driverClient.login(driverPhone, 'Password123')
  await admin.post('/stocks/receipts', { warehouseId: wh.id, items: [{ productId: product.id, quantity: 1000 }] })
  return { admin, driverClient, wh, product, customer, point, driver, vehicle, companyId: created.body.data.id as string }
}
export type Co = Awaited<ReturnType<typeof makeCompany>>

/** Un chauffeur ne fait qu'un trajet à la fois : les tests libèrent le chauffeur partagé avant une nouvelle mission. */
export async function finishTrips(co: Co) {
  const running = (await co.admin.get(`/deliveries?driverId=${co.driver.id}&status=IN_TRANSIT,ARRIVED&limit=200`)).body.data as Array<{ id: string }>
  for (const d of running) await co.admin.post(`/deliveries/${d.id}/fail`, { reason: 'OTHER', comment: 'Fin de test' })
}

/** Commande validée et préparée, colis créé, livraison validée et affectée. */
export async function assignedDelivery(co: Co, quantity = 100) {
  await finishTrips(co)
  return assignedDeliveryKeep(co, quantity)
}

/** Même préparation, sans toucher aux trajets en cours du chauffeur. */
export async function assignedDeliveryKeep(co: Co, quantity = 100) {
  const a = co.admin
  const order = (await a.post('/orders', { customerId: co.customer.id, deliveryPointId: co.point.id, warehouseId: co.wh.id, items: [{ productId: co.product.id, quantity, unitPrice: 12 }] })).body.data
  await a.post(`/orders/${order.id}/submit`)
  const validated = await a.post(`/orders/${order.id}/validate`)
  if (validated.status !== 200) throw new Error(JSON.stringify(validated.body))
  const prep = await a.post(`/orders/${order.id}/prepare`, { items: [{ orderItemId: order.items[0].id, quantity }] })
  if (prep.status !== 200) throw new Error(JSON.stringify(prep.body))
  const pack = (await a.post('/packages', { warehouseId: co.wh.id, orderId: order.id, items: [{ productId: co.product.id, quantity }] })).body.data
  const delivery = (await a.post('/deliveries', { packageIds: [pack.id], scheduledAt: new Date().toISOString() })).body.data
  await a.post(`/deliveries/${delivery.id}/validate`)
  const assigned = await a.post(`/deliveries/${delivery.id}/assign`, { driverId: co.driver.id, vehicleId: co.vehicle.id })
  if (assigned.status !== 200) throw new Error(JSON.stringify(assigned.body))
  return { order, pack, delivery: assigned.body.data }
}

/** Amène une livraison affectée jusqu'à l'arrivée du chauffeur. */
export async function arrived(co: Co, id: string) {
  const d = co.driverClient
  for (const step of ['load', 'start', 'arrive']) {
    const r = await d.post(`/deliveries/${id}/${step}`)
    if (r.status !== 200) throw new Error(`${step}: ${JSON.stringify(r.body)}`)
  }
}

export const onHand = async (co: Co) => {
  const rows = (await co.admin.get(`/stocks?warehouseId=${co.wh.id}&productId=${co.product.id}`)).body.data
  return rows.reduce((acc: { onHand: number; reserved: number; available: number; damaged: number }, r: { onHand: number; reserved: number; available: number; damaged: number }) => ({
    onHand: acc.onHand + r.onHand, reserved: acc.reserved + r.reserved, available: acc.available + r.available, damaged: acc.damaged + r.damaged,
  }), { onHand: 0, reserved: 0, available: 0, damaged: 0 })
}
