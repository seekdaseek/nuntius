// The web backing page (/l/<pool>) clicked through in a real headless browser, against the real
// server and executor on a local validator running Meteora's programs cloned from mainnet
// (scripts/backing-page-e2e.sh). The wallet is a Wallet Standard test wallet injected into the
// page; its keys stay in this Node process and sign there. No curl: CSP, fetch and the wallet
// protocol all run as they do for a person.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright-core'
import Database from 'better-sqlite3'
import { Keypair, LAMPORTS_PER_SOL, sendAndConfirmTransaction } from '@solana/web3.js'
import * as DBC from '@meteora-ag/dynamic-bonding-curve-sdk'
import { createMint, getOrCreateAssociatedTokenAccount, mintTo } from '@solana/spl-token'
import {
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  getBase64Encoder,
  getBase64EncodedWireTransaction,
  getTransactionDecoder,
  signBytes,
  signTransaction,
  getSignatureFromTransaction,
  getAddressEncoder,
} from '@solana/kit'
import { createSignInMessageText } from '@solana/wallet-standard-util'
import { createApp } from '../dist/app.js'
import { openDb, Store } from '../dist/db.js'
import { MandateStore } from '../dist/mandate-store.js'
import { Receipts } from '../dist/receipts.js'
import { createLogger } from '../dist/log.js'
import { Executor, rpcChain } from '../dist/executor.js'
import { readRecurring } from '../dist/mandate-chain.js'
import {
  configInstructions,
  launchInstructions,
  launchPreset,
  meteoraConnection,
  dbcPoolAddress,
} from '../dist/meteora.js'
import { PULL_BUDGET, signAndSend } from '../dist/tx.js'

const RPC = process.env.LOCALNET_RPC ?? ''
const skip = !RPC || process.env.LOCALNET_METEORA !== '1' ? 'run scripts/backing-page-e2e.sh' : false
const CHROME = process.env.CHROMIUM_PATH
const SHOTS = process.env.SHOTS_DIR ?? ''

