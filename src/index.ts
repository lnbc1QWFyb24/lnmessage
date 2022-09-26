// @TODO needs to use appropriate socket for when used in node.js vs the browser?
// or just make it browser based

// make it a class, this way it can easily be extended to have more functionality rather than only speaking to the node to make rpc calls

// connect to a lightning node from a browser
type LnWebSocketOptions = {
  /**
   * 33-byte hex remote compressed public key.
   * The identity of the node you would like to initiate a connection with
   */
  remoteNodePublicKey: string
  /**
   * A WebSocket proxy endpoint for the browser to connect to,
   * so that a server can create a direct connection to the node without the need for a tls certificate runnning on the remote node.
   * Checkout https://github.com/clams-tech/lnsocket-proxy and https://github.com/jb55/ln-ws-proxy
   */
  wsProxy?: string
  /**
   * 32 byte hex encoded private key to be used as the local node secret.
   * Use this to ensure a consistent local node identity across connection sessions
   */
  privateKey?: string
}

class LnWebSocket {
  constructor(options: LnWebSocketOptions) {}
}

export default LnWebSocket
