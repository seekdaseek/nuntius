import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { getBase64Decoder } from '@solana/kit'
import { useMobileWallet } from '@wallet-ui/react-native-kit'
import { getSiwsPayload, postSiwsVerify, postVerifySeeker } from '@/features/account/nuntius-api'

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
    queryFn: () => null,
    staleTime: Infinity,
    gcTime: Infinity,
  })
  return data ?? null
}

export function useSignInMutation() {
  const { signIn } = useMobileWallet()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (): Promise<NuntiusAuth> => {
      // 1. Backend issues the payload — single-use nonce, issuedAt, expirationTime.
      const payload = await getSiwsPayload()

      // 2. Sign the payload untouched. No address: the wallet picks the account in
      // the same prompt, and connecting first is not required.
      const output = await signIn(payload)

      if (__DEV__) {
        // Dev-only probe: the exact text Seed Vault signed, to confirm the
        // backend-issued nonce/issuedAt/expirationTime survive into the message.
        console.log(`SIWS signed message:\n${bytesToUtf8(output.signedMessage)}`)
      }

      // 3. Verify server-side. Read the account from the returned result — the
      // hook's `account` is not updated until the next render.
      const base64 = getBase64Decoder()
      const { address, session } = await postSiwsVerify(payload.nonce, {
        address: output.account.addressBase64,
        signed_message: base64.decode(output.signedMessage),
        signature: base64.decode(output.signature),
      })

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
    onSuccess: (auth) => queryClient.setQueryData(AUTH_QUERY_KEY, auth),
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
    onSuccess: (auth) => queryClient.setQueryData(AUTH_QUERY_KEY, auth),
  })
}

export function useSignOut() {
  const { disconnect } = useMobileWallet()
  const queryClient = useQueryClient()

  return async () => {
    queryClient.setQueryData(AUTH_QUERY_KEY, null)
    await disconnect()
  }
}

function bytesToUtf8(bytes: Uint8Array): string {
  let text = ''
  for (const byte of bytes) {
    text += String.fromCharCode(byte)
  }
  return text
}