async function setup() {
  const rpc = createSolanaRpc(RPC)
  const conn = meteoraConnection(RPC)
  const air = async (k) =>
    conn.confirmTransaction(await conn.requestAirdrop(k.publicKey, 20 * LAMPORTS_PER_SOL), 'confirmed')
  const [partner, creatorKp, executorKp, backerKp] = [
    Keypair.generate(),
    Keypair.generate(),
    Keypair.generate(),
    Keypair.generate(),
  ]
  for (const k of [partner, creatorKp, executorKp, backerKp]) await air(k)
  const quoteMint = await createMint(conn, partner, partner.publicKey, null, 6)
  const backerQuote = await getOrCreateAssociatedTokenAccount(conn, partner, quoteMint, backerKp.publicKey)
  await mintTo(conn, partner, quoteMint, backerQuote.address, partner, 1_000_000_000n)
  await getOrCreateAssociatedTokenAccount(conn, partner, quoteMint, executorKp.publicKey)

  // A config and a pool, composed by the server's own code (as tools/launch-config.ts and /api/launch/create do).
  const sign = async (payerKp, ixs, extra) => {
    const signers = new Map()
    for (const kp of [payerKp, ...extra]) {
      const s = await createKeyPairSignerFromBytes(kp.secretKey)
      signers.set(s.address, s)
    }
    const payer = signers.get(payerKp.publicKey.toBase58())
    const withSigners = ixs.map((ix) => ({
      ...ix,
      accounts: ix.accounts?.map((a) => (signers.has(a.address) ? { ...a, signer: signers.get(a.address) } : a)),
    }))
    const landed = await signAndSend(rpc, payer, withSigners)
    assert.equal(landed.err, null)
  }
  const configKp = Keypair.generate()
  await sign(
    partner,
    await configInstructions(conn, {
      config: configKp.publicKey.toBase58(),
      feeClaimer: partner.publicKey.toBase58(),
      leftoverReceiver: partner.publicKey.toBase58(),
      quoteMint: quoteMint.toBase58(),
      payer: partner.publicKey.toBase58(),
      quoteThreshold: 1_000,
    }),
    [configKp],
  )
  const baseKp = Keypair.generate()
  await sign(
    creatorKp,
    await launchInstructions(conn, {
      creator: creatorKp.publicKey.toBase58(),
      config: configKp.publicKey.toBase58(),
      name: 'web test',
      symbol: 'WEBT',
      uri: `https://nuntius.test/m/${baseKp.publicKey.toBase58()}.json`,
      baseMint: baseKp.publicKey.toBase58(),
    }),
    [baseKp],
  )
  const pool = dbcPoolAddress(quoteMint.toBase58(), baseKp.publicKey.toBase58(), configKp.publicKey.toBase58())

  // A second pool whose metadata the creator can still change: what an outside launchpad may
  // hand a backer. Built with the SDK, on the deployed program. (A pool that keeps a mint
  // authority cannot be built this way: the SDK allows that only for transfer-hook configs,
  // which nuntius refuses.)
  const client = new DBC.DynamicBondingCurveClient(conn, 'confirmed')
  const openCfg = Keypair.generate()
  const cfgTx = await client.partner.createConfig({
    ...launchPreset(1_000),
    tokenUpdateAuthority: DBC.TokenAuthorityOption.CreatorUpdateAuthority,
    config: openCfg.publicKey,
    feeClaimer: partner.publicKey,
    leftoverReceiver: partner.publicKey,
    quoteMint,
    payer: partner.publicKey,
  })
  await sendAndConfirmTransaction(conn, cfgTx, [partner, openCfg], { commitment: 'confirmed' })
  const openBase = Keypair.generate()
  const openPoolTx = await client.creator.createPool({
    config: openCfg.publicKey,
    baseMint: openBase.publicKey,
    name: 'still mutable',
    symbol: 'OPEN',
    uri: 'https://nuntius.test/t/proof.json',
    payer: creatorKp.publicKey,
    poolCreator: creatorKp.publicKey,
  })
  await sendAndConfirmTransaction(conn, openPoolTx, [creatorKp, openBase], { commitment: 'confirmed' })
  const openPool = dbcPoolAddress(quoteMint.toBase58(), openBase.publicKey.toBase58(), openCfg.publicKey.toBase58())

  // The real server, on this validator, with launches on.
  const executor = await createKeyPairSignerFromBytes(executorKp.secretKey)
  const db = openDb(':memory:')
  const mandates = new MandateStore(new Database(':memory:'))
  // The launch as nuntius records it: its metadata JSON (the URI above) names the nimus logo.
  mandates.addLaunch(
    {
      baseMint: baseKp.publicKey.toBase58(),
      pool,
      config: configKp.publicKey.toBase58(),
      creator: creatorKp.publicKey.toBase58(),
      name: 'web test',
      symbol: 'WEBT',
      image: 'https://nuntius.test/t/nimus.png',
      quoteMint: quoteMint.toBase58(),
      description: null,
    },
    Date.now(),
  )
  const log = createLogger(() => {})
  const receipts = new Receipts(mandates, null, log, 'localnet')
  const ex = new Executor({ store: mandates, chain: rpcChain(rpc, executor, PULL_BUDGET, conn), receipts, log })
  const app = createApp(
    { port: 0, domain: 'nuntius.test', heliusRpc: null, fcmServiceAccount: null, fcmProjectId: null },
    new Store(db),
    null,
    {
      mandates,
      cfg: {
        cluster: 'localnet',
        rpcUrl: RPC,
        mints: [{ symbol: 'TQ', mint: quoteMint.toBase58(), decimals: 6, maxPerPeriodUi: '50' }],
        maxPerPeriodUi: '50',
        delegateePath: null,
        executorIntervalMs: 60_000,
        guardIntervalMs: 60_000,
        demoEndpoints: false,
        launches: true,
        launchConfigs: {},
      },
      rpc,
      delegatee: executor.address,
      receipts,
      executor: ex,
      conn,
      origin: 'https://nuntius.test',
    },
    { staticDir: path.join(import.meta.dirname, '..', 'static') },
  )
  const server = app.listen(0, '127.0.0.1')
  await new Promise((r) => server.once('listening', r))
  const base = `http://127.0.0.1:${server.address().port}`
  const backer = await createKeyPairSignerFromBytes(backerKp.secretKey)
  return { rpc, pool, base, server, backer, executor, openPool, baseMint: baseKp.publicKey.toBase58() }
}

