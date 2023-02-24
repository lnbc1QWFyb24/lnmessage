import { BehaviorSubject, firstValueFrom, Observable, Subject } from 'rxjs'
import { filter, map } from 'rxjs/operators'
import { Buffer } from 'buffer'
import { bytesToHex } from '@noble/hashes/utils'
import { createRandomBytes, createRandomPrivateKey } from './crypto.js'
import { NoiseState } from './noise-state.js'
import { validateInit } from './validation.js'
import { deserialize } from './messages/MessageFactory.js'
import { IWireMessage } from './messages/IWireMessage.js'
import { BufferReader, BufferWriter } from './messages/buf.js'
import { CommandoMessage } from './messages/CommandoMessage.js'
import { PongMessage } from './messages/PongMessage.js'
import { PingMessage } from './messages/PingMessage.js'
import type { WebSocket as NodeWebSocket } from 'ws'

import {
  LnWebSocketOptions,
  HANDSHAKE_STATE,
  READ_STATE,
  MessageType,
  JsonRpcSuccessResponse,
  JsonRpcErrorResponse,
  Logger,
  CommandoRequest,
  ConnectionStatus
} from './types.js'

const DEFAULT_RECONNECT_ATTEMPTS = 5

class LnMessage {
  /**The underlying Noise protocol. Can be used if you want to play around with the low level Lightning transport protocol*/
  public noise: NoiseState
  /**The public key of the node that Lnmessage is connected to*/
  public remoteNodePublicKey: string
  /**The public key Lnmessage uses when connecting to a remote node
   * If you passed in a private key when initialising,
   * this public key will be derived from it and can be used for persistent identity
   * across session connections
   */
  public publicKey: string
  /**The private key that was either passed in on init or generated automatically
   * Reuse this when reconnecting for persistent id
   */
  public privateKey: string
  /**The url that the WebSocket will connect to. It uses the wsProxy option if provided
   * or otherwise will initiate a WebSocket connection directly to the node
   */
  public wsUrl: string
  /**The WebSocket instance*/
  public socket: WebSocket | NodeWebSocket | null
  /**
   * @deprecated Use connectionStatus$ instead
   */
  public connected$: BehaviorSubject<boolean>
  /**
   * Observable that indicates the current socket connection status
   * Can be either 'connected', 'connecting', 'waiting_reconnect' or 'disconnected'.
   */
  public connectionStatus$: BehaviorSubject<ConnectionStatus>
  /**
   * @deprecated Use connectionStatus$ instead
   */
  public connecting: boolean
  /**Observable stream of decypted messages. This can be used to extend Lnmessage
   * functionality so that it can handle other Lightning message types
   */
  public decryptedMsgs$: Observable<Buffer>
  /**Obserable stream of all commando response messages*/
  public commandoMsgs$: Observable<
    (JsonRpcSuccessResponse | JsonRpcErrorResponse) & { reqId: string }
  >
  /**Node JS Buffer instance, useful if handling decrypted messages manually*/
  public Buffer: Buffer['constructor']

  private _ls: Buffer
  private _es: Buffer
  private _handshakeState: HANDSHAKE_STATE
  private _readState: READ_STATE
  private _decryptedMsgs$: Subject<Buffer>
  private _commandoMsgs$: Subject<CommandoMessage>
  private _partialCommandoMsgs: Record<string, Buffer>
  private _attemptedReconnects: number
  private _logger: Logger | void
  private _attemptReconnect: boolean
  private _messageBuffer: BufferReader
  private _processingBuffer: boolean
  private _l: number | null

