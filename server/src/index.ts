import path from 'node:path'
import { loadConfig } from './config'
import { openDb, Store } from './db'
import { createApp } from './app'
import { FcmSender } from './fcm'

const config = loadConfig()
const db = openDb(path.join(__dirname, '..', 'nuntius.db'))
const store = new Store(db)
const fcm =
  config.fcmServiceAccount && config.fcmProjectId ? new FcmSender(config.fcmServiceAccount, config.fcmProjectId) : null
const app = createApp(config, store, fcm)

// Loopback only: during development the Seeker reaches this through `adb reverse`,
// and in production nginx terminates in front. Nothing here belongs on the LAN.
app.listen(config.port, '127.0.0.1', () => {
  console.log(
    `nuntius server on 127.0.0.1:${config.port} · domain ${config.domain} · helius ${config.heliusRpc ? 'configured' : 'NOT configured'} · fcm ${fcm ? 'configured' : 'NOT configured'}`,
  )
})
