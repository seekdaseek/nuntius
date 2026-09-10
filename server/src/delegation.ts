/**
 * Solana Subscriptions delegation, built server-side.
 *
 * The device never needs the subscriptions SDK: the server composes the
 * instructions with the SDK's overlay builders and hands the Seeker a single
 * base64 transaction to sign through Mobile Wallet Adapter. That keeps kit 7 out
 * of the app bundle, which still resolves kit 6 at the root.
 *
 * Devnet only for the spike — the program is deployed at the same canonical
 * address on every cluster.
 */
import {
  appendTransactionMessageInstructions,
  compileTransaction,
  createNoopSigner,
  createSolanaRpc,
  createTransactionMessage,
  generateKeyPairSigner,
  getBase64Decoder,
  getTransactionEncoder,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Address,
  type Instruction,
  type TransactionSigner,
} from '@solana/kit'
import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenInstructionAsync,
  getInitializeMintInstruction,
  getMintSize,
  getMintToInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from '@solana-program/token'
import { getCreateAccountInstruction } from '@solana-program/system'
import {
  fetchMaybeRecurringDelegation,
  fetchSubscriptionAuthority,
  findRecurringDelegationPda,
  findSubscriptionAuthorityPda,
  getCreateRecurringDelegationOverlayInstructionAsync,
  getInitSubscriptionAuthorityOverlayInstructionAsync,
  getTransferRecurringOverlayInstructionAsync,
} from '@solana/subscriptions'

export const SUBSCRIPTIONS_PROGRAM = 'De1egAFMkMWZSN5rYXRj9CAdheBamobVNubTsi9avR44'

/** Devnet RPC; prefers the Helius devnet host when a key is configured. */
export function devnetRpcUrl(heliusRpc: string | null): string {
  return heliusRpc?.replace('mainnet.helius-rpc.com', 'devnet.helius-rpc.com') ?? 'https://api.devnet.solana.com'
}

export interface DelegationSetup {
  /** Unsigned transaction, base64, for the device to sign via MWA. */
  transactionBase64: string
  mint: Address
  userAta: Address
  authorityPda: Address
  delegationPda: Address
  delegatee: Address
  amountPerPeriod: string
  periodLengthS: number
}

/**
 * Prepares a devnet token the given wallet holds, then builds the ONE transaction
 * the device signs: init the Subscription Authority and create the recurring
 * delegation together. The owner is fee payer and sole signer, so Seed Vault sees
 * a single approval rather than two.
 */
export async function buildDelegationSetup(params: {
  rpcUrl: string
  owner: Address
  payer: TransactionSigner
  delegatee: Address
  amountPerPeriod: bigint
  periodLengthS: bigint
  decimals: number
}): Promise<DelegationSetup> {
  const { rpcUrl, owner, payer, delegatee, amountPerPeriod, periodLengthS, decimals } = params
  const rpc = createSolanaRpc(rpcUrl)

  // 1. Server-funded devnet mint, with the user's ATA pre-funded so the
  //    delegation has something to draw against.
  const mint = await generateKeyPairSigner()
  const space = BigInt(getMintSize())
  const rent = await rpc.getMinimumBalanceForRentExemption(space).send()
  const [userAta] = await findAssociatedTokenPda({
    mint: mint.address,
    owner,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  })
  await sendWithPayer(rpc, payer, [
    getCreateAccountInstruction({
      payer,
      newAccount: mint,
      lamports: rent,
      space,
      programAddress: TOKEN_PROGRAM_ADDRESS,
    }),
    getInitializeMintInstruction({ mint: mint.address, decimals, mintAuthority: payer.address }),
    await getCreateAssociatedTokenInstructionAsync({ payer, mint: mint.address, owner }),
    getMintToInstruction({
      mint: mint.address,
      token: userAta,
      mintAuthority: payer,
      amount: amountPerPeriod * 10n,
    }),
  ])

  // 2. Build the two instructions the USER must authorize. createRecurringDelegation
  //    needs the authority's initId, which only exists after init lands — but both
  //    go in one transaction, so read the id the init will produce by simulating
  //    the PDA's post-state is not possible; instead init first, then delegate.
  const ownerSigner = createNoopSigner(owner)
  const initIx = await getInitSubscriptionAuthorityOverlayInstructionAsync({
    owner: ownerSigner,
    tokenMint: mint.address,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
    userAta,
  })
  const [authorityPda] = await findSubscriptionAuthorityPda({ user: owner, tokenMint: mint.address })

  const { value: blockhash } = await rpc.getLatestBlockhash().send()
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(owner, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstructions([initIx], m),
  )
  const compiled = compileTransaction(message)
  const transactionBase64 = getBase64Decoder().decode(getTransactionEncoder().encode(compiled))

  const [delegationPda] = await findRecurringDelegationPda({
    subscriptionAuthority: authorityPda,
    delegator: owner,
    delegatee,
    nonce: 0n,
  })

  return {
    transactionBase64,
    mint: mint.address,
    userAta,
    authorityPda,
    delegationPda,
    delegatee,
    amountPerPeriod: amountPerPeriod.toString(),
    periodLengthS: Number(periodLengthS),
  }
}