  constructor(options: LnWebSocketOptions) {
    validateInit(options)

    const {
      remoteNodePublicKey,
      wsProxy,
      wsProtocol = 'wss:',
      privateKey,
      ip,
      port = 9735,
      logger
    } = options

    this._ls = Buffer.from(privateKey || createRandomPrivateKey(), 'hex')
    this._es = Buffer.from(createRandomPrivateKey(), 'hex')

    this.noise = new NoiseState({
      ls: this._ls,
      es: this._es
    })

    this.remoteNodePublicKey = remoteNodePublicKey
    this.publicKey = this.noise.lpk.toString('hex')
    this.privateKey = this._ls.toString('hex')
    this.wsUrl = wsProxy ? `${wsProxy}/${ip}:${port}` : `${wsProtocol}//${ip}:${port}`
    this.connectionStatus$ = new BehaviorSubject<ConnectionStatus>('disconnected')
    this.connected$ = new BehaviorSubject<boolean>(false)
    this.connecting = false
    this.Buffer = Buffer

    this._handshakeState = HANDSHAKE_STATE.INITIATOR_INITIATING
    this._decryptedMsgs$ = new Subject()
    this.decryptedMsgs$ = this._decryptedMsgs$.asObservable()
    this._commandoMsgs$ = new Subject()
    this.commandoMsgs$ = this._commandoMsgs$
      .asObservable()
      .pipe(map(({ response, id }) => ({ ...response, reqId: id })))

    this._partialCommandoMsgs = {}
    this._attemptedReconnects = 0
    this._logger = logger
    this._readState = READ_STATE.READY_FOR_LEN
    this._processingBuffer = false
    this._l = null

    this.decryptedMsgs$.subscribe((msg) => {
      this.handleDecryptedMessage(msg)
    })
  }

  async connect(attemptReconnect = true): Promise<boolean> {
    const currentStatus = this.connectionStatus$.value

    // already connected
    if (currentStatus === 'connected') {
      return true
    }

    // connecting so return connected status
    if (currentStatus === 'connecting') {
      return firstValueFrom(
        this.connectionStatus$.pipe(
          filter((status) => status === 'connected' || status === 'disconnected'),
          map((status) => status === 'connected')
        )
      )
    }

    this._log('info', `Initiating connection to node ${this.remoteNodePublicKey}`)
    this.connecting = true
    this.connectionStatus$.next('connecting')
    this._attemptReconnect = attemptReconnect

    this.socket = new (
      typeof window === 'undefined' ? (await import('ws')).default : window.WebSocket
    )(this.wsUrl)
    this.socket.binaryType = 'arraybuffer'

    this.socket.onopen = async () => {
      this._log('info', 'WebSocket is connected')
      this._log('info', 'Creating Act1 message')

      const msg = this.noise.initiatorAct1(Buffer.from(this.remoteNodePublicKey, 'hex'))

      if (this.socket) {
        this._log('info', 'Sending Act1 message')
        this.socket.send(msg)
        this._handshakeState = HANDSHAKE_STATE.AWAITING_RESPONDER_REPLY
      }
    }

    this.socket.onclose = async () => {
      this._log('error', 'WebSocket is closed')

      this.connectionStatus$.next('disconnected')
      this.connected$.next(false)

      if (this._attemptReconnect && this._attemptedReconnects < DEFAULT_RECONNECT_ATTEMPTS) {
        this._log('info', 'Waiting to reconnect')
        this._log('info', `Attempted reconnects: ${this._attemptedReconnects}`)

        this.connectionStatus$.next('waiting_reconnect')
        this.connecting = true

        await new Promise((resolve) => setTimeout(resolve, (this._attemptedReconnects || 1) * 1000))

        this.connect()
        this._attemptedReconnects += 1
      }
    }

    this.socket.onerror = (err: { message: string }) => {
      this._log('error', `WebSocket error: ${JSON.stringify(err)}`)
    }

    this.socket.onmessage = this.queueMessage.bind(this)

    return firstValueFrom(
      this.connectionStatus$.pipe(
        filter((status) => status === 'connected' || status === 'disconnected'),
        map((status) => status === 'connected')
      )
    )
  }

  private queueMessage(event: MessageEvent) {
    const { data } = event as { data: ArrayBuffer }
    const message = Buffer.from(data)

    const currentData =
      this._messageBuffer && !this._messageBuffer.eof && this._messageBuffer.readBytes()

    this._messageBuffer = new BufferReader(
      currentData ? Buffer.concat([currentData, message]) : message
    )

    if (!this._processingBuffer) {
      this._processingBuffer = true
      this._processBuffer()
    }
  }

  disconnect() {
    this._log('info', 'Manually disconnecting from WebSocket')

    // reset noise state
    this.noise = new NoiseState({
      ls: this._ls,
      es: this._es
    })

    this._attemptReconnect = false
    this.socket && this.socket.close()
  }

