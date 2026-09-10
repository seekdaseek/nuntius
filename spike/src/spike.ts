/**
 * Devnet spike for BRIEF-05 section 2: prove the Solana Subscriptions recurring
 * delegation mechanic end to end, headless, with a throwaway keypair.
 *
 * The two items that matter: an over-cap pull must be rejected by the chain, and
 * a revoked delegation must stop working. Everything else is setup.
 *
 * Run: npm run spike
 */
import {
  appendTransactionMessageInstructions,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  createKeyPairSignerFromBytes,
  createTransactionMessage,
  generateKeyPairSigner,
  getSignatureFromTransaction,
  lamports,
  pipe,
  sendAndConfirmTransactionFactory,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Address,
  type Instruction,
  type TransactionSigner,
} from '@solana/kit'
import { readFile } from 'node:fs/promises'
import { getCreateAccountInstruction, getTransferSolInstruction } from '@solana-program/system'
import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenInstructionAsync,
  getInitializeMintInstruction,
  getMintSize,
  getMintToInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from '@solana-program/token'
import {
  fetchMaybeRecurringDelegation,
  findRecurringDelegationPda,
  findSubscriptionAuthorityPda,
  getCreateRecurringDelegationOverlayInstructionAsync,
  getInitSubscriptionAuthorityOverlayInstructionAsync,
  getRevokeDelegationOverlayInstruction,
  getRevokeSubscriptionAuthorityOverlayInstructionAsync,
  getTransferRecurringOverlayInstructionAsync,
} from '@solana/subscriptions'

/**
 * Devnet RPC. The public endpoint rate-limits hard (429s), so prefer the Helius
 * devnet host derived from HELIUS_RPC when it is present in the environment —
 * same key, devnet subdomain. Airdrop is NOT available there (403), which is why
 * funding comes from a pre-funded payer keypair rather than a faucet call.
 */
const heliusDevnet = process.env.HELIUS_RPC?.replace('mainnet.helius-rpc.com', 'devnet.helius-rpc.com')
const RPC_HTTP = heliusDevnet ?? 'https://api.devnet.solana.com'
const RPC_WS = heliusDevnet ? heliusDevnet.replace('https://', 'wss://') : 'wss://api.devnet.solana.com'
/** Pre-funded devnet payer; funds the throwaway keypairs by transfer. */
const PAYER_KEYPAIR = process.env.SPIKE_PAYER ?? `${process.env.HOME}/.config/solana/id.json`
const DECIMALS = 6
const UNIT = 10n ** BigInt(DECIMALS)
const CAP_PER_PERIOD = 100n * UNIT // 100 tokens per period
const PULL = 60n * UNIT // first pull: 60 tokens
const PERIOD_S = 30n // short so the reset is observable in one run

const rpc = createSolanaRpc(RPC_HTTP)
const rpcSubscriptions = createSolanaRpcSubscriptions(RPC_WS)
const sendAndConfirm = sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions })

const tokens = (raw: bigint) => `${Number(raw) / Number(UNIT)}`
const step = (n: string, msg: string) => console.log(`\n=== ${n} — ${msg}`)

/** Build, sign and send one transaction; returns the signature. */
async function send(feePayer: TransactionSigner, instructions: Instruction[]): Promise<string> {
  const { value: blockhash } = await rpc.getLatestBlockhash().send()
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(feePayer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  )
  const signed = await signTransactionMessageWithSigners(message)
  await sendAndConfirm(signed, { commitment: 'confirmed' })
  return getSignatureFromTransaction(signed)
}

/** Send expecting failure. Returns the chain's error, or throws if it wrongly succeeded. */
async function sendExpectingFailure(feePayer: TransactionSigner, instructions: Instruction[]): Promise<string> {
  try {
    const sig = await send(feePayer, instructions)
    throw new Error(`SPIKE FAILED: transaction was expected to be rejected but succeeded: ${sig}`)
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('SPIKE FAILED')) throw error
    return error instanceof Error ? error.message : String(error)
  }
}

/** Load the pre-funded devnet payer from a CLI keypair file (64-byte secret array). */
async function loadPayer(): Promise<TransactionSigner> {
  const raw = JSON.parse(await readFile(PAYER_KEYPAIR, 'utf8')) as number[]
  return createKeyPairSignerFromBytes(new Uint8Array(raw))
}

