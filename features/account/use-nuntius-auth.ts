import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { getBase64Encoder } from '@solana/kit'
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

      // react-native-kit's convertSignInResult (4.3.0, pinned) runs the MWA base64
      // strings through TextEncoder instead of base64-decoding them, so
      // output.signedMessage / output.signature hold the base64 TEXT as bytes.
      // Reading them back as ASCII recovers the exact wire strings the wallet
      // produced. If a kit upgrade ever fixes this, the signature stops being
      // base64 text and the server rejects with 400 — loud, not silent.
      const signedMessageBase64 = bytesToUtf8(output.signedMessage)
      const signatureBase64 = bytesToUtf8(output.signature)

      if (__DEV__) {
        // Dev-only probe: the exact text Seed Vault signed, to confirm the
        // backend-issued nonce/issuedAt/expirationTime survive into the message.
        console.log(`SIWS signed message:\n${bytesToUtf8(getBase64Encoder().encode(signedMessageBase64))}`)
      }

      // 3. Verify server-side. Read the account from the returned result — the
      // hook's `account` is not updated until the next render.
      const { address, session } = await postSiwsVerify(payload.nonce, {
        address: output.account.addressBase64,
        signed_message: signedMessageBase64,
        signature: signatureBase64,
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

function bytesToUtf8(bytes: Iterable<number>): string {
  let text = ''
  for (const byte of bytes) {
    text += String.fromCharCode(byte)
  }
  return text
}