  private async _processBuffer() {
    try {
      // Loop while there was still data to process on the process
      // buffer.
      let readMore = true
      do {
        if (this._handshakeState !== HANDSHAKE_STATE.READY) {
          switch (this._handshakeState) {
            // Initiator received data before initialized
            case HANDSHAKE_STATE.INITIATOR_INITIATING:
              throw new Error('Received data before intialised')

            // Initiator Act2
            case HANDSHAKE_STATE.AWAITING_RESPONDER_REPLY:
              readMore = this._processResponderReply()
              break
          }
        } else {
          switch (this._readState) {
            case READ_STATE.READY_FOR_LEN:
              readMore = this._processPacketLength()
              break
            case READ_STATE.READY_FOR_BODY:
              readMore = this._processPacketBody()
              break
            case READ_STATE.BLOCKED:
              readMore = false
              break
            default:
              throw new Error('Unknown read state')
          }
        }
      } while (readMore)
    } catch (err) {
      // Terminate on failures as we won't be able to recovery
      // since the noise state has rotated nonce and we won't
      // be able to any more data without additional errors.
      this.disconnect()
    }

    this._processingBuffer = false
  }

  private _processResponderReply() {
    // read 50 bytes
    const data = this._messageBuffer.readBytes(50)

    if (data.byteLength !== 50) {
      throw new Error('Invalid message received from remote node')
    }

    // process reply
    this._log('info', 'Validating message as part of Act2')
    this.noise.initiatorAct2(data)

    // create final act of the handshake
    this._log('info', 'Creating reply for Act3')
    const reply = this.noise.initiatorAct3()

    if (this.socket) {
      this._log('info', 'Sending reply for act3')
      // send final handshake
      this.socket.send(reply)

      // transition
      this._handshakeState = HANDSHAKE_STATE.READY
    }

    // return true to continue processing
    return true
  }

  private _processPacketLength() {
    const LEN_CIPHER_BYTES = 2
    const LEN_MAC_BYTES = 16

    try {
      // Try to read the length cipher bytes and the length MAC bytes
      // If we cannot read the 18 bytes, the attempt to process the
      // message will abort.
      const lc = this._messageBuffer.readBytes(LEN_CIPHER_BYTES + LEN_MAC_BYTES)
      if (!lc) return false

      // Decrypt the length including the MAC
      const l = this.noise.decryptLength(lc)

      // We need to store the value in a local variable in case
      // we are unable to read the message body in its entirety.
      // This allows us to skip the length read and prevents
      // nonce issues since we've already decrypted the length.
      this._l = l

      // Transition state
      this._readState = READ_STATE.READY_FOR_BODY

      // return true to continue reading
      return true
    } catch (err) {
      return false
    }
  }

  private _processPacketBody() {
    const MESSAGE_MAC_BYTES = 16

    if (!this._l) return false

    try {
      // With the length, we can attempt to read the message plus
      // the MAC for the message. If we are unable to read because
      // there is not enough data in the read buffer, we need to
      // store l. We are not able to simply unshift it becuase we
      // have already rotated the keys.
      const c = this._messageBuffer.readBytes(this._l + MESSAGE_MAC_BYTES)
      if (!c) return false

      // Decrypt the full message cipher + MAC
      const m = this.noise.decryptMessage(c)

      // Now that we've read the message, we can remove the
      // cached length before we transition states
      this._l = null

      // Push the message onto the read buffer for the consumer to
      // read. We are mindful of slow reads by the consumer and
      // will respect backpressure signals.
      this._decryptedMsgs$.next(m)
      this._readState = READ_STATE.READY_FOR_LEN

      return true
    } catch (err) {
      return false
    }
  }

