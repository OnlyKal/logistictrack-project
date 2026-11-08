import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import type { INestApplication } from '@nestjs/common'
import type { PrismaClient } from '@prisma/client'
import { arrived, assignedDelivery, boot, Client, makeCompany, PNG, type Co } from './helpers.js'

let app: INestApplication
let cleanup: () => Promise<void>
let prisma: PrismaClient
let root: Client
let A: Co
let B: Co
let flush: () => Promise<void>
let outbound: { lastMessages: Map<string, string>; lastMails: Map<string, { html: string; attachments: number; subject: string }> }

before(async () => {
  ;({ app, cleanup } = await boot())
  const { PrismaService } = await import('../src/common/prisma.service.js')
  const { EmailsService } = await import('../src/common/emails.service.js')
  const { OutboundService } = await import('../src/common/core.services.js')
  prisma = app.get(PrismaService)
  const emails = app.get(EmailsService)
  flush = () => emails.flush()
  outbound = app.get(OutboundService) as unknown as typeof outbound
  const bcrypt = (await import('bcryptjs')).default
  await prisma.user.create({ data: { fullName: 'Root', email: 'root@test.local', passwordHash: await bcrypt.hash('Password123', 4), isSuperAdmin: true } })
  root = new Client(app)
  await root.login('root@test.local', 'Password123')
  A = await makeCompany(app, root, 'MLA')
  B = await makeCompany(app, root, 'MLB')
  await flush()
})
after(async () => cleanup())

/** E-mails journalisés, d'un type donné, éventuellement pour un destinataire. */
const logs = async (kind: string, recipient?: string) => {
  await flush()
  return prisma.emailLog.findMany({ where: { kind, ...(recipient ? { recipient } : {}) }, orderBy: { createdAt: 'asc' } })
}
const tokenIn = (text: string) => /token=([\w-]+)/.exec(text)?.[1]

