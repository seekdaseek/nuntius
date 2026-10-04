import { AppIdentity, createSolanaDevnet, createSolanaMainnet, SolanaCluster } from '@wallet-ui/react-native-kit'

/** The mainnet executor (delegatee) the server signs pulls with. A public key. */
export const MAINNET_EXECUTOR = '23fstLLk5nv17NUpbsyWgEkkwHM3uKpxtvXhrLhd3SHP'

export class AppConfig {
  /**
   * Base URL of the nuntius backend. In development the Seeker reaches the Mac's
   * dev server through `adb reverse tcp:8787 tcp:8787`, so localhost is correct
   * on-device. A release build blocks cleartext, so it MUST be built with
   * EXPO_PUBLIC_API_BASE=https://<backend host> (inlined by Expo at bundle
   * time). It is a public URL, not a secret.
   */
  static apiBase = process.env.EXPO_PUBLIC_API_BASE ?? 'http://localhost:8787'

  /**
   * The nuntius executor's address: every grant must name it as delegatee, or the
   * app's transaction check refuses it before Seed Vault opens (core/tx-check.ts).
   * Defaults to the mainnet executor, the only signer of every executor pull on
   * mainnet (e.g. Ry4tiD6o…, 30 Sep 2026) and the public key the VPS executor key
   * derives to. EXPO_PUBLIC_EXECUTOR (a public key, not a secret) overrides it,
   * e.g. for a localnet build with its own delegatee.
   */
  static executor: string | null = process.env.EXPO_PUBLIC_EXECUTOR ?? MAINNET_EXECUTOR

  /**
   * MWA app identity. `uri` must be absolute (wallets may decline authorization
   * without one) and `icon` must be a path relative to `uri` or a data: URI —
   * an absolute http(s) icon URL is out of spec. Wallets verify the identity
   * via Digital Asset Links at `${uri}/.well-known/assetlinks.json`.
   */
  static identity: AppIdentity = {
    name: 'nuntius',
    // The backend's own host serves /.well-known/assetlinks.json and this icon,
    // so wallet verification needs no deploy on ochinimus.app.
    uri: 'https://nuntius.ochinimus.app',
    icon: 'identity-icon-192.png',
  }

  /**
   * Mainnet goes through the backend's allowlisted RPC proxy so the Helius key
   * stays out of the app bundle. Devnet stays available for development.
   */
  static networks: SolanaCluster[] = [
    createSolanaMainnet({ url: `${AppConfig.apiBase}/api/rpc` }),
    createSolanaDevnet({ url: 'https://api.devnet.solana.com' }),
  ]
}
