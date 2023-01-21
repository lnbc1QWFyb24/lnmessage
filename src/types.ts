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
  port?: number
  /**
   * A WebSocket proxy endpoint for the browser to connect to,
   * so that a server can create a direct connection to the node without the need for a tls certificate runnning on the remote node
   * or if the Lightning node implementation does not support WebSocket connections directly
   * Checkout https://github.com/clams-tech/lnsocket-proxy and https://github.com/jb55/ln-ws-proxy
   */
  wsProxy?: string
  /**
   * When connecting directly to a node, the protocol to use. Defaults to 'wss://'
   */
  wsProtocol?: 'ws:' | 'wss:'
  /**
   * 32 byte hex encoded private key to be used as the local node secret.
   * Use this to ensure a consistent local node identity across connection sessions
   */
  privateKey?: string
  /**
   Logger object to log info, warn, and error logs
   */
  logger?: Logger
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

/**
 * Defined in BOLT01
 */
export enum MessageType {
  // Setup and Control (0 - 31)
  Init = 16,
  Error = 17,
  Ping = 18,
  Pong = 19,

  // Channel (32-127)
  OpenChannel = 32,
  AcceptChannel = 33,
  FundingCreated = 34,
  FundingSigned = 35,
  FundingLocked = 36,
  Shutdown = 38,
  ClosingSigned = 39,

  // Commitment (128-255)
  //

  // Routing (256-511)
  ChannelAnnouncement = 256,
  NodeAnnouncement = 257,
  ChannelUpdate = 258,
  AnnouncementSignatures = 259,
  QueryShortChannelIds = 261,
  ReplyShortChannelIdsEnd = 262,
  QueryChannelRange = 263,
  ReplyChannelRange = 264,
  GossipTimestampFilter = 265,

  CommandoRequest = 19535,
  CommandoResponseContinues = 22859,
  CommandoResponse = 22861
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

export enum READ_STATE {
  READY_FOR_LEN = 2,
  READY_FOR_BODY = 3,
  BLOCKED = 4
}

export type JsonRpcRequest = {
  /**The RPC method you would like to call*/
  method: string
  /**The params to for the above method.
   * Can be an object with named parameters (like the -k options for the CLI)
   * or an array of ordered params. If no value is passed in it defaults to an
   * empty array
   */
  params?: unknown | unknown[]
}

type JsonRpcBaseResponse = {
  jsonrpc: string
  id: string | number | null
}

export type JsonRpcSuccessResponse = JsonRpcBaseResponse & { result: unknown }

export type JsonRpcErrorResponse = JsonRpcBaseResponse & {
  error: { code: number; message: string; data?: unknown }
}

export type CommandoRequest = JsonRpcRequest & {
  /**Base64 encoded rune token as outputted by the commando-rune cli command
   * If the rune does not have adequate permissions for this request an error will
   * be returned
   */
  rune: string
  /**Optional 8 byte hex encoded random string for matching the request to a response
   * Lnmessage will handle this automatically, but in some instances it is handy to know the
   * request id ahead of time
   */
  reqId?: string
}

export type CommandoResponse = JsonRpcSuccessResponse | JsonRpcErrorResponse

export type Logger = {
  info: (msg: string) => void
  warn: (msg: string) => void
  error: (msg: string) => void
}
