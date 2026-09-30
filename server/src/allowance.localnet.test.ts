import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createNoopSigner, type Address } from '@solana/kit'
import { getApproveCheckedInstruction } from '@solana-program/token'
import { buildGrantTx, buildRevokeTx, pullInstruction, readAta, readRecurring } from './mandate-chain.js'
import { recurringLifetime } from './allowance.js'
import { signAndSend, compileUnsigned } from './tx.js'
import {
  assertOk,
  ataFor,
  deviceSignAndSend,
  funded,
  mintTo,
  requireLocal,
  skipLocalnet,
  sleep,
  tokenBalance,
} from './test/localnet.js'

const PERIOD = 2n
let rpcRef: ReturnType<typeof requireLocal> | null = null
/** The validator's clock, which is what the program checks (it lags the wall clock). */
async function chainNow(): Promise<bigint> {
  const rpc = rpcRef!
  const slot = await rpc.getSlot({ commitment: 'confirmed' }).send()
  return BigInt((await rpc.getBlockTime(slot).send()) ?? 0n)
}
async function waitUntil(ts: bigint) {
  while ((await chainNow()) < ts) await sleep(250)
}

test(
  'the grant caps the token allowance at the lifetime total, on the real program',
  { skip: skipLocalnet, timeout: 240_000 },
  async (t) => {
    const rpc = requireLocal()
    rpcRef = rpc
    const exec = await funded(rpc) // the delegatee (nuntius executor)
    const payee = await funded(rpc)

    const setup = async (balance = 1_000_000n) => {
      const owner = await funded(rpc)
      const { mint, ata } = await mintTo(rpc, owner, owner.address, balance)
      const payeeAta = await ataFor(rpc, payee, mint, payee.address)
      const grant = async (nonce: bigint, amountPerPeriod: bigint, startTs: bigint, expiryTs: bigint) => {
        const g = await buildGrantTx(rpc, {
          owner: owner.address,
          mint,
          delegatee: exec.address,
          nonce,
          amountPerPeriod,
          periodLengthS: PERIOD,
          startTs,
          expiryTs,
        })
        assertOk(await deviceSignAndSend(rpc, owner, g.transactionBase64))
        return g
      }
      const pull = (pda: Address, amount: bigint) =>
        pullInstruction({
          delegatee: exec,
          delegationPda: pda,
          delegator: owner.address,
          delegatorAta: ata,
          receiverAta: payeeAta,
          mint,
          amount,
        }).then((ix) => signAndSend(rpc, exec, [ix]))
      const revoke = async (pda: Address) => {
        const r = await buildRevokeTx(rpc, owner.address, pda, mint)
        assertOk(await deviceSignAndSend(rpc, owner, r.transactionBase64))
        return r
      }
      return { owner, mint, ata, payeeAta, grant, pull, revoke }
    }

    await t.test(
      'pulls succeed up to the total; the allowance reaches 0 and the delegate clears itself',
      async (st) => {
        const s = await setup()
        const start = (await chainNow()) + 3n
        // Billable period starts: start, start+2, start+4 (all before start+5): 3 × 100.
        const g = await s.grant(1n, 100n, start, start + 5n)
        assert.equal(g.allowance, 300n)
        let ata = await readAta(rpc, s.ata)
        assert.equal(ata.delegate, g.authorityPda)
        assert.equal(ata.delegatedAmount, '300', 'not u64::MAX: the cap is on chain at the token level')
        for (const [i, left] of [
          [0n, '200'],
          [1n, '100'],
        ] as const) {
          await waitUntil(start + i * PERIOD)
          assertOk(await s.pull(g.delegationPda, 100n))
          ata = await readAta(rpc, s.ata)
          assert.equal(ata.delegatedAmount, left)
        }
        await waitUntil(start + 2n * PERIOD)
        assertOk(await s.pull(g.delegationPda, 100n))
        ata = await readAta(rpc, s.ata)
        assert.equal(ata.delegate, null, 'SPL Token clears the delegate when the allowance reaches 0')
        assert.equal(await tokenBalance(rpc, s.payeeAta), 300n)
        // Past the last billable start the delegation has nothing left, and neither has the allowance.
        await waitUntil(start + 6n)
        const after = await s.pull(g.delegationPda, 1n)
        assert.notEqual(after.err, null, 'nothing more can move')
        assert.equal(await tokenBalance(rpc, s.payeeAta), 300n)

        await st.test('revoke after the allowance is spent still ends with delegate none', async () => {
          const r = await s.revoke(g.delegationPda)
          assert.equal(r.revokesAuthority, true)
          assert.equal((await readAta(rpc, s.ata)).delegate, null)
        })
      },
    )

    await t.test('the token program refuses a pull the program allows once the allowance is short', async () => {
      const s = await setup()
      const start = (await chainNow()) + 3n
      const g = await s.grant(1n, 100n, start, start + 5n)
      await waitUntil(start)
      assertOk(await s.pull(g.delegationPda, 100n))
      // Stand-in for "the total is used up": the owner lowers the allowance to 50
      // with their own approveChecked. The next period opens 100 in the program.
      const owner = createNoopSigner(s.owner.address)
      const lower = getApproveCheckedInstruction({
        source: s.ata,
        mint: s.mint,
        delegate: g.authorityPda,
        owner,
        amount: 50n,
        decimals: 6,
      })
      assertOk(await deviceSignAndSend(rpc, s.owner, await compileUnsigned(rpc, s.owner.address, [lower])))
      await waitUntil(start + PERIOD)
      const state = await readRecurring(rpc, g.delegationPda)
      assert.equal(recurringLifetime(state as never, await chainNow()), 200n, 'the program would still allow 100 now')
      const l = await s.pull(g.delegationPda, 100n)
      assert.notEqual(l.err, null)
      assert.equal(l.customCode, 1, 'SPL Token error 1, insufficient funds: refused by the token program, not 0x190')
      assert.equal(await tokenBalance(rpc, s.payeeAta), 100n)
    })

    await t.test('a second permission on the same mint raises the allowance by exactly its total', async (st) => {
      const s = await setup()
      const start = (await chainNow()) + 3n
      const a = await s.grant(1n, 100n, start, start + 5n) // 300
      await waitUntil(start)
      assertOk(await s.pull(a.delegationPda, 100n)) // A has 200 left
      assert.equal((await readAta(rpc, s.ata)).delegatedAmount, '200')
      const bStart = (await chainNow()) + 3n
      const b = await s.grant(2n, 40n, bStart, bStart + 3n) // starts bStart, bStart+2: 2 × 40 = 80
      assert.equal(b.allowance, 280n, "A's 200 left plus B's 80")
      assert.equal((await readAta(rpc, s.ata)).delegatedAmount, '280')

      await st.test('revoking one of two lowers the allowance to what the other can still take', async () => {
        const r = await s.revoke(b.delegationPda)
        assert.equal(r.revokesAuthority, false)
        const ata = await readAta(rpc, s.ata)
        assert.equal(ata.delegate, a.authorityPda)
        const aLeft = recurringLifetime((await readRecurring(rpc, a.delegationPda)) as never, await chainNow())
        assert.equal(ata.delegatedAmount, String(aLeft))
      })
      await st.test('revoking the last one ends with delegate none', async () => {
        const r = await s.revoke(a.delegationPda)
        assert.equal(r.revokesAuthority, true)
        assert.equal((await readAta(rpc, s.ata)).delegate, null)
      })
    })
  },
)
