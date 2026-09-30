/**
 * Localnet test kit. A local validator running the Subscriptions program built
 * from source at its canonical address stands in for the chain; see
 * scripts/localnet.sh. Tests that need it are skipped unless LOCALNET_RPC is
 * set, so `npm test` stays green on a machine without one — and says so.
 *
 * Nothing here touches devnet or mainnet: `requireLocal` refuses any RPC that is
 * not a loopback address, because these helpers airdrop and mint freely.
 */
import {
  createSolanaRpc,
  devnet,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getTransactionDecoder,
  lamports,
  signTransaction,
  type Address,
  type KeyPairSigner,
} from '@solana/kit'
import { getCreateAccountInstruction } from '@solana-program/system'
import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenInstructionAsync,
  getInitializeMintInstruction,
  getMintSize,
  getMintToInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from '@solana-program/token'
import { sendWire, signAndSend, waitFor, type Landed, type Rpc } from '../tx.js'

export const LOCALNET_RPC = process.env.LOCALNET_RPC ?? ''
export const skipLocalnet = LOCALNET_RPC ? false : 'LOCALNET_RPC not set — run scripts/localnet.sh (see README.md)'

export function requireLocal(): Rpc {
  const u = new URL(LOCALNET_RPC)
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) {
    throw new Error(`refusing non-loopback RPC ${u.hostname}: localnet helpers airdrop and mint freely`)
  }
  return createSolanaRpc(LOCALNET_RPC)
}

export async function funded(rpc: Rpc, sol = 2): Promise<KeyPairSigner> {
  const s = await generateKeyPairSigner()
  // Typed as a test cluster so requestAirdrop exists; requireLocal() has already
  // refused anything that is not loopback.
  const faucet = createSolanaRpc(devnet(LOCALNET_RPC))
  const sig = await faucet.requestAirdrop(s.address, lamports(BigInt(sol) * 1_000_000_000n)).send()
  for (let i = 0; i < 60; i++) {
    const { value } = await rpc.getSignatureStatuses([sig]).send()
    if (value[0]?.confirmationStatus === 'confirmed' || value[0]?.confirmationStatus === 'finalized') return s
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error('airdrop not confirmed')
}

export function assertOk(l: Landed): Landed {
  if (l.err) throw new Error(`transaction ${l.signature} failed: ${l.err}\n${l.logs.join('\n')}`)
  return l
}

/** A fresh mint with `amount` base units in `owner`'s ATA. The payer is the mint authority. */
export async function mintTo(
  rpc: Rpc,
  payer: KeyPairSigner,
  owner: Address,
  amount: bigint,
  decimals = 6,
): Promise<{ mint: Address; ata: Address }> {
  const mint = await generateKeyPairSigner()
  const space = BigInt(getMintSize())
  const rent = await rpc.getMinimumBalanceForRentExemption(space).send()
  const [ata] = await findAssociatedTokenPda({ mint: mint.address, owner, tokenProgram: TOKEN_PROGRAM_ADDRESS })
  assertOk(
    await signAndSend(rpc, payer, [
      getCreateAccountInstruction({
        payer,
        newAccount: mint,
        lamports: rent,
        space,
        programAddress: TOKEN_PROGRAM_ADDRESS,
      }),
      getInitializeMintInstruction({ mint: mint.address, decimals, mintAuthority: payer.address }),
      await getCreateAssociatedTokenInstructionAsync({ payer, mint: mint.address, owner }),
      getMintToInstruction({ mint: mint.address, token: ata, mintAuthority: payer, amount }),
    ]),
  )
  return { mint: mint.address, ata }
}

/** An empty ATA for `owner` on `mint`, paid by `payer`. */
export async function ataFor(rpc: Rpc, payer: KeyPairSigner, mint: Address, owner: Address): Promise<Address> {
  const [ata] = await findAssociatedTokenPda({ mint, owner, tokenProgram: TOKEN_PROGRAM_ADDRESS })
  assertOk(await signAndSend(rpc, payer, [await getCreateAssociatedTokenInstructionAsync({ payer, mint, owner })]))
  return ata
}

/**
 * Plays Seed Vault: takes the exact base64 bytes the server would hand the
 * phone, signs them with the owner's key, sends, and waits. If the server built
 * a transaction that needs any signer other than the owner, this fails —
 * which is the point.
 */
export async function deviceSignAndSend(rpc: Rpc, owner: KeyPairSigner, transactionBase64: string): Promise<Landed> {
  const tx = getTransactionDecoder().decode(getBase64Encoder().encode(transactionBase64))
  const signed = await signTransaction([owner.keyPair], tx)
  const { value } = await rpc.getLatestBlockhash().send()
  // The lifetime check below uses a fresh height; the tx's own blockhash is older or equal.
  await sendWire(rpc, getBase64EncodedWireTransaction(signed))
  const sigBytes = Object.values(signed.signatures)[0]
  if (!sigBytes) throw new Error('no signature')
  const { getBase58Decoder } = await import('@solana/kit')
  return waitFor(rpc, getBase58Decoder().decode(sigBytes), value.lastValidBlockHeight)
}

/** Number of required signers in a compiled transaction, read from its header. */
export function requiredSigners(transactionBase64: string): string[] {
  const tx = getTransactionDecoder().decode(getBase64Encoder().encode(transactionBase64))
  return Object.keys(tx.signatures)
}

export async function tokenBalance(rpc: Rpc, ata: Address): Promise<bigint> {
  const r = await rpc.getTokenAccountBalance(ata).send()
  return BigInt(r.value.amount)
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