describe('Comptes', () => {
  it("création d'entreprise sans mot de passe : l'administrateur est invité et choisit le sien", async () => {
    const res = await root.post('/companies', { tradeName: 'Invitée SA', email: 'contact@invitee.test', adminName: 'Awa Invitée', adminEmail: 'awa@invitee.test', adminPassword: '', monthlyAmount: 150 })
    assert.equal(res.status, 201, JSON.stringify(res.body))
    assert.deepEqual(res.body.data.invitation, { mode: 'invite', sent: true, error: null })
    const [invite] = await logs('account.invite', 'awa@invitee.test')
    assert.equal(invite.status, 'SENT')
    assert.equal(invite.companyId, res.body.data.id, "aux couleurs de l'entreprise")
    const text = outbound.lastMessages.get('awa@invitee.test')!
    assert.ok(text.includes('&bienvenue=1') && text.includes('7 jours') && text.includes('awa@invitee.test'), text)
    assert.ok(!text.includes('Password'), 'aucun mot de passe écrit')

    // Aucun mot de passe ne permet d'entrer avant l'invitation.
    assert.equal((await new Client(app).post('/auth/login', { identifier: 'awa@invitee.test', password: 'Password123' })).status, 401)
    assert.equal((await new Client(app).post('/auth/password/reset/confirm', { token: tokenIn(text), password: 'MonChoix2026' })).status, 200)
    const awa = new Client(app)
    assert.equal((await awa.post('/auth/login', { identifier: 'awa@invitee.test', password: 'MonChoix2026' })).status, 200)
    assert.equal((await logs('security.password_changed', 'awa@invitee.test')).length, 0, "accepter l'invitation n'est pas un changement suspect")
  })

  it('avec un mot de passe initial : simple message de bienvenue, sans le mot de passe', async () => {
    const res = await root.post('/companies', { tradeName: 'Directe SA', email: 'contact@directe.test', adminName: 'Jean Directe', adminEmail: 'jean@directe.test', adminPassword: 'Secret123456', monthlyAmount: 150 })
    assert.equal(res.body.data.invitation.mode, 'password')
    const [welcome] = await logs('account.welcome', 'jean@directe.test')
    assert.equal(welcome.status, 'SENT')
    assert.ok(!outbound.lastMessages.get('jean@directe.test')!.includes('Secret123456'), 'jamais le mot de passe')
  })

  it("sans compte d'envoi, l'invitation est refusée clairement : il faut un mot de passe", async () => {
    const saved = process.env.MAIL_TRANSPORT
    process.env.MAIL_TRANSPORT = ''
    try {
      const res = await root.post('/companies', { tradeName: 'Sans Mail', email: 'c@sansmail.test', adminName: 'Sans Mail', adminEmail: 'a@sansmail.test', monthlyAmount: 100 })
      assert.equal(res.status, 400)
      assert.match(res.body.message, /mot de passe initial/)
      assert.equal(await prisma.company.count({ where: { tradeName: 'Sans Mail' } }), 0)
    } finally {
      process.env.MAIL_TRANSPORT = saved
    }
  })

  it("un utilisateur invité par l'administrateur, invitation renouvelable tant qu'il ne s'est pas connecté", async () => {
    const res = await A.admin.post('/users', { fullName: 'Marie Stock', email: 'marie@mla.test', role: 'WAREHOUSE_MANAGER' })
    assert.equal(res.status, 201, JSON.stringify(res.body))
    assert.equal(res.body.data.invitation.sent, true)
    const text = outbound.lastMessages.get('marie@mla.test')!
    assert.ok(text.includes('Admin MLA vous a créé un accès') && text.includes('Entreprise MLA'), text)
    const again = await A.admin.post(`/users/${res.body.data.id}/invite`)
    assert.equal(again.status, 200)
    assert.equal((await logs('account.invite', 'marie@mla.test')).length, 2)
    assert.equal((await B.admin.post(`/users/${res.body.data.id}/invite`)).status, 404, "jamais l'utilisateur d'une autre entreprise")

    await new Client(app).post('/auth/password/reset/confirm', { token: tokenIn(outbound.lastMessages.get('marie@mla.test')!), password: 'Marie2026!!' })
    await new Client(app).post('/auth/login', { identifier: 'marie@mla.test', password: 'Marie2026!!' })
    assert.equal((await A.admin.post(`/users/${res.body.data.id}/invite`)).status, 409, 'déjà activé')
  })

  it("l'administrateur envoie un lien de réinitialisation, ou fixe un mot de passe : le titulaire est prévenu", async () => {
    const marie = (await prisma.user.findUniqueOrThrow({ where: { email: 'marie@mla.test' } })).id
    const link = await A.admin.post(`/users/${marie}/reset-password`, {})
    assert.equal(link.status, 200)
    assert.equal(link.body.data.mode, 'link')
    assert.ok(outbound.lastMessages.get('marie@mla.test')!.includes('24 heures'))
    assert.equal((await new Client(app).post('/auth/login', { identifier: 'marie@mla.test', password: 'Marie2026!!' })).status, 200, "l'ancien mot de passe reste valable")

    assert.equal((await A.admin.post(`/users/${marie}/reset-password`, { password: 'Imposé12345' })).status, 200)
    const [alert] = await logs('security.password_changed', 'marie@mla.test')
    assert.ok(alert && outbound.lastMessages.get('marie@mla.test')!.includes("par l'administrateur"))
  })

  it('alertes de sécurité : mot de passe changé, compte bloqué', async () => {
    const marie = new Client(app)
    await marie.login('marie@mla.test', 'Imposé12345')
    assert.equal((await marie.post('/auth/password/change', { current: 'Imposé12345', next: 'Marie-2027!' })).status, 200)
    assert.equal((await logs('security.password_changed', 'marie@mla.test')).length, 2)
    assert.ok(outbound.lastMessages.get('marie@mla.test')!.includes('depuis votre compte'))

    for (let i = 0; i < 6; i++) await new Client(app).post('/auth/login', { identifier: 'marie@mla.test', password: 'faux' })
    const [locked] = await logs('security.locked', 'marie@mla.test')
    assert.equal(locked.status, 'SENT')
    assert.ok(outbound.lastMessages.get('marie@mla.test')!.includes('15 minutes'))
    // Le lien « mot de passe oublié » part en arrière-plan, sans ralentir la réponse.
    assert.equal((await new Client(app).post('/auth/password/reset', { identifier: 'marie@mla.test' })).status, 200)
    assert.equal((await logs('account.reset', 'marie@mla.test')).length, 2, "le lien de l'administrateur, puis celui demandé")
  })
})

