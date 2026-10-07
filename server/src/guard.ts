/**
 * The guard: receipts for EVERY Subscriptions delegation on a wallet, not just
 * the ones nuntius created. Another app's delegatee pulls → the user gets the
 * same receipt nuntius's own executor would produce. A pull the program
 * refused (0x190) → a "refused by the chain" receipt. A delegation that
 * appears without the user creating it in nuntius → "new permission — check
 * it". One that disappears → "revoked".
 *
 * Polling, not webhooks: getProgramAccounts (delegator memcmp) for the set,
 * getSignaturesForAddress per delegation PDA for activity since a stored
 * cursor. The token movement is read from the transaction's own pre/post token
 * balances for the owner's account, so the amount is what the chain recorded,
 * not what an instruction asked for.
 *
 * The first scan of an address is a silent baseline: history before the user
 * signed in is not replayed as a burst of pushes.
 */
import type { Address } from '@solana/kit'
import { effectiveWindow, listDelegations, type DelegationScans, type DelegationView } from './mandate-chain.js'
import { termsMatch, type MandateStore } from './mandate-store.js'
import type { Receipts } from './receipts.js'
import type { Logger } from './log.js'
import { safeError } from './log.js'
import { customCodeOf, type Rpc } from './tx.js'
import { ERR } from './mandate-chain.js'

export interface TxEffect {
  signature: string
  /** Owner's balance change on the delegation's mint, base units (negative = money left). */
  delta: bigint
  customCode: number | null
  failed: boolean
  blockTimeMs: number | null
  /** This transaction opened the delegation account (its lamports went from 0 to more). */
  opened: boolean
}

export interface GuardChain {
  list(owner: string): Promise<DelegationView[]>
  /** Newest first, strictly after `until` when given. */
  signatures(pda: string, until: string | null): Promise<string[]>
  effect(signature: string, owner: string, mint: string, pda: string): Promise<TxEffect>
}

/** With `scans`, every good scan also refreshes the permission list's last good copy. */
export function rpcGuardChain(rpc: Rpc, scans?: DelegationScans): GuardChain {
  return {
    list: (owner) => (scans ? scans.fresh(owner) : listDelegations(rpc, owner as Address)),
    async signatures(pda, until) {
      const r = await rpc
        .getSignaturesForAddress(pda as Address, {
          limit: 50,
          ...(until ? { until: until as never } : {}),
          commitment: 'confirmed',
        })
        .send()
      return r.map((s) => s.signature as string)
    },
    async effect(signature, owner, mint, pda) {
      const tx = await rpc
        .getTransaction(signature as never, {
          maxSupportedTransactionVersion: 0,
          encoding: 'json',
          commitment: 'confirmed',
        })
        .send()
      if (!tx) throw new Error(`transaction ${signature} not found yet`)
      const bal = (
        list: readonly { owner?: string; mint: string; uiTokenAmount: { amount: string } }[] | null | undefined,
      ) =>
        (list ?? [])
          .filter((b) => b.owner === owner && b.mint === mint)
          .reduce((s, b) => s + BigInt(b.uiTokenAmount.amount), 0n)
      const meta = tx.meta as unknown as {
        err: unknown
        preTokenBalances?: { owner?: string; mint: string; uiTokenAmount: { amount: string } }[]
        postTokenBalances?: { owner?: string; mint: string; uiTokenAmount: { amount: string } }[]
        preBalances?: (number | bigint)[]
        postBalances?: (number | bigint)[]
        loadedAddresses?: { writable?: string[]; readonly?: string[] }
      } | null
      // Balances line up with the static keys, then the looked-up writable and readonly ones.
      const keys = [
        ...((tx.transaction as unknown as { message: { accountKeys: string[] } }).message.accountKeys ?? []),
        ...(meta?.loadedAddresses?.writable ?? []),
        ...(meta?.loadedAddresses?.readonly ?? []),
      ]
      const i = keys.indexOf(pda)
      const opened =
        i >= 0 && !meta?.err && BigInt(meta?.preBalances?.[i] ?? 0) === 0n && BigInt(meta?.postBalances?.[i] ?? 0) > 0n
      return {
        opened,
        signature,
        delta: bal(meta?.postTokenBalances) - bal(meta?.preTokenBalances),
        customCode: customCodeOf(meta?.err),
        failed: Boolean(meta?.err),
        blockTimeMs: tx.blockTime ? Number(tx.blockTime) * 1000 : null,
      }
    },
  }
}

