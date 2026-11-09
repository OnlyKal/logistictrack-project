import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import type { INestApplication } from '@nestjs/common'
import type { PrismaClient } from '@prisma/client'
import { assignedDelivery, arrived, boot, Client, makeCompany, PNG, type Co } from './helpers.js'

let app: INestApplication
let cleanup: () => Promise<void>
let prisma: PrismaClient
let root: Client
let A: Co

before(async () => {
  ;({ app, cleanup } = await boot())
  const { PrismaService } = await import('../src/common/prisma.service.js')
  prisma = app.get(PrismaService)
  const bcrypt = (await import('bcryptjs')).default
  await prisma.user.create({ data: { fullName: 'Root', email: 'root@test.local', passwordHash: await bcrypt.hash('Password123', 4), isSuperAdmin: true } })
  root = new Client(app)
  await root.login('root@test.local', 'Password123')
  A = await makeCompany(app, root, 'SEC')
})
after(async () => cleanup())

const login = (identifier: string, password: string) => new Client(app).post('/auth/login', { identifier, password })

describe('Blocage du compte après 6 mots de passe faux', () => {
  it('bloque le compte, quel que soit l\'appareil, puis le libère', async () => {
    await A.admin.post('/users', { fullName: 'Chef Bloqué', email: 'bloque@test.local', password: 'Password123', role: 'WAREHOUSE_AGENT' })
    for (let i = 0; i < 5; i++) assert.equal((await login('bloque@test.local', 'faux')).status, 401)
    assert.equal((await login('bloque@test.local', 'Password123')).status, 200, '5 erreurs : pas encore bloqué, et le compteur repart')
    for (let i = 0; i < 6; i++) assert.equal((await login('bloque@test.local', 'faux')).status, 401)
    const locked = await login('bloque@test.local', 'Password123')
    assert.equal(locked.status, 403, 'même le bon mot de passe est refusé')
    assert.equal(locked.body.code, 'ACCOUNT_LOCKED')
    assert.match(locked.body.message, /6 mots de passe incorrects/)
    // Fin du blocage.
    await prisma.user.update({ where: { email: 'bloque@test.local' }, data: { lockedUntil: new Date(Date.now() - 1000) } })
    assert.equal((await login('bloque@test.local', 'Password123')).status, 200)
    // Un administrateur débloque en réinitialisant le mot de passe.
    for (let i = 0; i < 6; i++) await login('bloque@test.local', 'faux')
    const user = await prisma.user.findUniqueOrThrow({ where: { email: 'bloque@test.local' } })
    assert.equal((await A.admin.post(`/users/${user.id}/reset-password`, { password: 'Nouveau12345' })).status, 200)
    assert.equal((await login('bloque@test.local', 'Nouveau12345')).status, 200)
    const logs = (await A.admin.get('/audit-logs?limit=200')).body.data as Array<{ action: string }>
    assert.ok(logs.some((l) => l.action === 'auth.locked') || (await prisma.auditLog.count({ where: { action: 'auth.locked', userId: user.id } })) > 0)
  })
})