describe('Abonnement et facturation', () => {
  it("une demande d'abonnement envoie la facture à l'entreprise et prévient le Super Administrateur", async () => {
    const inv = (await A.admin.post('/subscriptions/renew', { durationMonths: 12 })).body.data
    const invoices = await logs('billing.invoice')
    assert.deepEqual(invoices.map((l) => l.recipient).sort(), ['admin-MLA@test.local', 'contact-MLA@test.local'].map((e) => e.toLowerCase()).sort(), 'administrateurs et adresse officielle')
    assert.ok(invoices[0].subject.includes(inv.number))
    const text = outbound.lastMessages.get('admin-mla@test.local')!
    assert.ok(text.includes('remise de 12 %') && text.includes('1 an'), text)
    const [platform] = await logs('platform.invoice', 'root@test.local')
    assert.ok(platform.subject.includes('Entreprise MLA'))
    // Redemander la même durée ne refait pas d'e-mail.
    await A.admin.post('/subscriptions/renew', { durationMonths: 12 })
    assert.equal((await logs('billing.invoice')).length, 2)
    assert.equal((await logs('billing.invoice', 'admin-mlb@test.local')).length, 0, "jamais chez une autre entreprise")
  })

  it('un paiement envoie un reçu, une seule fois', async () => {
    const inv = await prisma.subscriptionInvoice.findFirstOrThrow({ where: { companyId: A.companyId, status: 'UNPAID' } })
    assert.equal((await root.post('/admin/payments', { invoiceId: inv.id, externalRef: 'REC-1', amount: Number(inv.amount), currency: inv.currency })).status, 201)
    const receipts = await logs('billing.receipt')
    assert.equal(receipts.length, 2)
    assert.ok(outbound.lastMessages.get('admin-mla@test.local')!.includes('il vaut reçu'))
    await root.post('/admin/payments', { invoiceId: inv.id, externalRef: 'REC-1', amount: Number(inv.amount), currency: inv.currency })
    assert.equal((await logs('billing.receipt')).length, 2, 'paiement rejoué : pas de second reçu')
  })

  it("le Super Administrateur change le prix : la facture en attente remplacée est renvoyée", async () => {
    await B.admin.post('/subscriptions/renew', { durationMonths: 3 })
    await flush()
    const before = (await logs('billing.invoice', 'admin-mlb@test.local')).length
    await root.patch(`/companies/${B.companyId}/subscription`, { monthlyAmount: 120 })
    const after = await logs('billing.invoice', 'admin-mlb@test.local')
    assert.equal(after.length, before + 1)
    assert.ok(outbound.lastMessages.get('admin-mlb@test.local')!.includes('remplacée'))
  })

  it('rappels à J-7, J-3 et J-1, chacun une seule fois ; puis grâce et lecture seule', async () => {
    const { JobsService } = await import('../src/modules/saas/jobs.service.js')
    const jobs = app.get(JobsService)
    const sub = await prisma.subscription.findFirstOrThrow({ where: { companyId: B.companyId, isCurrent: true } })
    const day = 86400_000
    await prisma.subscription.update({ where: { id: sub.id }, data: { status: 'ACTIVE', endsAt: new Date(Date.now() + 6.5 * day) } })
    await jobs.subscriptions()
    await jobs.subscriptions()
    const j7 = await logs('billing.expiring', 'admin-mlb@test.local')
    assert.equal(j7.length, 1, 'la tâche horaire repasse sans renvoyer')
    assert.match(j7[0].subject, /dans 7 jours/)
    await prisma.subscription.update({ where: { id: sub.id }, data: { endsAt: new Date(Date.now() + 2.5 * day) } })
    await jobs.subscriptions()
    await prisma.subscription.update({ where: { id: sub.id }, data: { endsAt: new Date(Date.now() + 0.5 * day) } })
    await jobs.subscriptions()
    assert.deepEqual((await logs('billing.expiring', 'admin-mlb@test.local')).map((l) => /dans (\d) jours|demain/.exec(l.subject)?.[0]), ['dans 7 jours', 'dans 3 jours', 'demain'])

    await prisma.subscription.update({ where: { id: sub.id }, data: { endsAt: new Date(Date.now() - 1000) } })
    await jobs.subscriptions()
    const [grace] = await logs('billing.grace', 'admin-mlb@test.local')
    assert.ok(grace)
    await prisma.subscription.update({ where: { id: sub.id }, data: { graceEndsAt: new Date(Date.now() - 1000) } })
    await jobs.subscriptions()
    await jobs.subscriptions()
    assert.equal((await logs('billing.expired', 'admin-mlb@test.local')).length, 1)
    assert.ok(outbound.lastMessages.get('admin-mlb@test.local')!.includes('lecture seule'))
  })

  it("l'essai gratuit : un seul rappel, la veille", async () => {
    const { JobsService } = await import('../src/modules/saas/jobs.service.js')
    const jobs = app.get(JobsService)
    const company = (await prisma.company.findFirstOrThrow({ where: { tradeName: 'Directe SA' } })).id
    const sub = await prisma.subscription.findFirstOrThrow({ where: { companyId: company, isCurrent: true } })
    assert.equal(sub.status, 'TRIAL')
    await jobs.subscriptions()
    assert.equal((await logs('billing.trial_ending', 'jean@directe.test')).length, 0, '3 jours avant : rien')
    await prisma.subscription.update({ where: { id: sub.id }, data: { endsAt: new Date(Date.now() + 0.4 * 86400_000) } })
    await jobs.subscriptions()
    const [trial] = await logs('billing.trial_ending', 'jean@directe.test')
    assert.match(trial.subject, /essai gratuit se termine demain/)
  })
})