  async handleDecryptedMessage(decrypted: Buffer) {
    try {
      const reader = new BufferReader(decrypted)
      const type = reader.readUInt16BE()
      const [typeName] = Object.entries(MessageType).find(([name, val]) => val === type) || []
      const requestId = reader.readBytes(8).toString('hex')
      const message = reader.readBytes()

      this._log('info', `Received message type is: ${typeName || 'unknown'}`)

      if (type === MessageType.CommandoResponseContinues) {
        this._log(
          'info',
          'Received a partial commando message, caching it to join with other parts'
        )

        this._partialCommandoMsgs[requestId] = this._partialCommandoMsgs[requestId]
          ? Buffer.concat([
              this._partialCommandoMsgs[requestId],
              message.subarray(0, message.byteLength - 16)
            ])
          : decrypted.subarray(0, decrypted.length - 16)

        return
      }

      if (type === MessageType.CommandoResponse && this._partialCommandoMsgs[requestId]) {
        this._log(
          'info',
          'Received a final commando msg and we have a partial message to join it to. Joining now'
        )

        // join commando msg chunks
        decrypted = Buffer.concat([this._partialCommandoMsgs[requestId], message])
        delete this._partialCommandoMsgs[requestId]
      }

      // deserialise
      this._log('info', 'Deserialising payload')
      const payload = deserialize(decrypted)

      switch (payload.type) {
        case MessageType.Init: {
          this._log('info', 'Constructing Init message reply')
          const reply = this.noise.encryptMessage((payload as IWireMessage).serialize())

          if (this.socket) {
            this._log('info', 'Sending Init message reply')
            this.socket.send(reply)

            this._log('info', 'Connected and ready to send messages!')

            this.connectionStatus$.next('connected')
            this.connected$.next(true)
            this.connecting = false
            this._attemptedReconnects = 0
          }

          break
        }

        case MessageType.Ping: {
          this._log('info', 'Received a Ping message')
          this._log('info', 'Creating a Pong message')

          const pongMessage = new PongMessage((payload as PingMessage).numPongBytes).serialize()
          const pong = this.noise.encryptMessage(pongMessage)

          if (this.socket) {
            this._log('info', 'Sending a Pong message')
            this.socket.send(pong)
          }

          break
        }

        case MessageType.CommandoResponse: {
          this._commandoMsgs$.next(payload as CommandoMessage)
        }

        // ignore all other messages
      }
    } catch (error) {
      this._log('error', `Error handling incoming message: ${(error as Error).message}`)
    }
  }

  async commando({
    method,
    params = [],
    rune,
    reqId
  }: CommandoRequest): Promise<JsonRpcSuccessResponse['result']> {
    this._log('info', `Commando request method: ${method} params: ${JSON.stringify(params)}`)

    // not connected, so initiate a connection
    if (this.connectionStatus$.value === 'disconnected') {
      this._log('info', 'No socket connection, so creating one now')

      const connected = await this.connect()

      if (!connected) {
        throw {
          code: 2,
          message: 'Could not establish a connection to node'
        }
      }
    } else {
      this._log('info', 'Ensuring we have a connection before making request')

      // ensure that we are connected before making any requests
      await firstValueFrom(this.connectionStatus$.pipe(filter((status) => status === 'connected')))
    }

    const writer = new BufferWriter()

    if (!reqId) {
      // create random id to match request with response
      const id = createRandomBytes(8)
      reqId = bytesToHex(id)
    }

    // write the type
    writer.writeUInt16BE(MessageType.CommandoRequest)

    // write the id
    writer.writeBytes(Buffer.from(reqId, 'hex'))

    // write the request
    writer.writeBytes(
      Buffer.from(
        JSON.stringify({
          rune,
          method,
          params
        })
      )
    )

    this._log('info', 'Creating message to send')
    const message = this.noise.encryptMessage(writer.toBuffer())

    if (this.socket) {
      this._log('info', 'Sending commando message')
      this.socket.send(message)

      this._log('info', 'Message sent and awaiting response')

      const { response } = await firstValueFrom(
        this._commandoMsgs$.pipe(filter((commandoMsg) => commandoMsg.id === reqId))
      )

      const { result } = response as JsonRpcSuccessResponse
      const { error } = response as JsonRpcErrorResponse

      this._log(
        'info',
        result ? 'Successful response received' : `Error response received: ${error.message}`
      )

      if (error) throw error

      return result
    } else {
      throw new Error('No socket initialised and connected')
    }
  }

  _log(level: keyof Logger, msg: string) {
    if (this._logger && this._logger[level]) {
      this._logger[level](`[${level.toUpperCase()} - ${new Date().toLocaleTimeString()}]: ${msg}`)
    }
  }
}

export default LnMessage