async function main(): Promise<void> {
  console.log('Solana Subscriptions devnet spike — program De1egAFMkMWZSN5rYXRj9CAdheBamobVNubTsi9avR44')

  // --- setup: throwaway keypairs, funded on devnet ---
  const user = await generateKeyPairSigner() // delegator + fee payer
  const delegatee = await generateKeyPairSigner() // the puller
  const mint = await generateKeyPairSigner()
  console.log(`user (delegator): ${user.address}`)
  console.log(`delegatee       : ${delegatee.address}`)
  console.log(`mint            : ${mint.address}`)

  const payer = await loadPayer()
  const payerBalance = (await rpc.getBalance(payer.address).send()).value
  console.log(`payer           : ${payer.address} (${Number(payerBalance) / 1e9} SOL)`)
  if (payerBalance < 300_000_000n) {
    throw new Error(
      `payer ${payer.address} has ${Number(payerBalance) / 1e9} SOL on devnet; needs >= 0.3. ` +
        `Fund it (faucet.solana.com or 'solana airdrop 1 ${payer.address} --url devnet') and re-run.`,
    )
  }
  await send(payer, [
    getTransferSolInstruction({ source: payer, destination: user.address, amount: lamports(120_000_000n) }),
    getTransferSolInstruction({ source: payer, destination: delegatee.address, amount: lamports(30_000_000n) }),
  ])
  console.log('funded user + delegatee from payer')

  // --- setup: SPL mint + ATAs, user holds the supply ---
  const space = BigInt(getMintSize())
  const rent = await rpc.getMinimumBalanceForRentExemption(space).send()
  await send(user, [
    getCreateAccountInstruction({
      payer: user,
      newAccount: mint,
      lamports: rent,
      space,
      programAddress: TOKEN_PROGRAM_ADDRESS,
    }),
    getInitializeMintInstruction({ mint: mint.address, decimals: DECIMALS, mintAuthority: user.address }),
  ])
  const [userAta] = await findAssociatedTokenPda({
    mint: mint.address,
    owner: user.address,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  })
  const [receiverAta] = await findAssociatedTokenPda({
    mint: mint.address,
    owner: delegatee.address,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  })
  await send(user, [
    await getCreateAssociatedTokenInstructionAsync({ payer: user, mint: mint.address, owner: user.address }),
    await getCreateAssociatedTokenInstructionAsync({ payer: user, mint: mint.address, owner: delegatee.address }),
    getMintToInstruction({
      mint: mint.address,
      token: userAta,
      mintAuthority: user,
      amount: 1_000n * UNIT,
    }),
  ])
  console.log(`userAta         : ${userAta}`)
  console.log(`receiverAta     : ${receiverAta}`)

  const balance = async (ata: Address) => (await rpc.getTokenAccountBalance(ata).send()).value.amount
  console.log(`minted 1000 tokens; user balance = ${tokens(BigInt(await balance(userAta)))}`)

  // --- 1. Subscription Authority ---
  step('1', 'create Subscription Authority')
  const sig1 = await send(user, [
    await getInitSubscriptionAuthorityOverlayInstructionAsync({
      owner: user,
      tokenMint: mint.address,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
      userAta,
    }),
  ])
  const [authorityPda] = await findSubscriptionAuthorityPda({ user: user.address, tokenMint: mint.address })
  console.log(`  authority PDA : ${authorityPda}`)
  console.log(`  signature     : ${sig1}`)

  // --- 2. Recurring delegation ---
  step('2', `create recurring delegation — cap ${tokens(CAP_PER_PERIOD)}/period, period ${PERIOD_S}s`)
  const nonce = 0n
  const sig2 = await send(user, [
    await getCreateRecurringDelegationOverlayInstructionAsync({
      delegator: user,
      delegatee: delegatee.address,
      tokenMint: mint.address,
      nonce,
      amountPerPeriod: CAP_PER_PERIOD,
      periodLengthS: PERIOD_S,
      startTs: 0n, // start when the tx lands
      expiryTs: BigInt(Math.floor(Date.now() / 1000) + 3600),
    }),
  ])
  const [delegationPda] = await findRecurringDelegationPda({
    subscriptionAuthority: authorityPda,
    delegator: user.address,
    delegatee: delegatee.address,
    nonce,
  })
  console.log(`  delegation PDA: ${delegationPda}`)
  console.log(`  signature     : ${sig2}`)

  const transferIx = (amount: bigint) =>
    getTransferRecurringOverlayInstructionAsync({
      amount,
      delegatee,
      delegationPda,
      delegator: user.address,
      delegatorAta: userAta,
      receiverAta,
      tokenMint: mint.address,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    })

  const showCap = async (label: string) => {
    const acct = await fetchMaybeRecurringDelegation(rpc, delegationPda)
    if (!acct.exists) {
      console.log(`  ${label}: delegation account does NOT exist`)
      return null
    }
    const d = acct.data as unknown as Record<string, bigint>
    const used = d.amountUsedThisPeriod ?? d.usedThisPeriod ?? 0n
    console.log(`  ${label}: cap ${tokens(CAP_PER_PERIOD)} | used this period ${tokens(BigInt(used))}`)
    return acct
  }

  // --- 3. Delegate executes a pull ---
  step('3', `delegatee pulls ${tokens(PULL)} tokens (user does NOT sign)`)
  const sig3 = await send(delegatee, [await transferIx(PULL)])
  console.log(`  signature     : ${sig3}`)

  // --- 4. Transfer landed, cap decremented ---
  step('4', 'confirm the transfer landed and the cap decremented')
  console.log(`  user balance  : ${tokens(BigInt(await balance(userAta)))}`)
  console.log(`  receiver bal  : ${tokens(BigInt(await balance(receiverAta)))}`)
  await showCap('cap state')

  // --- 5. Over-cap pull MUST fail ---
  step('5', `second pull of ${tokens(PULL)} exceeds remaining cap — MUST be rejected`)
  const err5 = await sendExpectingFailure(delegatee, [await transferIx(PULL)])
  console.log('  chain rejected it:')
  console.log(
    err5
      .split('\n')
      .map((l) => `    ${l}`)
      .join('\n'),
  )
  console.log(`  receiver bal unchanged: ${tokens(BigInt(await balance(receiverAta)))}`)

  // --- 6. Period reset ---
  step('6', `wait ${PERIOD_S}s for the period to reset, then pull again`)
  await new Promise((r) => setTimeout(r, Number(PERIOD_S) * 1000 + 5000))
  const sig6 = await send(delegatee, [await transferIx(PULL)])
  console.log(`  signature     : ${sig6}`)
  console.log(`  receiver bal  : ${tokens(BigInt(await balance(receiverAta)))}  (cap reset — second 60 succeeded)`)
  await showCap('cap state')

  // --- 7. Revoke, then prove no further pulls ---
  step('7', 'revokeDelegation, then prove a pull fails')
  const sig7 = await send(user, [
    getRevokeDelegationOverlayInstruction({ authority: user, delegationAccount: delegationPda }),
  ])
  console.log(`  revokeDelegation signature: ${sig7}`)
  await showCap('after revoke')

  const err7 = await sendExpectingFailure(delegatee, [await transferIx(1n * UNIT)])
  console.log('  post-revoke pull rejected:')
  console.log(
    err7
      .split('\n')
      .map((l) => `    ${l}`)
      .join('\n'),
  )

  step('7b', 'revokeSubscriptionAuthority — removes the SPL delegate entirely')
  const sig7b = await send(user, [
    await getRevokeSubscriptionAuthorityOverlayInstructionAsync({
      user,
      tokenMint: mint.address,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    }),
  ])
  console.log(`  revokeSubscriptionAuthority signature: ${sig7b}`)
  const delegateAfter = await rpc.getAccountInfo(userAta, { encoding: 'jsonParsed' }).send()
  const parsed = delegateAfter.value?.data as unknown as { parsed?: { info?: { delegate?: string } } }
  console.log(`  userAta delegate after revoke: ${parsed?.parsed?.info?.delegate ?? 'none'}`)

  console.log(
    `\n  final: user ${tokens(BigInt(await balance(userAta)))} | receiver ${tokens(BigInt(await balance(receiverAta)))}`,
  )
  console.log('\nSPIKE COMPLETE')
}

main().catch((error: unknown) => {
  console.error('\nSPIKE ABORTED:', error instanceof Error ? error.message : error)
  process.exit(1)
})
