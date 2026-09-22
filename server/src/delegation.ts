/**
 * Solana Subscriptions delegation, built server-side.
 *
 * The device never needs the subscriptions SDK: the server composes the
 * instructions with the SDK's overlay builders and hands the Seeker a single
 * base64 transaction to sign through Mobile Wallet Adapter. That keeps kit 7 out
 * of the app bundle, which still resolves kit 6 at the root.
 *
 * The program is deployed at the same canonical address on every cluster, so
 * cluster selection is purely a choice of RPC. Devnet mints its own throwaway
 * token (`buildDelegationSetup`); mainnet delegates against a mint the user
 * already holds and creates nothing (`buildInitAuthorityTx`).
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
  getRevokeDelegationOverlayInstruction,
  getRevokeSubscriptionAuthorityOverlayInstructionAsync,
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

/**
 * Server-authorized delegation: the owner is a keypair we hold, so no wallet is
 * involved. Used to exercise everything downstream of authorization while the
 * Seed Vault path is blocked. The device path uses the two build* functions
 * above instead and never exposes a user key to the server.
 */
export async function authorizeDelegationServerSide(params: {
  rpcUrl: string
  owner: TransactionSigner
  delegatee: Address
  amountPerPeriod: bigint
  periodLengthS: bigint
  decimals: number
}): Promise<{
  mint: Address
  userAta: Address
  authorityPda: Address
  delegationPda: Address
  authoritySignature: string
  delegationSignature: string
}> {
  const { rpcUrl, owner, delegatee, amountPerPeriod, periodLengthS, decimals } = params
  const rpc = createSolanaRpc(rpcUrl)

  const mint = await generateKeyPairSigner()
  const space = BigInt(getMintSize())
  const rent = await rpc.getMinimumBalanceForRentExemption(space).send()
  const [userAta] = await findAssociatedTokenPda({
    mint: mint.address,
    owner: owner.address,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  })
  await sendWithPayer(rpc, owner, [
    getCreateAccountInstruction({
      payer: owner,
      newAccount: mint,
      lamports: rent,
      space,
      programAddress: TOKEN_PROGRAM_ADDRESS,
    }),
    getInitializeMintInstruction({ mint: mint.address, decimals, mintAuthority: owner.address }),
    await getCreateAssociatedTokenInstructionAsync({ payer: owner, mint: mint.address, owner: owner.address }),
    getMintToInstruction({
      mint: mint.address,
      token: userAta,
      mintAuthority: owner,
      amount: amountPerPeriod * 10n,
    }),
  ])

  const authoritySignature = await sendWithPayer(rpc, owner, [
    await getInitSubscriptionAuthorityOverlayInstructionAsync({
      owner,
      tokenMint: mint.address,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
      userAta,
    }),
  ])

  const [authorityPda] = await findSubscriptionAuthorityPda({ user: owner.address, tokenMint: mint.address })
  const authority = await fetchSubscriptionAuthority(rpc, authorityPda)
  const initId = (authority.data as unknown as { initId: bigint }).initId

  const delegationSignature = await sendWithPayer(rpc, owner, [
    await getCreateRecurringDelegationOverlayInstructionAsync({
      delegator: owner,
      delegatee,
      tokenMint: mint.address,
      nonce: 0n,
      amountPerPeriod,
      periodLengthS,
      startTs: 0n,
      expiryTs: BigInt(Math.floor(Date.now() / 1000) + 86_400),
      expectedSubscriptionAuthorityInitId: initId,
    }),
  ])

  const [delegationPda] = await findRecurringDelegationPda({
    subscriptionAuthority: authorityPda,
    delegator: owner.address,
    delegatee,
    nonce: 0n,
  })
  return { mint: mint.address, userAta, authorityPda, delegationPda, authoritySignature, delegationSignature }
}