/** A Wallet Standard wallet in the page; every signature is made in Node with the backer's key. */
function walletInitScript(address, publicKey) {
  return `(() => {
    const b64 = { to: (u) => btoa(String.fromCharCode(...u)), from: (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0)) }
    const account = { address: ${JSON.stringify(address)}, publicKey: new Uint8Array(${JSON.stringify(Array.from(publicKey))}),
      chains: ['solana:localnet', 'solana:mainnet'], features: ['solana:signIn', 'solana:signAndSendTransaction'] }
    const wallet = {
      version: '1.0.0', name: 'nuntius test wallet', chains: ['solana:localnet', 'solana:mainnet'], accounts: [account],
      icon: 'data:image/svg+xml;base64,' + btoa('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8" fill="#4F3BF6"/></svg>'),
      features: {
        'standard:connect': { version: '1.0.0', connect: async () => ({ accounts: [account] }) },
        'standard:events': { version: '1.0.0', on: () => () => {} },
        'solana:signIn': { version: '1.0.0', signIn: async (...inputs) => Promise.all(inputs.map(async (input) => {
          const r = await window.__walletSignIn(JSON.stringify(input))
          return { account, signedMessage: b64.from(r.signedMessage), signature: b64.from(r.signature), signatureType: 'ed25519' }
        })) },
        'solana:signAndSendTransaction': { version: '1.0.0', supportedTransactionVersions: ['legacy', 0],
          signAndSendTransaction: async (...inputs) => Promise.all(inputs.map(async (i) => {
            window.__walletCalls = (window.__walletCalls ?? 0) + 1
            return { signature: b64.from(await window.__walletSignAndSend(b64.to(i.transaction))) }
          })) },
      },
    }
    const callback = ({ register }) => register(wallet)
    try { window.dispatchEvent(new CustomEvent('wallet-standard:register-wallet', { detail: callback })) } catch {}
    try { window.addEventListener('wallet-standard:app-ready', ({ detail }) => callback(detail)) } catch {}
  })()`
}

async function openPage(env, tamper) {
  const browser = await chromium.launch(CHROME ? { executablePath: CHROME } : {})
  const page = await browser.newPage({ viewport: { width: 420, height: 900 } })
  const problems = []
  page.on(
    'console',
    (m) => (m.type() === 'error' || /Content Security Policy/i.test(m.text())) && problems.push(m.text()),
  )
  page.on('pageerror', (e) => problems.push(String(e)))
  await page.exposeFunction('__walletSignIn', async (inputJson) => {
    const input = JSON.parse(inputJson)
    const message = new TextEncoder().encode(createSignInMessageText({ ...input, address: env.backer.address }))
    const signature = await signBytes(env.backer.keyPair.privateKey, message)
    return {
      signedMessage: Buffer.from(message).toString('base64'),
      signature: Buffer.from(signature).toString('base64'),
    }
  })
  await page.exposeFunction('__walletSignAndSend', async (txB64) => {
    const tx = getTransactionDecoder().decode(getBase64Encoder().encode(txB64))
    const signed = await signTransaction([env.backer.keyPair], tx)
    await env.rpc
      .sendTransaction(getBase64EncodedWireTransaction(signed), {
        encoding: 'base64',
        preflightCommitment: 'confirmed',
      })
      .send()
    const sig = getSignatureFromTransaction(signed)
    for (let i = 0; i < 60; i++) {
      const { value } = await env.rpc.getSignatureStatuses([sig]).send()
      if (value[0]?.confirmationStatus === 'confirmed' || value[0]?.confirmationStatus === 'finalized') break
      await new Promise((r) => setTimeout(r, 500))
    }
    const bytes = Object.values(signed.signatures)[0]
    return Buffer.from(bytes).toString('base64')
  })
  await page.addInitScript(walletInitScript(env.backer.address, getAddressEncoder().encode(env.backer.address)))
  if (tamper)
    await page.route('**/l/' + env.pool, async (route) => {
      const r = await route.fetch()
      const body = (await r.text()).replace(/"executor":"[^"]+"/, '"executor":"11111111111111111111111111111111"')
      await route.fulfill({ response: r, body })
    })
  await page.goto(`${env.base}/l/${env.pool}`)
  return { browser, page, problems }
}

