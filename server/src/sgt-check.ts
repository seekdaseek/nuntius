/**
 * Diagnostic CLI for the SGT check — runs the same code the /api/verify-seeker
 * endpoint uses, but prints the intermediate evidence: every Token-2022 account
 * (mint + balance), the per-check classification of each candidate mint, and the
 * raw jsonParsed shape of anything that comes close. Distinguishes "wallet holds
 * no SGT" from "parser failed to classify an SGT-looking mint".
 *
 *   node --env-file-if-exists=.env dist/sgt-check.js <wallet-address>
 *
 * Reads HELIUS_RPC from the environment and never prints it.
 */
import { checkWalletForSgt, classifySgtMint, fetchMintAccounts, fetchToken2022Accounts } from './seeker.js'

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

const wallet = process.argv[2]
if (!wallet || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(wallet)) {
  fail('usage: node dist/sgt-check.js <wallet-address (base58)>')
}
const rpcUrl = process.env.HELIUS_RPC
if (!rpcUrl) fail('HELIUS_RPC is not set — run via: node --env-file-if-exists=.env dist/sgt-check.js <wallet>')

async function main(): Promise<void> {
  const { accounts, pages } = await fetchToken2022Accounts(rpcUrl!, wallet!)
  console.log(`wallet: ${wallet}`)
  console.log(`token-2022 accounts: ${accounts.length} (${pages} page${pages === 1 ? '' : 's'})`)
  for (const a of accounts) {
    console.log(`  mint ${a.mint}  amount ${a.amount}${a.amount === '0' ? '  (zero balance — skipped)' : ''}`)
  }

  const candidates = accounts.filter((a) => a.amount !== '0').map((a) => a.mint)
  console.log(`candidate mints (non-zero balance): ${candidates.length}`)

  const mintAccounts = await fetchMintAccounts(rpcUrl!, candidates)
  for (let i = 0; i < mintAccounts.length; i++) {
    const c = classifySgtMint(mintAccounts[i])
    console.log(
      `  ${candidates[i]}  isMint=${c.isMint} mintAuthority=${c.mintAuthorityOk} metadataPointer=${c.metadataPointerOk} groupMember=${c.groupMemberOk}`,
    )
    // Any near-miss or full match gets its raw shape printed, so a parser/shape
    // mismatch is visible instead of silently classified as "no SGT".
    if (c.mintAuthorityOk || c.metadataPointerOk || c.groupMemberOk) {
      console.log(JSON.stringify(mintAccounts[i], null, 2))
    }
  }

  const verdict = await checkWalletForSgt(rpcUrl!, wallet!)
  console.log(`verdict: ${verdict ? `SGT mint ${verdict}` : 'null (no SGT classified for this wallet)'}`)
}

main().catch((error: unknown) => {
  fail(`failed: ${error instanceof Error ? error.message : 'unknown error'}`)
})