export interface GuardOptions {
  store: MandateStore
  chain: GuardChain
  receipts: Receipts
  log: Logger
  /** Wallets to watch: every address with a registered device or a mandate. */
  addresses: () => string[]
  /** Symbol/decimals for a mint; unknown mints are shown by address. */
  mintInfo: (mint: string) => { symbol: string; decimals: number }
  /** A pending permission was found live on chain and activated (the executor can pull at once). */
  onActivated?: () => void
  now?: () => number
}

export class Guard {
  private readonly now: () => number
  private running = false
  constructor(private readonly o: GuardOptions) {
    this.now = o.now ?? Date.now
  }

  async tick(): Promise<{ address: string; events: number; error?: string }[]> {
    if (this.running) return []
    this.running = true
    const out: { address: string; events: number; error?: string }[] = []
    try {
      for (const address of new Set(this.o.addresses())) {
        try {
          out.push({ address, events: await this.scan(address) })
        } catch (e) {
          this.o.log.warn('guard_scan_failed', { address, error: safeError(e) })
          out.push({ address, events: 0, error: safeError(e) })
        }
      }
    } finally {
      this.running = false
    }
    return out
  }

  private base(d: DelegationView) {
    const mandate = this.o.store.getMandateByPda(d.address)
    const info = d.mint ? this.o.mintInfo(d.mint) : { symbol: '?', decimals: 0 }
    return {
      delegationPda: d.address,
      delegatee: d.delegatee,
      label: mandate?.label || null,
      decimals: info.decimals,
      symbol: info.symbol,
      actor: (mandate ? 'nuntius' : 'other') as 'nuntius' | 'other',
    }
  }

  /** Scans one wallet; returns the number of new receipts. */
  async scan(address: string): Promise<number> {
    const baselineKey = `baseline:${address}`
    const firstScan = !this.o.store.hasGuardCursor(baselineKey)
    const live = await this.o.chain.list(address)
    const livePdas = new Set(live.map((d) => d.address as string))
    let emitted = 0

    // Disappeared since the last scan → revoked (or closed by expiry cleanup).
    for (const pda of this.o.store.guardedPdas(address)) {
      if (pda.startsWith('baseline:') || livePdas.has(pda)) continue
      const mandate = this.o.store.getMandateByPda(pda)
      const memory = this.o.store.guardMemory(pda)
      const info = mandate
        ? { symbol: mandate.symbol, decimals: mandate.decimals }
        : memory.mint
          ? this.o.mintInfo(memory.mint)
          : { symbol: '?', decimals: 0 }
      if (
        await this.o.receipts.emit(address, {
          kind: 'revoked',
          at: this.now(),
          delegationPda: pda,
          delegatee: mandate?.delegatee ?? memory.delegatee ?? 'unknown',
          label: mandate?.label || null,
          amountBaseUnits: null,
          ...info,
          signature: `revoked:${pda}`,
          actor: mandate ? 'nuntius' : 'other',
        })
      ) {
        emitted++
      }
      this.o.store.dropGuardCursor(pda)
    }

    for (const d of live) {
      // A grant that landed while the app never confirmed it: the wallet answered
      // with an error after sending (device round 6, 5 Oct), or the app was closed.
      // The chain is the record, on the same exact match as /api/mandates/confirm;
      // without this, the stale-pending sweep would later forget a live permission.
      const pending = this.o.store.getMandateByPda(d.address)
      if (pending?.status === 'pending' && pending.address === address && termsMatch(pending, d)) {
        this.o.store.setStatus(pending.id, 'active', this.now())
        this.o.log.info('mandate_activated_from_chain', { id: pending.id, pda: d.address })
        this.o.onActivated?.()
      }
      const known = this.o.store.hasGuardCursor(d.address)
      const b = this.base(d)
      if (!known) {
        if (firstScan) {
          // Baseline: remember where history ends, say nothing.
          const [newest] = await this.o.chain.signatures(d.address, null)
          this.o.store.setGuardCursor(d.address, address, newest ?? null, this.now(), d)
          continue
        }
        if (
          await this.o.receipts.emit(address, {
            kind: 'granted',
            at: this.now(),
            ...b,
            amountBaseUnits: d.amountPerPeriod ?? d.amount,
            signature: `granted:${d.address}`,
          })
        ) {
          emitted++
        }
        this.o.store.setGuardCursor(d.address, address, null, this.now(), d)
      }
      emitted += await this.activity(address, d, b, !known)
    }
    if (firstScan) this.o.store.setGuardCursor(baselineKey, address, null, this.now())
    return emitted
  }