describe('Administrateur secondaire', () => {
  it('ne nomme jamais un administrateur principal et ne donne pas plus de droits qu\'il n\'en a', async () => {
    await A.admin.post('/users', { fullName: 'Second', email: 'second@test.local', password: 'Password123', role: 'SECONDARY_ADMIN', customPermissions: ['user.manage', 'product.view', 'warehouse.view'] })
    const s = new Client(app)
    await s.login('second@test.local', 'Password123')
    const me = (await s.get('/auth/me')).body.data
    const admin = (await A.admin.get('/auth/me')).body.data
    const create = (role: string, extra = {}) => s.post('/users', { fullName: 'Xavier', email: `x-${Math.random()}@test.local`, password: 'Password123', role, ...extra })
    assert.equal((await create('COMPANY_ADMIN')).status, 403, 'pas d\'administrateur principal')
    assert.equal((await create('LOGISTICS_MANAGER')).status, 403, 'pas de droits qu\'il n\'a pas')
    assert.equal((await create('SECONDARY_ADMIN', { customPermissions: ['billing.manage'] })).status, 403)
    assert.equal((await create('SECONDARY_ADMIN', { customPermissions: ['product.view'] })).status, 201, 'droits qu\'il possède : autorisé')
    assert.equal((await s.post(`/users/${me.id}/assign-role`, { role: 'SECONDARY_ADMIN', customPermissions: ['user.manage', 'billing.manage'] })).status, 403, 'pas ses propres droits')
    assert.equal((await s.post(`/users/${admin.id}/assign-role`, { role: 'WAREHOUSE_AGENT' })).status, 403, 'ne rétrograde pas l\'administrateur principal')
    assert.equal((await s.post(`/users/${admin.id}/reset-password`, { password: 'Pirate12345' })).status, 403)
    assert.equal((await s.post(`/users/${admin.id}/deactivate`)).status, 403)
    assert.equal((await s.patch(`/users/${admin.id}`, { fullName: 'Pirate' })).status, 403)
    // L'administrateur principal, lui, peut tout.
    const promoted = await A.admin.post('/users', { fullName: 'Second principal', email: 'principal2@test.local', password: 'Password123', role: 'COMPANY_ADMIN' })
    assert.equal(promoted.status, 201)
  })
})

describe('Contenu réel des fichiers', () => {
  it('refuse un faux fichier, et enregistre le vrai type', async () => {
    const { delivery } = await assignedDelivery(A, 1)
    await arrived(A, delivery.id)
    const fake = await A.driverClient.upload(`/deliveries/${delivery.id}/proofs`, { type: 'PHOTO_GOODS' }, { name: 'photo.png', type: 'image/png', data: Buffer.from('<script>alert(1)</script>') })
    assert.equal(fake.status, 415)
    const pdf = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF')
    const renamed = await A.driverClient.upload(`/deliveries/${delivery.id}/proofs`, { type: 'PHOTO_GOODS' }, { name: 'photo.png', type: 'image/png', data: pdf })
    assert.equal(renamed.status, 201, JSON.stringify(renamed.body))
    const file = await prisma.uploadedFile.findUniqueOrThrow({ where: { id: renamed.body.data.fileId } })
    assert.equal(file.mimeType, 'application/pdf', 'le type déclaré par le navigateur est ignoré')
    assert.equal((await A.driverClient.upload(`/deliveries/${delivery.id}/proofs`, { type: 'SIGNATURE' }, { name: 's.png', type: 'image/png', data: PNG })).status, 201)
  })
})