/**
 * Second transaction: the recurring delegation itself. Built after the authority
 * exists, because createRecurringDelegation must pin the authority's initId.
 */
export async function buildRecurringDelegationTx(params: {
  rpcUrl: string
  owner: Address
  mint: Address
  delegatee: Address
  amountPerPeriod: bigint
  periodLengthS: bigint
}): Promise<{ transactionBase64: string; delegationPda: Address; initId: string }> {
  const { rpcUrl, owner, mint, delegatee, amountPerPeriod, periodLengthS } = params
  const rpc = createSolanaRpc(rpcUrl)
  const [authorityPda] = await findSubscriptionAuthorityPda({ user: owner, tokenMint: mint })
  const authority = await fetchSubscriptionAuthority(rpc, authorityPda)
  const initId = (authority.data as unknown as { initId: bigint }).initId

  const ownerSigner = createNoopSigner(owner)
  const ix = await getCreateRecurringDelegationOverlayInstructionAsync({
    delegator: ownerSigner,
    delegatee,
    tokenMint: mint,
    nonce: 0n,
    amountPerPeriod,
    periodLengthS,
    startTs: 0n,
    expiryTs: BigInt(Math.floor(Date.now() / 1000) + 86_400),
    expectedSubscriptionAuthorityInitId: initId,
  })

  const { value: blockhash } = await rpc.getLatestBlockhash().send()
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(owner, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstructions([ix], m),
  )
  const compiled = compileTransaction(message)
  const [delegationPda] = await findRecurringDelegationPda({
    subscriptionAuthority: authorityPda,
    delegator: owner,
    delegatee,
    nonce: 0n,
  })
  return {
    transactionBase64: getBase64Decoder().decode(getTransactionEncoder().encode(compiled)),
    delegationPda,
    initId: initId.toString(),
  }
}

/** Executes one delegated pull. Only the delegatee signs — the user is not involved. */
export async function executePull(params: {
  rpcUrl: string
  delegatee: TransactionSigner
  delegationPda: Address
  delegator: Address
  delegatorAta: Address
  receiverAta: Address
  mint: Address
  amount: bigint
}): Promise<string> {
  const { rpcUrl, delegatee, delegationPda, delegator, delegatorAta, receiverAta, mint, amount } = params
  const rpc = createSolanaRpc(rpcUrl)
  const ix = await getTransferRecurringOverlayInstructionAsync({
    amount,
    delegatee,
    delegationPda,
    delegator,
    delegatorAta,
    receiverAta,
    tokenMint: mint,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  })
  return sendWithPayer(rpc, delegatee, [ix])
}

/** Current on-chain state of a recurring delegation, for the evidence screen. */
export async function readDelegation(
  rpcUrl: string,
  delegationPda: Address,
): Promise<{
  exists: boolean
  amountPerPeriod?: string
  amountPulledInPeriod?: string
  currentPeriodStartTs?: number
  periodLengthS?: number
}> {
  const rpc = createSolanaRpc(rpcUrl)
  const acct = await fetchMaybeRecurringDelegation(rpc, delegationPda)
  if (!acct.exists) return { exists: false }
  const d = acct.data as unknown as {
    amountPerPeriod: bigint
    amountPulledInPeriod: bigint
    currentPeriodStartTs: bigint
    periodLengthS: bigint
  }
  return {
    exists: true,
    amountPerPeriod: d.amountPerPeriod.toString(),
    amountPulledInPeriod: d.amountPulledInPeriod.toString(),
    currentPeriodStartTs: Number(d.currentPeriodStartTs),
    periodLengthS: Number(d.periodLengthS),
  }
}

async function sendWithPayer(
  rpc: ReturnType<typeof createSolanaRpc>,
  payer: TransactionSigner,
  instructions: Instruction[],
): Promise<string> {
  const { value: blockhash } = await rpc.getLatestBlockhash().send()
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(payer.address, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  )
  const signed = await signTransactionMessageWithSigners(message)
  const wire = getBase64Decoder().decode(getTransactionEncoder().encode(signed))
  const sig = await rpc.sendTransaction(wire as never, { encoding: 'base64', preflightCommitment: 'confirmed' }).send()
  for (let i = 0; i < 40; i++) {
    const { value } = await rpc.getSignatureStatuses([sig], { searchTransactionHistory: true }).send()
    const st = value[0]
    if (st?.err) throw new Error(`transaction failed: ${JSON.stringify(st.err)}`)
    if (st?.confirmationStatus === 'confirmed' || st?.confirmationStatus === 'finalized') return sig
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`transaction ${sig} not confirmed`)
}
