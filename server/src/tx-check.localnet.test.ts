/**
 * The app's transaction check (core/tx-check.ts) against transactions the
 * server's own builders make on the real program: every grant, revoke and
 * launch shape is accepted exactly as built. With TX_FIXTURES_OUT set, the
 * transactions and what the screen would have shown are written there; the
 * app's unit tests (core/tx-check.test.ts) replay them, tampered and untampered.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { randomBytes } from 'node:crypto'
import {
  appendTransactionMessageInstructions,
  getAddressDecoder,
  compileTransaction,
  createNoopSigner,
  createTransactionMessage,
  getBase64Decoder,
  getTransactionEncoder,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
} from '@solana/kit'
import { buildGrantTx, buildRevokeTx, readAta } from './mandate-chain.js'
import { backerAccountInstruction } from './launch-api.js'
import { launchInstructions, offlineConnection } from './meteora.js'
import { assertOk, deviceSignAndSend, funded, mintTo, requireLocal, skipLocalnet } from './test/localnet.js'

type Check = (base64: string, e: Record<string, unknown>) => Promise<void>

test(
  'the app accepts every transaction the server builds, as built',
  { skip: skipLocalnet, timeout: 120_000 },
  async () => {
    const core = (await import(
      pathToFileURL(path.join(import.meta.dirname, '..', '..', 'core', 'tx-check.ts')).href
    )) as { checkTransaction: Check }
    const rpc = requireLocal()
    const owner = await funded(rpc)
    const executor = await funded(rpc)
    const { mint, ata } = await mintTo(rpc, owner, owner.address, 10_000_000n)
    const nowS = Math.floor(Date.now() / 1000)
    const fixtures: Record<string, { base64: string; expect: Record<string, unknown> }> = {}
    const accept = async (name: string, base64: string, expect: Record<string, unknown>) => {
      await core.checkTransaction(base64, expect)
      fixtures[name] = {
        base64,
        expect: Object.fromEntries(Object.entries(expect).map(([k, v]) => [k, typeof v === 'bigint' ? `${v}n` : v])),
      }
    }
    const terms = (nonce: bigint, amount: bigint, days: number) => ({
      owner: owner.address,
      mint,
      delegatee: executor.address,
      nonce,
      amountPerPeriod: amount,
      periodLengthS: 86_400n,
      startTs: 0n,
      expiryTs: BigInt(nowS + days * 86_400),
    })
    const grantExpect = (amount: bigint, days: number, shownAllowance: bigint | null | undefined) => ({
      kind: 'grant',
      wallet: owner.address,
      mint,
      decimals: 6,
      delegatee: executor.address,
      amountPerPeriod: amount,
      periodLengthS: 86_400,
      untilDays: days,
      nowS,
      shownAllowance,
    })

    // 1. A first grant: the authority is created in the same transaction; 30 daily periods of 50_000.
    const g1 = await buildGrantTx(rpc, terms(1n, 50_000n, 30))
    assert.equal(g1.allowance, 1_500_000n)
    await accept('grant-first', g1.transactionBase64, grantExpect(50_000n, 30, 1_500_000n))
    assertOk(await deviceSignAndSend(rpc, owner, g1.transactionBase64))

    // 2. A second grant on the same token: the approval covers both permissions.
    const g2 = await buildGrantTx(rpc, terms(2n, 10_000n, 7))
    assert.equal(g2.createsAuthority, false)
    await accept('grant-second', g2.transactionBase64, grantExpect(10_000n, 7, g2.allowance))
    assertOk(await deviceSignAndSend(rpc, owner, g2.transactionBase64))

    // 3. A back permission: the same grant plus the backer's own account for the launch token.
    const baseMint = getAddressDecoder().decode(randomBytes(32))
    const back = await buildGrantTx(rpc, terms(3n, 20_000n, 30), [
      (await backerAccountInstruction(owner.address, baseMint)).ix,
    ])
    await accept('grant-back', back.transactionBase64, { ...grantExpect(20_000n, 30, back.allowance), baseMint })

    // 4. Revoke one of two: the approval is trimmed to what the other can still take.
    const before = await readAta(rpc, ata)
    const r1 = await buildRevokeTx(rpc, owner.address, g1.delegationPda, mint)
    assert.equal(r1.revokesAuthority, false)
    const revokeExpect = (pda: string, allowance: bigint | null) => ({
      kind: 'revoke',
      wallet: owner.address,
      delegationPda: pda,
      mint,
      allowance,
    })
    await accept('revoke-trim', r1.transactionBase64, revokeExpect(g1.delegationPda, BigInt(before.delegatedAmount!)))
    assertOk(await deviceSignAndSend(rpc, owner, r1.transactionBase64))

    // 5. Revoke the last: the token-level delegate goes too.
    const r2 = await buildRevokeTx(rpc, owner.address, g2.delegationPda, mint)
    assert.equal(r2.revokesAuthority, true)
    await accept('revoke-last', r2.transactionBase64, revokeExpect(g2.delegationPda, null))

    // 6. A launch, as the launch route composes it (the SDK reads only the quote mint's owner).
    const config = getAddressDecoder().decode(randomBytes(32))
    const launchMint = getAddressDecoder().decode(randomBytes(32))
    const ixs = await launchInstructions(offlineConnection(), {
      creator: owner.address,
      quoteMint: mint,
      quoteThreshold: 50_000,
      name: 'natXbuilder',
      symbol: 'NATX',
      uri: `https://nuntius.ochinimus.app/m/${launchMint}.json`,
      config,
      baseMint: launchMint,
    })
    const { value } = await rpc.getLatestBlockhash().send()
    const launch = compileTransaction(
      pipe(
        createTransactionMessage({ version: 0 }),
        (m) => setTransactionMessageFeePayerSigner(createNoopSigner(owner.address as Address), m),
        (m) => setTransactionMessageLifetimeUsingBlockhash(value, m),
        (m) => appendTransactionMessageInstructions(ixs, m),
      ),
    )
    await accept('launch', getBase64Decoder().decode(getTransactionEncoder().encode(launch)), {
      kind: 'launch',
      wallet: owner.address,
      baseMint: launchMint,
      quoteMint: mint,
    })

    if (process.env.TX_FIXTURES_OUT)
      writeFileSync(process.env.TX_FIXTURES_OUT, `${JSON.stringify(fixtures, null, 2)}\n`)
  },
)