describe('E-mails', () => {
  it('mot de passe oublié : lien reçu par e-mail, nouveau mot de passe, compte débloqué', async () => {
    const { OutboundService } = await import('../src/common/core.services.js')
    const outbound = app.get(OutboundService)
    for (let i = 0; i < 6; i++) await login('admin-sec@test.local', 'faux')
    assert.equal((await new Client(app).post('/auth/password/reset', { identifier: 'admin-sec@test.local' })).status, 200)
    await app.get((await import('../src/common/emails.service.js')).EmailsService).flush()
    const mail = outbound.lastMessages.get('admin-sec@test.local') ?? ''
    const token = /mot-de-passe-oublie\?token=([\w-]+)/.exec(mail)?.[1]
    assert.ok(mail.startsWith('Bonjour') && mail.includes('https://app.test/mot-de-passe-oublie?token='), mail)
    assert.ok(token)
    assert.equal((await new Client(app).post('/auth/password/reset', { identifier: 'inconnu@test.local' })).status, 200, 'même réponse pour un compte inconnu')
    assert.equal((await new Client(app).post('/auth/password/reset/confirm', { token, password: 'Nouveau12345' })).status, 200)
    assert.equal((await login('admin-sec@test.local', 'Nouveau12345')).status, 200, 'débloqué')
    assert.equal((await new Client(app).post('/auth/password/reset/confirm', { token, password: 'Autre123456' })).status, 400, 'lien à usage unique')
    A.admin = new Client(app)
    await A.admin.login('admin-sec@test.local', 'Nouveau12345')
  })

  it('le Super Administrateur vérifie la configuration et envoie un e-mail de test', async () => {
    const status = (await root.get('/admin/mail')).body.data
    assert.equal(status.configured, true)
    const sent = await root.post('/admin/mail/test')
    assert.equal(sent.status, 200, JSON.stringify(sent.body))
    assert.equal(sent.body.data.sentTo, 'root@test.local')
    assert.equal((await A.admin.post('/admin/mail/test')).status, 403)
  })

  it("un même design, aux couleurs de l'entreprise concernée", async () => {
    const { OutboundService } = await import('../src/common/core.services.js')
    const outbound = app.get(OutboundService)
    await A.admin.patch('/companies/current', { tradeName: 'Bralima Test', phone: '+243 81 000 0000', email: 'contact@bralima.test', taxId: 'A1234567', rccm: 'CD/KIN/RCCM/24-B-001' })
    // Employé de l'entreprise : l'e-mail porte son nom, ses coordonnées, et les réponses lui parviennent.
    await new Client(app).post('/auth/password/reset', { identifier: 'admin-sec@test.local' })
    await app.get((await import('../src/common/emails.service.js')).EmailsService).flush()
    const mail = outbound.lastMails.get('admin-sec@test.local')!
    assert.ok(mail.html.includes('Bralima Test') && mail.html.includes('+243 81 000 0000') && mail.html.includes('NIF A1234567') && mail.html.includes('RCCM CD/KIN/RCCM/24-B-001'), 'coordonnées de l\'entreprise')
    assert.deepEqual(mail.from, { name: 'Bralima Test via LogisticTrack', address: 'test@logistictrack.local' }, 'adresse du compte d\'envoi, nom de l\'entreprise')
    assert.equal(mail.replyTo, 'contact@bralima.test')
    assert.equal(mail.attachments, 0, 'sans logo : initiale')
    assert.ok(outbound.lastMessages.get('admin-sec@test.local')!.includes('Bralima Test'), 'version texte signée aussi')

    // Avec le logo : joint au message et affiché en tête (cid), jamais en data: bloqué par Gmail.
    await A.admin.upload('/companies/current/logo', {}, { name: 'logo.png', type: 'image/png', data: PNG })
    await new Client(app).post('/auth/password/reset', { identifier: 'admin-sec@test.local' })
    await app.get((await import('../src/common/emails.service.js')).EmailsService).flush()
    const withLogo = outbound.lastMails.get('admin-sec@test.local')!
    assert.equal(withLogo.attachments, 1)
    assert.ok(withLogo.html.includes('src="cid:logo@logistictrack"'))

    // Super Administrateur : signé LogisticTrack. Aperçu possible aux couleurs d'une entreprise.
    await root.post('/admin/mail/test')
    const platform = outbound.lastMails.get('root@test.local')!
    assert.ok(platform.html.includes('LogisticTrack') && !platform.html.includes('Bralima Test'))
    assert.equal(platform.attachments, 1, 'e-mail de la plateforme : logo LT joint')
    assert.ok(platform.html.includes('src="cid:logo@logistictrack"'))
    assert.equal((await root.post('/admin/mail/test', { companyId: A.companyId })).status, 200)
    assert.ok(outbound.lastMails.get('root@test.local')!.html.includes('Bralima Test'))
    assert.equal((await root.post('/admin/mail/test', { companyId: 'inconnue' })).status, 404)
  })
})

