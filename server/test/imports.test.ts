import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import type { INestApplication } from '@nestjs/common'
import type { PrismaClient } from '@prisma/client'
import { boot, Client, makeCompany, type Co } from './helpers.js'

let app: INestApplication
let cleanup: () => Promise<void>
let prisma: PrismaClient
let A: Co
let B: Co

before(async () => {
  ;({ app, cleanup } = await boot())
  const { PrismaService } = await import('../src/common/prisma.service.js')
  prisma = app.get(PrismaService)
  const bcrypt = (await import('bcryptjs')).default
  await prisma.user.create({ data: { fullName: 'Root', email: 'root@test.local', passwordHash: await bcrypt.hash('Password123', 4), isSuperAdmin: true } })
  const root = new Client(app)
  await root.login('root@test.local', 'Password123')
  A = await makeCompany(app, root, 'IMPA')
  B = await makeCompany(app, root, 'IMPB')
})
after(async () => cleanup())

const send = (co: Co, kind: string, csv: string, dryRun = false) =>
  co.admin.upload(`/imports/${kind}${dryRun ? '?dryRun=true' : ''}`, {}, { name: 'import.csv', type: 'text/csv', data: Buffer.from(csv, 'utf8') })

describe('Import CSV', () => {
  it('fournit des modèles prêts pour Excel', async () => {
    const res = await A.admin.get('/imports/products/template').buffer(true).parse((r, cb) => { const chunks: Buffer[] = []; r.on('data', (c: Buffer) => chunks.push(c)); r.on('end', () => cb(null, Buffer.concat(chunks))) })
    assert.equal(res.status, 200)
    const raw = res.body as Buffer
    assert.deepEqual([...raw.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'BOM pour Excel')
    assert.ok(raw.subarray(3).toString('utf8').startsWith('reference*;nom*;unite'), 'séparateur « ; »')
    assert.equal((await A.driverClient.get('/imports/products/template')).status, 403)
  })

  it('marchandises : vérification sans rien enregistrer, puis import et mise à jour', async () => {
    const bad = 'reference;nom;poids_kg;nature\nRIZ-25;Riz 25 kg;25;solide\n;Sans référence;abc;solide\nRIZ-25;Doublon;1;liquide\nHUI-5;Huile;5;plasma\n'
    const check = await send(A, 'products', bad)
    assert.equal(check.status, 200)
    assert.deepEqual(check.body.data.errors.map((e: { line: number }) => e.line), [3, 3, 4, 5])
    assert.equal(await prisma.product.count({ where: { companyId: A.companyId, reference: 'RIZ-25' } }), 0, 'erreur : rien enregistré')

    // Excel français : « ; », virgule décimale, guillemets, BOM.
    const csv = '﻿Référence*;Nom*;Unité;Catégorie;Poids (kg);Coût unitaire;Suivi lots\r\nRIZ-25;"Riz; sac de 25 kg";sac;Alimentaire;25;12,5;non\r\nHUI-5;Huile 5 L;bidon;Alimentaire;4,6;;oui\r\n'
    const preview = await send(A, 'products', csv, true)
    assert.deepEqual(preview.body.data, { dryRun: true, total: 2, created: 2, updated: 0, errors: [] })
    assert.equal(await prisma.product.count({ where: { companyId: A.companyId, reference: { in: ['RIZ-25', 'HUI-5'] } } }), 0, 'aperçu : rien enregistré')
    const done = await send(A, 'products', csv)
    assert.equal(done.body.data.created, 2)
    const riz = await prisma.product.findFirstOrThrow({ where: { companyId: A.companyId, reference: 'RIZ-25' }, include: { category: true } })
    assert.equal(riz.name, 'Riz; sac de 25 kg')
    assert.equal(Number(riz.unitCost), 12.5)
    assert.equal(riz.category?.name, 'Alimentaire')
    assert.equal(await prisma.productCategory.count({ where: { companyId: A.companyId, name: 'Alimentaire' } }), 1, 'catégorie créée une fois')

    const update = await send(A, 'products', 'reference;nom;prix_vente\nRIZ-25;Riz 25 kg;15\n')
    assert.equal(update.body.data.updated, 1)
    const after = await prisma.product.findFirstOrThrow({ where: { companyId: A.companyId, reference: 'RIZ-25' } })
    assert.equal(Number(after.salePrice), 15)
    assert.equal(Number(after.unitCost), 12.5, 'une colonne absente ne vide pas la valeur')
    assert.equal(await prisma.product.count({ where: { companyId: B.companyId, reference: 'RIZ-25' } }), 0, 'une autre entreprise n\'est pas touchée')
    assert.equal((await send(A, 'products', 'nom\nSans colonne référence\n')).status, 400)
  })

  it('clients avec leur point de livraison', async () => {
    const csv = 'nom;type;email;point_nom;point_adresse;point_ville;point_latitude;point_longitude\nKin Marché;entreprise;achats@kin.cd;Dépôt Limete;7 bd Lumumba;Kinshasa;-4,36;15,35\nJean;particulier;;;;;;\nErreur;robot;pas-un-mail;Site;;;;\n'
    const res = await send(A, 'customers', csv)
    assert.deepEqual(res.body.data.errors.map((e: { line: number }) => e.line), [4, 4, 4])
    assert.equal(await prisma.customer.count({ where: { companyId: A.companyId, name: 'Kin Marché' } }), 0)
    const ok = await send(A, 'customers', csv.split('\n').slice(0, 3).join('\n'))
    assert.equal(ok.body.data.created, 2)
    const kin = await prisma.customer.findFirstOrThrow({ where: { companyId: A.companyId, name: 'Kin Marché' }, include: { deliveryPoints: true } })
    assert.match(kin.code, /^CLI-/)
    assert.equal(kin.deliveryPoints[0].name, 'Dépôt Limete')
    assert.equal(Number(kin.deliveryPoints[0].latitude), -4.36)
  })

  it('stock initial : entrepôt par code ou nom, lots, mouvements tracés', async () => {
    const wh = await prisma.warehouse.findFirstOrThrow({ where: { id: A.wh.id } })
    const csv = `entrepot;reference;quantite;lot;expiration\n${wh.code};RIZ-25;100;;\n${wh.name};HUI-5;40;L-2026;31/12/2026\n${wh.code};HUI-5;5;;\nENT-INCONNU;RIZ-25;1;;\n${wh.code};INCONNUE;1;;\n`
    const check = await send(A, 'stock', csv, true)
    assert.deepEqual(check.body.data.errors.map((e: { line: number }) => e.line), [4, 5, 6], JSON.stringify(check.body.data.errors))
    const b = await prisma.warehouse.findFirstOrThrow({ where: { id: B.wh.id } })
    // Les codes sont numérotés par entreprise : « ENT-2026-000001 » existe chez A comme chez B. Le nom de B, lui, est inconnu de A.
    const foreign = await send(A, 'stock', `entrepot;reference;quantite\n${b.name};RIZ-25;5\n`)
    assert.equal(foreign.body.data.errors.length, 1, 'jamais l\'entrepôt d\'une autre entreprise')
    assert.equal(await prisma.stockBalance.count({ where: { warehouseId: b.id, product: { reference: 'RIZ-25' } } }), 0)
    const done = await send(A, 'stock', csv.split('\n').slice(0, 3).join('\n'))
    assert.equal(done.body.data.errors.length, 0)
    const movements = await prisma.stockMovement.findMany({ where: { companyId: A.companyId, note: 'Stock initial importé (CSV)' } })
    assert.equal(movements.length, 2)
    const oil = await prisma.stockBalance.findFirstOrThrow({ where: { companyId: A.companyId, product: { reference: 'HUI-5' } }, include: { batch: true } })
    assert.equal(Number(oil.onHand), 40)
    assert.equal(oil.batch?.batchNumber, 'L-2026')
    assert.equal((await A.driverClient.upload('/imports/stock', {}, { name: 'x.csv', type: 'text/csv', data: Buffer.from(csv) })).status, 403)
  })
})

describe('Stock à une date passée', () => {
  it('donne la quantité à la fin du jour choisi, dans le fuseau de l\'entreprise', async () => {
    const wh = A.wh.id
    const product = (await A.admin.post('/products', { name: 'Sucre', reference: 'SUC-1', baseUnit: 'sac' })).body.data
    await A.admin.post('/stocks/receipts', { warehouseId: wh, items: [{ productId: product.id, quantity: 100 }] })
    await A.admin.post('/stocks/issues', { warehouseId: wh, productId: product.id, quantity: 30, reason: 'LOSS' })
    const moves = await prisma.stockMovement.findMany({ where: { productId: product.id }, orderBy: { createdAt: 'asc' } })
    // Réception le 1er mars à 10 h, sortie le 10 mars à 23 h 30 heure de Kinshasa (22 h 30 UTC).
    await prisma.stockMovement.update({ where: { id: moves[0].id }, data: { createdAt: new Date('2026-03-01T09:00:00Z') } })
    await prisma.stockMovement.update({ where: { id: moves[1].id }, data: { createdAt: new Date('2026-03-10T22:30:00Z') } })
    const qty = async (day: string) => ((await A.admin.get(`/stocks/as-of?date=${day}&q=SUC-1`)).body.data.items as Array<{ quantity: number }>).map((i) => Number(i.quantity))
    assert.deepEqual(await qty('2026-02-28'), [], 'rien avant la réception')
    assert.deepEqual(await qty('2026-03-05'), [100])
    assert.deepEqual(await qty('2026-03-10'), [70], 'la sortie de 23 h 30 compte pour le 10 mars à Kinshasa')
    assert.deepEqual(await qty('2026-03-09'), [100])
    assert.equal((await A.admin.get('/stocks/as-of?date=hier')).status, 400)
    assert.deepEqual(((await B.admin.get('/stocks/as-of?date=2026-03-10&q=SUC-1')).body.data.items as unknown[]), [], 'jamais le stock d\'une autre entreprise')
  })
})
