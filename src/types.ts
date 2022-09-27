export type LnWebSocketOptions = {
  /**
   * 33-byte hex remote compressed public key.
   * The identity of the node you would like to initiate a connection with
   */
  remoteNodePublicKey: string
  /**
   * The IP address of the remote node
   */
  ip: string
  /**
   * The port of the remote node. Defaults to 9735
   */
  port: number
  /**
   * A WebSocket proxy endpoint for the browser to connect to,
   * so that a server can create a direct connection to the node without the need for a tls certificate runnning on the remote node
   * or if the Lightning node implementation does not support WebSocket connections directly
   * Checkout https://github.com/clams-tech/lnsocket-proxy and https://github.com/jb55/ln-ws-proxy
   */
  wsProxy?: string
  /**
   * 32 byte hex encoded private key to be used as the local node secret.
   * Use this to ensure a consistent local node identity across connection sessions
   */
  privateKey?: string
}

export type NoiseStateOptions = {
  /**
   * Local private key as a 32-byte buffer
   */
  ls: Buffer

  /**
   * Ephemeral private key as a 32-byte
   */
  es: Buffer
}

export enum MessageTypes {
  INIT = '0010',
  PING = '0012',
  PONG = '0013',
  COMMANDO_RESPONSE = '594d'
}

/**
 * States that the handshake process can be in. States depend on
 * whether the socket is the connection Initiator or Responder.
 *
 * Initiator:
 *   1.  create and send Iniatitor act1 and transition to
 *       AWAITING_RESPONDER_REPLY
 *   2.  process the Responder's reply as act2
 *   3.  create Initiator act3 reply to complete the handshake
 *       and transitions to READY
 *
 * Responder:
 *   1.  begins in AWAITING_INITIATOR waiting to receive act1
 *   2.  processes act1 and creates a reply as act2 and transitions
 *       to AWAITING_INITIATOR_REPLY
 *   3.  processes the Initiator's reply to complete the handshake
 *       and transition to READY
 */
export enum HANDSHAKE_STATE {
  /**
   * Initial state for the Initiator. Initiator will transition to
   * AWAITING_RESPONDER_REPLY once act1 is completed and sent.
   */
  INITIATOR_INITIATING = 0,

  /**
   * Responders begin in this state and wait for the Intiator to begin
   * the handshake. Sockets originating from the NoiseServer will
   * begin in this state.
   */
  AWAITING_INITIATOR = 1,

  /**
   * Initiator has sent act1 and is awaiting the reply from the responder.
   * Once received, the intiator will create the reply
   */
  AWAITING_RESPONDER_REPLY = 2,

  /**
   * Responder has  sent a reply to the inititator, the Responder will be
   * waiting for the final stage of the handshake sent by the Initiator.
   */
  AWAITING_INITIATOR_REPLY = 3,

  /**
   * Responder/Initiator have completed the handshake and we're ready to
   * start sending and receiving over the socket.
   */
  READY = 100
}