  /**
   * Receipts for what happened on a delegation since the cursor. For one seen
   * for the first time there is no cursor, and the address's history may hold
   * an earlier account at the same address: the same delegator, delegatee and
   * seed give the same PDA. 30 Sep: a new permission's PDA had existed on 22
   * Sep, and its old pulls and refusals went out as six new pushes. So history
   * starts at the transaction that opened the current account; everything
   * before it belongs to the old one.
   */
  private async activity(
    address: string,
    d: DelegationView,
    b: ReturnType<Guard['base']>,
    firstSeen: boolean,
  ): Promise<number> {
    if (!d.mint) return 0
    const mint = d.mint
    const cursor = this.o.store.guardCursor(d.address)
    const sigs = await this.o.chain.signatures(d.address, cursor)
    if (sigs.length === 0) return 0
    // Newest first from the chain; for a first sighting, stop at the opening.
    const fresh: { sig: string; fx: TxEffect }[] = []
    for (const sig of sigs) {
      const fx = await this.o.chain.effect(sig, address, mint, d.address)
      fresh.push({ sig, fx })
      if (firstSeen && fx.opened) break
    }
    let emitted = 0
    // A backing's debits are its buys, and the executor writes the receipt for each one it sends:
    // a pull receipt here would be a second receipt (and push) for the same transaction.
    const own = this.o.store.getMandateByPda(d.address)
    const backed = own ? this.o.store.backingOf(own.id) !== null : false
    // Oldest first, so receipts arrive in the order things happened.
    for (const { sig, fx } of fresh.reverse()) {
      let kind: 'pull' | 'refused' | null = null
      if (fx.failed && fx.customCode === ERR.AmountExceedsPeriodLimit) kind = 'refused'
      else if (!fx.failed && fx.delta < 0n && !backed) kind = 'pull'
      if (kind) {
        const cap = d.amountPerPeriod ? BigInt(d.amountPerPeriod) : undefined
        // Remaining as the program would compute it now (the stored counter is stale after a roll).
        const w =
          cap !== undefined && d.currentPeriodStartTs !== null && d.periodLengthS !== null
            ? effectiveWindow(
                {
                  amountPerPeriod: cap,
                  amountPulledInPeriod: BigInt(d.amountPulledInPeriod ?? '0'),
                  currentPeriodStartTs: BigInt(d.currentPeriodStartTs),
                  periodLengthS: BigInt(d.periodLengthS),
                  expiryTs: BigInt(d.expiryTs ?? 0),
                },
                BigInt(Math.floor(this.now() / 1000)),
              )
            : null
        if (
          await this.o.receipts.emit(
            address,
            {
              kind,
              at: fx.blockTimeMs ?? this.now(),
              ...b,
              amountBaseUnits: kind === 'pull' ? (-fx.delta).toString() : null,
              signature: sig,
            },
            {
              capBaseUnits: cap,
              remainingBaseUnits: w?.remaining,
              nextResetTs: w ? Number(w.nextResetTs) : undefined,
              periodLengthS: d.periodLengthS ?? undefined,
            },
          )
        ) {
          emitted++
        }
      }
      this.o.store.setGuardCursor(d.address, address, sig, this.now())
    }
    return emitted
  }
}

export function startGuard(guard: Guard, intervalMs: number): () => void {
  const handle = setInterval(() => void guard.tick(), intervalMs)
  return () => clearInterval(handle)
}