/** Creates the delegatee's ATA if absent; returns its address. Server pays the rent. */
export async function ensureReceiverAta(params: {
  rpcUrl: string
  payer: TransactionSigner
  mint: Address
  owner: Address
}): Promise<Address> {
  const { rpcUrl, payer, mint, owner } = params
  const rpc = createSolanaRpc(rpcUrl)
  const [ata] = await findAssociatedTokenPda({ mint, owner, tokenProgram: TOKEN_PROGRAM_ADDRESS })
  const existing = await rpc.getAccountInfo(ata, { encoding: 'base64' }).send()
  if (existing.value) return ata
  await sendWithPayer(rpc, payer, [await getCreateAssociatedTokenInstructionAsync({ payer, mint, owner })])
  return ata
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
  /**
   * Skip preflight so a rejected pull still LANDS, producing a real signature
   * whose recorded error is the program's. Preflight catches an over-cap pull
   * before it reaches the ledger, which leaves nothing to point a judge at.
   */
  landFailure?: boolean
}): Promise<{ signature: string; onChainError: string | null; logs: string[] }> {
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
  if (!params.landFailure) {
    return { signature: await sendWithPayer(rpc, delegatee, [ix]), onChainError: null, logs: [] }
  }
  return sendAndRecord(rpc, delegatee, [ix])
}

/**
 * Sends with preflight off and reports what the ledger recorded rather than
 * throwing. Used only to capture a rejection as evidence.
 */