describe("Compte d'envoi des e-mails réglé dans l'administration", () => {
  const SECRET = 'mot-de-passe-application-tres-secret'
  const settings = { host: 'smtp.exemple.test', port: 587, secure: false, user: 'envoi@exemple.test', from: 'LogisticTrack <envoi@exemple.test>' }

  it('réservé au Super Administrateur', async () => {
    assert.equal((await A.admin.put('/admin/mail', { ...settings, password: SECRET })).status, 403)
    assert.equal((await A.admin.get('/admin/mail')).status, 403)
  })

  it('exige un mot de passe au premier enregistrement', async () => {
    const res = await root.put('/admin/mail', settings)
    assert.equal(res.status, 400, JSON.stringify(res.body))
  })

  it('chiffre le mot de passe, ne le renvoie jamais et le conserve si le champ reste vide', async () => {
    const saved = await root.put('/admin/mail', { ...settings, password: SECRET })
    assert.equal(saved.status, 200, JSON.stringify(saved.body))
    assert.ok(!JSON.stringify(saved.body).includes(SECRET))
    const status = (await root.get('/admin/mail')).body.data
    assert.equal(status.source, 'admin')
    assert.equal(status.user, 'envoi@exemple.test')
    assert.equal(status.port, 587)
    assert.equal(status.hasPassword, true)
    assert.ok(!JSON.stringify(status).includes(SECRET), 'jamais renvoyé')

    const row = await prisma.mailSettings.findUniqueOrThrow({ where: { id: 'default' } })
    assert.ok(row.passwordEnc.startsWith('v1.') && !row.passwordEnc.includes(SECRET), 'chiffré en base')
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'platform.mail_settings' }, orderBy: { createdAt: 'desc' } })
    assert.ok(!(audit.details ?? '').includes(SECRET), 'absent du journal')

    // Modification sans mot de passe : l'ancien est conservé.
    assert.equal((await root.put('/admin/mail', { ...settings, port: 465, secure: true, password: '' })).status, 200)
    const kept = await prisma.mailSettings.findUniqueOrThrow({ where: { id: 'default' } })
    assert.equal(kept.passwordEnc, row.passwordEnc)
    assert.equal(kept.port, 465)
    assert.equal((await root.post('/admin/mail/test')).status, 200)
  })

  it('un mot de passe illisible (JWT_SECRET changé) est signalé et doit être ressaisi', async () => {
    const { OutboundService } = await import('../src/common/core.services.js')
    await prisma.mailSettings.update({ where: { id: 'default' }, data: { passwordEnc: 'v1.abc.def.ghi' } })
    ;(app.get(OutboundService) as unknown as { reset(): void }).reset()
    assert.equal((await root.get('/admin/mail')).body.data.passwordUnreadable, true)
    assert.equal((await root.put('/admin/mail', settings)).status, 400, 'pas de conservation possible')
    assert.equal((await root.put('/admin/mail', { ...settings, password: SECRET })).status, 200)
    assert.equal((await root.get('/admin/mail')).body.data.passwordUnreadable, false)
  })

  it('la suppression revient aux réglages du fichier .env', async () => {
    const cleared = await root.delete('/admin/mail')
    assert.equal(cleared.status, 200, JSON.stringify(cleared.body))
    assert.equal(await prisma.mailSettings.count(), 0)
    assert.notEqual((await root.get('/admin/mail')).body.data.source, 'admin')
  })
})

