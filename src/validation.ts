import { validPrivateKey, validPublicKey } from './crypto'
import { LnWebSocketOptions } from './types'

export function validateInit(options: LnWebSocketOptions): void {
  const { remoteNodePublicKey, wsProxy, privateKey, ip, port } = options

  if (!remoteNodePublicKey || !validPublicKey(remoteNodePublicKey)) {
    throw new Error(`${remoteNodePublicKey} is not a valid public key`)
  }

  const ipRegex = /^((25[0-5]|(2[0-4]|1\d|[1-9]|)\d)(\.(?!$)|$)){4}$/

  if (!ip || !ip.match(ipRegex)) {
    throw new Error(`${ip} is not a valid IP address`)
  }

  if (!port || port < 1 || port > 65535) {
    throw new Error(`${port} is not a valid port number`)
  }

  if (wsProxy) {
    const errMsg = `${wsProxy} is not a valid url`
    try {
      const url = new URL(wsProxy)
      if (url.protocol !== 'wss:') {
        throw new Error(errMsg)
      }
    } catch (err) {
      throw new Error(errMsg)
    }
  }

  if (privateKey && !validPrivateKey(privateKey)) {
    throw new Error(`${privateKey} is not a valid private key`)
  }
}