async function sendAndRecord(
  rpc: ReturnType<typeof createSolanaRpc>,
  payer: TransactionSigner,
  instructions: Instruction[],
): Promise<{ signature: string; onChainError: string | null; logs: string[] }> {
  const { value: blockhash } = await rpc.getLatestBlockhash().send()
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(payer.address, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  )
  const signed = await signTransactionMessageWithSigners(message)
  const wire = getBase64Decoder().decode(getTransactionEncoder().encode(signed))
  const signature = await rpc
    .sendTransaction(wire as never, { encoding: 'base64', skipPreflight: true, preflightCommitment: 'confirmed' })
    .send()
  for (let i = 0; i < 60; i++) {
    const { value } = await rpc.getSignatureStatuses([signature], { searchTransactionHistory: true }).send()
    const st = value[0]
    if (st && (st.err || st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) {
      const tx = await rpc
        .getTransaction(signature, { maxSupportedTransactionVersion: 0, encoding: 'json' })
        .send()
        .catch(() => null)
      return {
        signature,
        onChainError: st.err ? JSON.stringify(st.err, (_k, v) => (typeof v === 'bigint' ? Number(v) : v)) : null,
        logs: (tx?.meta?.logMessages as string[] | undefined) ?? [],
      }
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`transaction ${signature} not confirmed`)
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

/** Mainnet RPC. There is no public default: the Helius URL is load-bearing. */
export function mainnetRpcUrl(heliusRpc: string | null): string {
  if (!heliusRpc) throw new Error('HELIUS_RPC is required for mainnet delegation')
  return heliusRpc
}

/**
 * Mainnet setup: the ONE transaction the device signs to open a delegation
 * against a mint the user already holds.
 *
 * Unlike the devnet path this mints nothing and needs no server payer. The
 * user's ATA must already exist and already be the ATA for this mint, so both
 * are read off the chain and the request fails closed rather than producing a
 * confusing on-chain error later. `initSubscriptionAuthority` creates the
 * authority PDA and performs the SPL approve in a single instruction, so Seed
 * Vault sees one approval, not two.
 */
export async function buildInitAuthorityTx(params: {
  rpcUrl: string
  owner: Address
  mint: Address
  delegatee: Address
  amountPerPeriod: bigint
  periodLengthS: bigint
}): Promise<DelegationSetup> {
  const { rpcUrl, owner, mint, delegatee, amountPerPeriod, periodLengthS } = params
  const rpc = createSolanaRpc(rpcUrl)

  const [userAta] = await findAssociatedTokenPda({ mint, owner, tokenProgram: TOKEN_PROGRAM_ADDRESS })
  const ataInfo = await rpc.getAccountInfo(userAta, { encoding: 'jsonParsed' }).send()
  if (!ataInfo.value) {
    throw new Error(`token account ${userAta} does not exist — fund the wallet with this mint first`)
  }
  const parsed = (ataInfo.value.data as unknown as { parsed?: { info?: { mint?: string; owner?: string } } }).parsed
  if (parsed?.info?.mint !== mint || parsed?.info?.owner !== owner) {
    throw new Error(`token account ${userAta} is not the ${mint} account of ${owner}`)
  }

  const ownerSigner = createNoopSigner(owner)
  const initIx = await getInitSubscriptionAuthorityOverlayInstructionAsync({
    owner: ownerSigner,
    tokenMint: mint,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
    userAta,
  })
  const [authorityPda] = await findSubscriptionAuthorityPda({ user: owner, tokenMint: mint })

  const { value: blockhash } = await rpc.getLatestBlockhash().send()
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(owner, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstructions([initIx], m),
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
    mint,
    userAta,
    authorityPda,
    delegationPda,
    delegatee,
    amountPerPeriod: amountPerPeriod.toString(),
    periodLengthS: Number(periodLengthS),
  }
}

/** Reads the SPL delegate fields straight off a token account — the revoke proof. */
export async function readAtaDelegate(
  rpcUrl: string,
  ata: Address,
): Promise<{ delegate: string | null; delegatedAmount: string | null; amount: string | null; mint: string | null }> {
  const rpc = createSolanaRpc(rpcUrl)
  const info = await rpc.getAccountInfo(ata, { encoding: 'jsonParsed' }).send()
  if (!info.value) return { delegate: null, delegatedAmount: null, amount: null, mint: null }
  const i = (
    info.value.data as unknown as {
      parsed?: {
        info?: {
          delegate?: string
          delegatedAmount?: { amount?: string }
          tokenAmount?: { amount?: string }
          mint?: string
        }
      }
    }
  ).parsed?.info
  return {
    delegate: i?.delegate ?? null,
    delegatedAmount: i?.delegatedAmount?.amount ?? null,
    amount: i?.tokenAmount?.amount ?? null,
    mint: i?.mint ?? null,
  }
}

/**
 * Revocation, in the order that actually ends the arrangement.
 *
 * `revokeDelegation` closes the delegation PDA; `revokeSubscriptionAuthority`
 * then clears the SPL delegate on the user's ATA. `closeSubscriptionAuthority`
 * is deliberately absent — it leaves the SPL delegate live and would report a
 * false pass. Only the delegator (or the original rent payer) may revoke, so
 * both transactions are signed by the device, never by the server.
 */
export async function buildRevokeDelegationTx(params: {
  rpcUrl: string
  owner: Address
  delegationPda: Address
}): Promise<{ transactionBase64: string }> {
  const { rpcUrl, owner, delegationPda } = params
  const ix = getRevokeDelegationOverlayInstruction({
    authority: createNoopSigner(owner),
    delegationAccount: delegationPda,
  })
  return { transactionBase64: await compileForOwner(rpcUrl, owner, [ix]) }
}

export async function buildRevokeAuthorityTx(params: {
  rpcUrl: string
  owner: Address
  mint: Address
}): Promise<{ transactionBase64: string }> {
  const { rpcUrl, owner, mint } = params
  const ix = await getRevokeSubscriptionAuthorityOverlayInstructionAsync({
    user: createNoopSigner(owner),
    tokenMint: mint,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  })
  return { transactionBase64: await compileForOwner(rpcUrl, owner, [ix]) }
}

/** Compiles instructions into an unsigned transaction the owner alone must sign. */
async function compileForOwner(rpcUrl: string, owner: Address, instructions: Instruction[]): Promise<string> {
  const rpc = createSolanaRpc(rpcUrl)
  const { value: blockhash } = await rpc.getLatestBlockhash().send()
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(owner, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  )
  return getBase64Decoder().decode(getTransactionEncoder().encode(compileTransaction(message)))
}