/** The trust badges as shown: words and link. */
const trustBadges = (page) =>
  page.$$eval('#trust a', (as) => as.map((a) => ({ words: a.textContent, href: a.getAttribute('href') })))

const shot = async (page, name) => {
  if (!SHOTS) return
  mkdirSync(SHOTS, { recursive: true })
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true })
}

test(
  'the backing page: back from a browser wallet, see it live, revoke it; the chain agrees each time',
  { skip, timeout: 300_000 },
  async () => {
    const env = await setup()
    const { browser, page, problems } = await openPage(env, false)
    try {
      await page.waitForFunction(() =>
        document.getElementById('route')?.textContent?.startsWith('On its bonding curve'),
      )
      assert.equal(await page.textContent('#committed'), 'No backers yet. Be the first.')
      // Raised against the threshold, not a percentage that reads as nothing at the start.
      assert.equal(await page.textContent('#route'), 'On its bonding curve: 0 of 1,000 TQ raised')
      // The sentence is whole on first load, and the token's own image sits beside its name.
      assert.equal(await page.inputValue('#amount'), '25')
      assert.equal(await page.textContent('#sentence'), 'Back WEBT: 25 TQ every week, for 90 days.')
      await page.waitForSelector('#logo:not([hidden])')
      const logo = await page.$eval('#logo', (i) => ({ src: i.getAttribute('src'), w: i.naturalWidth }))
      assert.deepEqual(logo, { src: '/t/nimus.png', w: 512 })
      // The token's own accounts, read from the chain: all three promises hold for our preset.
      const badges = await trustBadges(page)
      assert.deepEqual(
        badges.map((b) => b.words),
        ['Mint authority disabled', 'Freeze authority disabled', 'Metadata permanent'],
      )
      assert.ok(badges[0].href.includes(env.baseMint) && badges[1].href.includes(env.baseMint))
      assert.ok(!badges[2].href.includes(env.baseMint), 'the metadata badge links the metadata account')
      await shot(page, '01-backing-page')
      await page.fill('#amount', '5')
      await page.click('#durations button[data-v="30"]')
      assert.equal(await page.textContent('#sentence'), 'Back WEBT: 5 TQ every week, for 30 days.')
      await page.click('text=nuntius test wallet')
      await page.waitForSelector('#step-back:not([hidden])')
      await page.click('#approve')
      await page.waitForFunction(() => /^Live\./.test(document.getElementById('status')?.textContent ?? ''), null, {
        timeout: 120_000,
      })
      await shot(page, '02-backing-live')
      // The chain: one delegation from the backer to the executor, with exactly these terms.
      // The page says Live, then reads the list: wait for the permission under "Your permissions".
      await page.waitForSelector('#mine-list li', { timeout: 30_000 })
      await page.waitForFunction(() =>
        /1 backer commits 5 TQ a week/.test(document.getElementById('committed')?.textContent ?? ''),
      )
      // Revoke from the page.
      await page.click('#mine-list .revoke')
      await page.waitForFunction(() => /^Revoked\./.test(document.getElementById('status')?.textContent ?? ''), null, {
        timeout: 120_000,
      })
      await shot(page, '03-backing-revoked')
      assert.equal(await page.isHidden('#mine'), true)
      assert.deepEqual(problems, [], 'no console errors, and no CSP violation')
      // The delegations the backer ever had on this program are gone.
      const { listDelegations } = await import('../dist/mandate-chain.js')
      assert.deepEqual(await listDelegations(env.rpc, env.backer.address), [])
    } finally {
      await browser.close()
      env.server.close()
    }
  },
)