describe('Clients de l\'entreprise', () => {
  const signature = (co: Co, id: string) => co.driverClient.upload(`/deliveries/${id}/proofs`, { type: 'SIGNATURE' }, { name: 's.png', type: 'image/png', data: PNG })

  it("désactivés par défaut : aucun e-mail au client tant que l'entreprise ne les active pas", async () => {
    await A.admin.patch(`/customers/${A.customer.id}`, { email: 'achats@client-mla.test' })
    const { delivery } = await assignedDelivery(A, 5)
    await arrived(A, delivery.id)
    await signature(A, delivery.id)
    assert.equal((await A.driverClient.post(`/deliveries/${delivery.id}/confirm`, { recipientName: 'Paul' })).status, 200)
    await flush()
    assert.equal(await prisma.emailLog.count({ where: { recipient: 'achats@client-mla.test' } }), 0)
  })

  it('activés : en route (lien de suivi en direct), puis livrée avec le document signé joint', async () => {
    const saved = await A.admin.put('/companies/current/settings', { customerEmailEnRoute: true, customerEmailDelivered: true, customerEmailFailed: true })
    assert.equal(saved.status, 200)
    const { delivery } = await assignedDelivery(A, 5)
    await arrived(A, delivery.id)
    const [enRoute] = await logs('customer.en_route', 'achats@client-mla.test')
    assert.equal(enRoute.companyId, A.companyId)
    const text = outbound.lastMessages.get('achats@client-mla.test')!
    assert.match(text, /\/suivi-colis\/[\w-]+\?k=[0-9a-f]{40}/, 'lien signé vers la carte en direct')
    assert.ok(!text.includes('Chauffeur MLA') && !text.includes('V-MLA') && !text.includes('+2439'), 'ni nom, ni téléphone du chauffeur, ni immatriculation')

    await signature(A, delivery.id)
    await A.driverClient.post(`/deliveries/${delivery.id}/confirm`, { recipientName: 'Paul' })
    const [done] = await logs('customer.delivered', 'achats@client-mla.test')
    assert.equal(done.status, 'SENT')
    const mail = outbound.lastMails.get('achats@client-mla.test')!
    assert.equal(mail.attachments, 1, 'accusé de réception en PDF')
    assert.ok(mail.html.includes('Paul') && mail.html.includes('Entreprise MLA'))
    // Confirmation rejouée (hors ligne) : pas de second e-mail.
    await A.driverClient.post(`/deliveries/${delivery.id}/confirm`, { recipientName: 'Paul' })
    assert.equal((await logs('customer.delivered', 'achats@client-mla.test')).length, 1)
  })

  it("échec : motif expliqué ; rappel du chauffeur par le bureau : le client n'est pas prévenu", async () => {
    const first = await assignedDelivery(A, 5)
    await arrived(A, first.delivery.id)
    await A.driverClient.post(`/deliveries/${first.delivery.id}/fail`, { reason: 'CUSTOMER_ABSENT', comment: 'Portail fermé' })
    const [failed] = await logs('customer.failed', 'achats@client-mla.test')
    assert.ok(failed)
    assert.ok(outbound.lastMessages.get('achats@client-mla.test')!.includes('client absent') && outbound.lastMessages.get('achats@client-mla.test')!.includes('Portail fermé'))

    const second = await assignedDelivery(A, 5)
    await A.driverClient.post(`/deliveries/${second.delivery.id}/load`)
    await A.driverClient.post(`/deliveries/${second.delivery.id}/start`)
    assert.equal((await A.admin.post(`/deliveries/${second.delivery.id}/recall`, { reason: 'Erreur de stock' })).status, 200)
    assert.equal((await logs('customer.failed', 'achats@client-mla.test')).length, 1, 'rappel interne : aucun e-mail')
  })

  it('un client peut refuser ces e-mails', async () => {
    await A.admin.patch(`/customers/${A.customer.id}`, { emailNotifications: false })
    const before = await prisma.emailLog.count({ where: { recipient: 'achats@client-mla.test' } })
    const { delivery } = await assignedDelivery(A, 5)
    await arrived(A, delivery.id)
    await flush()
    assert.equal(await prisma.emailLog.count({ where: { recipient: 'achats@client-mla.test' } }), before)
    await A.admin.patch(`/customers/${A.customer.id}`, { emailNotifications: true })
  })

  it("journal : l'entreprise voit ses e-mails, jamais ceux des autres ; le Super Administrateur voit tout", async () => {
    const mine = (await A.admin.get('/emails/log?limit=100')).body.data as Array<{ companyId: string; recipient: string; dedupeKey?: string }>
    assert.ok(mine.length > 0 && mine.every((l) => l.companyId === A.companyId))
    assert.ok(mine.every((l) => !('dedupeKey' in l)))
    const theirs = (await B.admin.get('/emails/log?limit=100')).body.data as Array<{ recipient: string }>
    assert.ok(!theirs.some((l) => l.recipient === 'achats@client-mla.test'))
    assert.equal((await A.admin.get('/admin/mail/log')).status, 403)
    const all = (await root.get('/admin/mail/log?limit=100')).body.data as Array<{ company: string | null }>
    assert.ok(all.some((l) => l.company === 'Entreprise MLA') && all.some((l) => l.company === null))
  })
})
