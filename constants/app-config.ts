import { AppIdentity, createSolanaDevnet, createSolanaMainnet, SolanaCluster } from '@wallet-ui/react-native-kit'

export class AppConfig {
  /**
   * Base URL of the nuntius backend. In development the Seeker reaches the Mac's
   * dev server through `adb reverse tcp:8787 tcp:8787`, so localhost is correct
   * on-device. Swap for the VPS hostname at deploy time.
   */
  static apiBase = 'http://localhost:8787'

  /**
   * MWA app identity. `uri` must be absolute (wallets may decline authorization
   * without one) and `icon` must be a path relative to `uri` or a data: URI —
   * an absolute http(s) icon URL is out of spec. Wallets verify the identity
   * via Digital Asset Links at `${uri}/.well-known/assetlinks.json`.
   */
  static identity: AppIdentity = { name: 'nuntius', uri: 'https://ochinimus.app', icon: 'favicon.ico' }

  /**
   * Mainnet goes through the backend's allowlisted RPC proxy so the Helius key
   * stays out of the app bundle. Devnet stays available for development.
   */
  static networks: SolanaCluster[] = [
    createSolanaMainnet({ url: `${AppConfig.apiBase}/api/rpc` }),
    createSolanaDevnet({ url: 'https://api.devnet.solana.com' }),
  ]
}