test(
  'the page refuses a transaction that does not match it, before the wallet is asked',
  { skip, timeout: 300_000 },
  async () => {
    const env = await setup()
    const { browser, page } = await openPage(env, true)
    try {
      await page.waitForFunction(() =>
        document.getElementById('route')?.textContent?.startsWith('On its bonding curve'),
      )
      await page.fill('#amount', '5')
      await page.click('text=nuntius test wallet')
      await page.click('#approve')
      await page.waitForFunction(
        () => /did not match what you approved/.test(document.getElementById('status')?.textContent ?? ''),
        null,
        {
          timeout: 60_000,
        },
      )
      assert.equal(await page.evaluate(() => window.__walletCalls ?? 0), 0, 'the wallet never saw it')
      await shot(page, '04-backing-refused')
    } finally {
      await browser.close()
      env.server.close()
    }
  },
)

test(
  'a token whose metadata its creator can still change: no "Metadata permanent"; a mint authority or an unread fact shows nothing',
  { skip, timeout: 300_000 },
  async () => {
    const env = await setup()
    const browser = await chromium.launch(CHROME ? { executablePath: CHROME } : {})
    try {
      const page = await browser.newPage({ viewport: { width: 420, height: 900 } })
      await page.goto(`${env.base}/l/${env.openPool}`)
      await page.waitForFunction(() =>
        document.getElementById('route')?.textContent?.startsWith('On its bonding curve'),
      )
      assert.equal(await page.textContent('#symbol'), 'OPEN')
      assert.deepEqual(
        (await trustBadges(page)).map((b) => b.words),
        ['Mint authority disabled', 'Freeze authority disabled'],
      )
      await shot(page, '05-backing-mutable-token')

      // What the page does with a live mint authority and with a failed read. The first is SKR's
      // own read on mainnet (6 Oct: mint authority set, no freeze authority, metadata mutable).
      for (const [trust, expected] of [
        [
          {
            mint: 'SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3',
            metadata: 'J753AwzZP1mrHgnfuujQTd7a3jEWQaUCzskMxLwsVYVj',
            mintAuthorityDisabled: false,
            freezeAuthorityDisabled: true,
            metadataPermanent: false,
          },
          ['Freeze authority disabled'],
        ],
        [
          {
            mint: 'x',
            metadata: null,
            mintAuthorityDisabled: null,
            freezeAuthorityDisabled: null,
            metadataPermanent: null,
          },
          [],
        ],
        [null, []],
      ]) {
        await page.route(`**/api/launch/${env.openPool}`, async (route) => {
          const r = await route.fetch()
          const j = await r.json()
          j.launch.trust = trust
          await route.fulfill({ response: r, json: j })
        })
        await page.reload()
        await page.waitForFunction(() =>
          document.getElementById('route')?.textContent?.startsWith('On its bonding curve'),
        )
        assert.deepEqual(
          (await trustBadges(page)).map((b) => b.words),
          expected,
        )
        assert.equal(await page.isHidden('#trust'), expected.length === 0)
        await page.unroute(`**/api/launch/${env.openPool}`)
      }
    } finally {
      await browser.close()
      env.server.close()
    }
  },
)
