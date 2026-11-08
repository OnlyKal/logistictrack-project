/**
 * Données initiales : compte Super Administrateur.
 * Le mode --demo ajoute une entreprise complète, pour le développement uniquement.
 */
import 'dotenv/config'
import { PrismaClient } from '@prisma/client'
import bcrypt from 'bcryptjs'
import { randomBytes } from 'node:crypto'

const prisma = new PrismaClient()

async function main() {
  const email = (process.env.SUPERADMIN_EMAIL ?? 'admin@logistictrack.local').toLowerCase()
  if (!(await prisma.user.findUnique({ where: { email } }))) {
    const password = process.env.SUPERADMIN_PASSWORD || randomBytes(12).toString('base64url')
    await prisma.user.create({ data: { fullName: 'Super Administrateur', email, passwordHash: await bcrypt.hash(password, 12), isSuperAdmin: true } })
    console.log(`Super Administrateur : ${email} / ${process.env.SUPERADMIN_PASSWORD ? '(mot de passe de SUPERADMIN_PASSWORD)' : password}`)
  }

  if (process.argv.includes('--demo')) {
    if (process.env.NODE_ENV === 'production') throw new Error('Le mode démo est interdit en production.')
    await demo()
  }
}

async function demo() {
  const demoEmail = 'contact@demo-logistique.local'
  if (await prisma.company.findUnique({ where: { email: demoEmail } })) {
    console.log('Entreprise de démonstration déjà présente.')
    return
  }
  const password = 'Demo1234!'
  const hash = await bcrypt.hash(password, 12)
  const company = await prisma.company.create({
    data: {
      tradeName: 'Démo Distribution', legalName: 'Démo Distribution SARL', email: demoEmail, phone: '+243 800 000 000', address: 'Boulevard du 30 Juin', city: 'Kinshasa', country: 'RD Congo', sector: 'Distribution', status: 'active',
      settings: { create: { requireSignature: true, requireRecipientName: true } },
    },
  })
  const companyId = company.id
  await prisma.subscription.create({ data: { companyId, monthlyAmount: 150, durationMonths: 12, status: 'ACTIVE', endsAt: new Date(Date.now() + 365 * 86400_000) } })

  const staff = async (fullName: string, mail: string, role: string) => {
    const user = await prisma.user.create({ data: { fullName, email: mail, passwordHash: hash } })
    await prisma.companyMembership.create({ data: { companyId, userId: user.id, role } })
    return user
  }
  await staff('Administrateur Démo', 'admin@demo-logistique.local', 'COMPANY_ADMIN')
  await staff('Responsable Logistique', 'logistique@demo-logistique.local', 'LOGISTICS_MANAGER')
  await staff('Responsable Entrepôt', 'entrepot@demo-logistique.local', 'WAREHOUSE_MANAGER')

  const main = await prisma.warehouse.create({ data: { companyId, name: 'Entrepôt Limete', code: 'LIM', type: 'GENERAL', address: 'Limete, Kinshasa', latitude: -4.3525, longitude: 15.3361, manager: 'Responsable Entrepôt' } })
  const second = await prisma.warehouse.create({ data: { companyId, name: 'Dépôt Gombe', code: 'GOM', type: 'FOOD', address: 'Gombe, Kinshasa', latitude: -4.3026, longitude: 15.3006 } })

  const food = await prisma.productCategory.create({ data: { companyId, name: 'Alimentaire' } })
  const materials = await prisma.productCategory.create({ data: { companyId, name: 'Matériaux' } })
  const oil = await prisma.product.create({ data: { companyId, categoryId: food.id, name: 'Huile alimentaire', reference: 'HUI-001', physicalNature: 'LIQUID', baseUnit: 'litre', unitWeightKg: 0.92, unitVolumeM3: 0.001, unitCost: 1.8, salePrice: 2.5, lowStockLevel: 200, trackBatches: true, packagings: { create: [{ companyId, name: 'Bidon 20 L', type: 'JERRYCAN', quantityPerUnit: 20 }, { companyId, name: 'Fût 200 L', type: 'DRUM', quantityPerUnit: 200 }] } } })
  const cement = await prisma.product.create({ data: { companyId, categoryId: materials.id, name: 'Ciment 50 kg', reference: 'CIM-050', physicalNature: 'POWDER', baseUnit: 'sac', unitWeightKg: 50, unitVolumeM3: 0.035, unitCost: 9, salePrice: 12, lowStockLevel: 50 } })
  const rice = await prisma.product.create({ data: { companyId, categoryId: food.id, name: 'Riz 25 kg', reference: 'RIZ-025', physicalNature: 'GRANULE', baseUnit: 'sac', unitWeightKg: 25, unitVolumeM3: 0.02, unitCost: 14, salePrice: 19, lowStockLevel: 40 } })

  const supplier = await prisma.supplier.create({ data: { companyId, name: 'Fournisseur Général', phone: '+243 810 000 000' } })
  const batch = await prisma.productBatch.create({ data: { companyId, productId: oil.id, supplierId: supplier.id, batchNumber: 'LOT-2026-01', expiresAt: new Date(Date.now() + 200 * 86400_000), quantityReceived: 2000 } })

  const seedStock = async (warehouseId: string, productId: string, quantity: number, batchId: string | null = null) => {
    await prisma.stockBalance.create({ data: { companyId, warehouseId, productId, batchId, onHand: quantity, balanceKey: [companyId, warehouseId, '-', productId, batchId ?? '-'].join('|') } })
    await prisma.stockMovement.create({ data: { companyId, direction: 'IN', reason: 'SUPPLIER', warehouseId, productId, batchId, quantity, quantityBefore: 0, quantityAfter: quantity, refType: 'Seed', note: 'Stock initial de démonstration' } })
  }
  await seedStock(main.id, oil.id, 2000, batch.id)
  await seedStock(main.id, cement.id, 500)
  await seedStock(main.id, rice.id, 300)
  await seedStock(second.id, rice.id, 120)
  await seedStock(second.id, cement.id, 100)

  const customer = await prisma.customer.create({ data: { companyId, code: 'CLI-0001', name: 'Supermarché Kin Marché', type: 'COMPANY', phone: '+243 820 000 000', email: 'achats@kinmarche.local' } })
  await prisma.deliveryPoint.createMany({
    data: [
      { companyId, customerId: customer.id, name: 'Magasin Gombe', address: 'Avenue de la Justice 12', commune: 'Gombe', city: 'Kinshasa', latitude: -4.3099, longitude: 15.2953, contactName: 'Réception Gombe', phone: '+243 820 000 001', openingHours: '08:00 - 17:00' },
      { companyId, customerId: customer.id, name: 'Dépôt Ngaliema', address: 'Avenue Pumbu 4', commune: 'Ngaliema', city: 'Kinshasa', latitude: -4.3489, longitude: 15.2452, contactName: 'Réception Ngaliema', phone: '+243 820 000 002' },
    ],
  })
  const driverUser = await prisma.user.create({ data: { fullName: 'Chauffeur Démo', phone: '+243990000001', email: 'chauffeur@demo-logistique.local', passwordHash: hash } })
  await prisma.companyMembership.create({ data: { companyId, userId: driverUser.id, role: 'DRIVER' } })
  await prisma.driver.create({ data: { companyId, userId: driverUser.id, code: 'CHF-0001', fullName: 'Chauffeur Démo', phone: '+243990000001', licenseNumber: 'KIN-123456', licenseClasses: 'B,C', licenseExpiry: new Date(Date.now() + 500 * 86400_000), warehouseId: main.id } })
  await prisma.vehicle.createMany({
    data: [
      { companyId, registration: 'KIN-458-AB', brand: 'Toyota', model: 'Dyna', type: 'TRUCK', weightCapacityKg: 5000, volumeCapacityM3: 25, insuranceExpiry: new Date(Date.now() + 200 * 86400_000), inspectionExpiry: new Date(Date.now() + 200 * 86400_000) },
      { companyId, registration: 'KIN-112-CD', brand: 'Hyundai', model: 'H100', type: 'VAN', weightCapacityKg: 1000, volumeCapacityM3: 6, insuranceExpiry: new Date(Date.now() + 200 * 86400_000), inspectionExpiry: new Date(Date.now() + 200 * 86400_000) },
    ],
  })
  console.log(`Démo : admin@demo-logistique.local, logistique@…, entrepot@…, chauffeur@demo-logistique.local / ${password}`)
}

main()
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
