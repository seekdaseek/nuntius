// The executor's own simulation asks for the program's answer, not the blockhash's: an RPC node
// behind the one that issued the blockhash must not fail it (6 Oct: BlockhashNotFound lost a
// period). A fake RPC that lags: it knows no recent blockhash unless asked to replace it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { simulateWire, type Rpc } from './tx.js'

function laggingRpc(programErr: unknown = null) {
  const calls: Record<string, unknown>[] = []
  const rpc = {
    simulateTransaction: (_wire: string, opts: Record<string, unknown>) => ({
      send: async () => {
        calls.push(opts)
        if (!opts.replaceRecentBlockhash) return { value: { err: 'BlockhashNotFound' } }
        return { value: { err: programErr } }
      },
    }),
  } as unknown as Rpc
  return { rpc, calls }
}

test('simulateWire: a lagging node cannot fail the check; the blockhash is replaced, signatures not verified', async () => {
  const { rpc, calls } = laggingRpc()
  assert.deepEqual(await simulateWire(rpc, 'AA=='), { err: null, customCode: null })
  assert.equal(calls[0]!.replaceRecentBlockhash, true)
  assert.equal(calls[0]!.sigVerify, false)
  assert.equal(calls[0]!.commitment, 'confirmed')
})

test("simulateWire: the program's own refusal still comes through", async () => {
  const { rpc } = laggingRpc({ InstructionError: [2, { Custom: 400 }] })
  const r = await simulateWire(rpc, 'AA==')
  assert.equal(r.customCode, 400)
  assert.match(r.err!, /InstructionError/)
})