describe('Sauvegardes', () => {
  it('copie la base et les fichiers, restaurables, en double exemplaire', async () => {
    const { existsSync, readFileSync, readdirSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { PrismaClient } = await import('@prisma/client')
    assert.equal((await A.admin.post('/admin/backups')).status, 403, 'réservé au Super Administrateur')
    const res = await root.post('/admin/backups')
    assert.equal(res.status, 200, JSON.stringify(res.body))
    const info = res.body.data
    assert.ok(info.files >= 1, 'les preuves sont copiées')
    const folder = join(process.env.BACKUP_DIR!, info.name)
    const db = join(folder, info.databaseFile)
    assert.equal(readFileSync(db).subarray(0, 15).toString(), 'SQLite format 3')
    assert.ok(existsSync(join(info.copiedTo, info.databaseFile)), 'seconde copie')
    const stored = readdirSync(join(folder, 'storage'), { recursive: true }).length
    assert.ok(stored >= info.files)
    // La copie s'ouvre et contient les données.
    const restored = new PrismaClient({ datasourceUrl: `file:${db}` })
    try {
      assert.ok((await restored.company.count()) >= 1)
      assert.ok((await restored.proofOfDelivery.count()) >= 1)
    } finally {
      await restored.$disconnect()
    }
    const list = (await root.get('/admin/backups')).body.data
    assert.equal(list.items[0].name, info.name)
    assert.equal(list.keepDays, 14)
  })
})

describe('Messages d\'erreur d\'envoi', () => {
  it('traduit les refus SMTP courants en consignes claires', async () => {
    const { smtpErrorMessage } = await import('../src/common/core.services.js')
    const auth = Object.assign(new Error('Invalid login: 535-5.7.8 Username and Password not accepted'), { code: 'EAUTH', responseCode: 535 })
    assert.match(smtpErrorMessage(auth), /mot de passe d'application/)
    assert.match(smtpErrorMessage(Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' })), /Impossible de joindre/)
    assert.match(smtpErrorMessage(new Error('bizarre')), /bizarre/)
  })
})

describe('Le Super Administrateur redonne l\'accès à un compte', () => {
  it('sans condition : administrateur principal bloqué, entreprise suspendue ; jamais par une entreprise', async () => {
    const S = await makeCompany(app, root, 'SAPWD')
    const admin = await prisma.user.findUniqueOrThrow({ where: { email: 'admin-sapwd@test.local' } })
    for (let i = 0; i < 6; i++) await login('admin-SAPWD@test.local', 'oublié')
    assert.equal((await login('admin-SAPWD@test.local', 'Password123')).status, 403, 'compte bloqué')
    await root.post(`/companies/${S.companyId}/suspend`, {})

    const accounts = (await root.get(`/companies/${S.companyId}/accounts`)).body.data as Array<{ id: string; role: string; lockedUntil: string | null }>
    assert.equal(accounts[0].role, 'COMPANY_ADMIN', 'les administrateurs en premier')
    assert.ok(accounts.find((a) => a.id === admin.id)?.lockedUntil, 'blocage visible')

    const res = await root.post(`/companies/${S.companyId}/accounts/${admin.id}/password`, { password: 'NouveauClient2026' })
    assert.equal(res.status, 200, JSON.stringify(res.body))
    await root.post(`/companies/${S.companyId}/activate`, {})
    assert.equal((await login('admin-SAPWD@test.local', 'NouveauClient2026')).status, 200, 'débloqué, nouveau mot de passe actif')
    assert.equal((await S.admin.get('/warehouses')).status, 401, 'anciennes sessions fermées')
    const audit = await prisma.auditLog.findFirst({ where: { companyId: S.companyId, action: 'admin.reset_password', entityId: admin.id } })
    assert.ok(audit, 'inscrit au journal de l\'entreprise')

    // Ni une entreprise, ni pour le compte d'une autre entreprise.
    assert.equal((await A.admin.post(`/companies/${S.companyId}/accounts/${admin.id}/password`, { password: 'Pirate123456' })).status, 403)
    assert.equal((await A.admin.get(`/companies/${S.companyId}/accounts`)).status, 403)
    const other = await prisma.companyMembership.findFirstOrThrow({ where: { companyId: A.companyId } })
    assert.equal((await root.post(`/companies/${S.companyId}/accounts/${other.userId}/password`, { password: 'Autre1234567' })).status, 404)
    assert.equal((await root.post(`/companies/${S.companyId}/accounts/${admin.id}/password`, { password: 'court' })).status, 422, 'mot de passe trop court')
  })

  it("sans e-mail configuré : l'envoi d'un lien est refusé clairement, le mot de passe direct reste possible", async () => {
    const S = await prisma.company.findFirstOrThrow({ where: { tradeName: 'Entreprise SAPWD' } })
    const admin = await prisma.user.findUniqueOrThrow({ where: { email: 'admin-sapwd@test.local' } })
    const saved = process.env.MAIL_TRANSPORT
    process.env.MAIL_TRANSPORT = ''
    const settings = await prisma.mailSettings.findUnique({ where: { id: 'default' } })
    if (settings) await prisma.mailSettings.delete({ where: { id: 'default' } })
    ;(app.get((await import('../src/common/core.services.js')).OutboundService) as unknown as { reset(): void }).reset()
    try {
      const link = await root.post(`/companies/${S.id}/accounts/${admin.id}/password`, {})
      assert.equal(link.status, 502)
      assert.match(link.body.message, /Saisissez plutôt un nouveau mot de passe/)
      assert.equal((await root.post(`/companies/${S.id}/accounts/${admin.id}/password`, { password: 'SansEmail2026' })).status, 200)
    } finally {
      process.env.MAIL_TRANSPORT = saved
      if (settings) await prisma.mailSettings.create({ data: settings })
      ;(app.get((await import('../src/common/core.services.js')).OutboundService) as unknown as { reset(): void }).reset()
    }
  })
})
