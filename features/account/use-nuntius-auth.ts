import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { getBase64Encoder } from '@solana/kit'
import { transact, useMobileWallet } from '@wallet-ui/react-native-kit'
import { getSiwsPayload, postSignOut, postSiwsVerify, postVerifySeeker } from '@/features/account/nuntius-api'
import { loadAuth, saveAuth } from '@/features/account/auth-storage'
import { saveWalletToken } from '@/features/wallet/wallet-auth-storage'

/** Backend-verified identity: SIWS session plus the Seeker gate result. */
export interface NuntiusAuth {
  address: string
  session: string
  sgtMint: string | null
}

const AUTH_QUERY_KEY = ['nuntius-auth']

export function useNuntiusAuth() {
  const { data } = useQuery<NuntiusAuth | null>({
    queryKey: AUTH_QUERY_KEY,
    // Restored from storage so a restart (or the widget) does not need a new sign-in.
    queryFn: () => loadAuth(),
    staleTime: Infinity,
    gcTime: Infinity,
  })
  return data ?? null
}

/** Stores and publishes a new auth state in one place. */
async function setAuth(queryClient: ReturnType<typeof useQueryClient>, auth: NuntiusAuth | null) {
  queryClient.setQueryData(AUTH_QUERY_KEY, auth)
  await saveAuth(auth)
}

export function useSignInMutation() {
  const { chain, identity } = useMobileWallet()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (): Promise<NuntiusAuth> => {
      // 1. Backend issues the payload — single-use nonce, issuedAt, expirationTime.
      const payload = await getSiwsPayload()

      // 2. Sign-in authorizes FRESH inside a new transact session, never passing a
      // stored auth_token: this is where the user picks the wallet. The kit's own signIn() reauthorizes with a cached token and
      // never clears it when the wallet cancels or tears down the session, so one
      // dismissed sheet — or a rotated token after a restart — bricks every later
      // sign-in until the app data is cleared. A token-free authorize always opens
      // the wallet cleanly and issues a fresh token. (Project MWA rule: authorize
      // fresh in every transact session; never reuse a stored auth_token.)
      const result = await transact(async (wallet) => wallet.authorize({ chain, identity, sign_in_payload: payload }))
      const signIn = result.sign_in_result
      if (!signIn) {
        throw new Error('Wallet did not return a sign-in result')
      }

      // sign_in_result carries the base64 wire strings directly (address,
      // signed_message, signature) — exactly what the backend verifier expects,
      // with none of the byte-array gymnastics the kit's convertSignInResult needed.
      if (__DEV__) {
        // Dev-only probe: the exact text Seed Vault signed, to confirm the
        // backend-issued nonce/issuedAt/expirationTime survive into the message.
        console.log(`SIWS signed message:\n${bytesToUtf8(getBase64Encoder().encode(signIn.signed_message))}`)
      }

      // 3. Verify server-side.
      const { address, session } = await postSiwsVerify(payload.nonce, {
        address: signIn.address,
        signed_message: signIn.signed_message,
        signature: signIn.signature,
      })
      // Later approvals pass this token back, so Seed Vault skips its wallet
      // picker and shows only the transaction (features/wallet/sign-and-send.ts).
      await saveWalletToken(address, result.auth_token).catch(() => {})

      // 4. Seeker gate. An RPC hiccup must not cost the fresh session — the
      // basic tier keeps a retry path via useVerifySeekerMutation.
      let sgtMint: string | null = null
      try {
        sgtMint = (await postVerifySeeker(session)).sgtMint
      } catch {
        sgtMint = null
      }

      return { address, session, sgtMint }
    },
    onSuccess: (auth) => setAuth(queryClient, auth),
  })
}

/** Retry the Seeker gate on an existing session (basic tier → full tier). */
export function useVerifySeekerMutation() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (auth: NuntiusAuth): Promise<NuntiusAuth> => {
      const { sgtMint } = await postVerifySeeker(auth.session)
      return { ...auth, sgtMint }
    },
    onSuccess: (auth) => setAuth(queryClient, auth),
  })
}

export function useSignOut() {
  const { disconnect } = useMobileWallet()
  const queryClient = useQueryClient()

  return async () => {
    // The server ends the session and stops this phone's pushes. Offline, the phone still
    // signs out; the server copy then lapses at its 30-day expiry.
    const current = queryClient.getQueryData<NuntiusAuth | null>(AUTH_QUERY_KEY) ?? (await loadAuth())
    if (current) await postSignOut(current.session).catch(() => {})
    await setAuth(queryClient, null)
    await saveWalletToken('', null).catch(() => {})
    queryClient.removeQueries({ queryKey: ['mandates'] })
    await disconnect()
  }
}

function bytesToUtf8(bytes: Iterable<number>): string {
  let text = ''
  for (const byte of bytes) {
    text += String.fromCharCode(byte)
  }
  return text
}

/**
 * True when the user dismissed the wallet sheet or declined, rather than a real
 * failure. MWA surfaces this as a CancellationException or one of the
 * cancelled/closed/timeout session codes; the class varies, so match on the text
 * we can see. Used only to soften the UI copy — Approach D needs no state reset,
 * because a fresh authorize is always clean.
 */
export function isUserCancellation(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase()
  return (
    message.includes('cancel') ||
    message.includes('declined') ||
    message.includes('session closed') ||
    message.includes('session_closed') ||
    message.includes('timeout')
  )
}
