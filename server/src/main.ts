import 'reflect-metadata'
import 'dotenv/config'
import { Logger } from '@nestjs/common'
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger'
import { createApp } from './bootstrap.js'

function assertProductionConfig() {
  if (process.env.NODE_ENV !== 'production') return
  const secrets = ['JWT_SECRET', 'FILE_URL_SECRET', 'PAYMENT_WEBHOOK_SECRET']
  for (const name of secrets) {
    const value = process.env[name]
    if (!value || value.length < 32 || value.startsWith('change-me')) {
      throw new Error(`${name} doit être défini en production avec au moins 32 caractères aléatoires.`)
    }
  }
  if (!process.env.DATABASE_URL?.startsWith('mysql://')) throw new Error('DATABASE_URL doit désigner MySQL en production.')
}

async function main() {
  assertProductionConfig()
  const app = await createApp()
  if (process.env.NODE_ENV !== 'production') {
    const document = SwaggerModule.createDocument(app, new DocumentBuilder().setTitle('LogisticTrack API').setVersion('1.0').addBearerAuth().build())
    SwaggerModule.setup('api/docs', app, document)
  }
  const port = Number(process.env.PORT ?? 3000)
  // En production derrière Nginx : HOST=127.0.0.1, le serveur n'est joignable que par le relais.
  await app.listen(port, process.env.HOST ?? '0.0.0.0')
  new Logger('Main').log(`Serveur à l'écoute sur http://localhost:${port}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
