import { BehaviorSubject, firstValueFrom, Observable, Subject } from 'rxjs'
import { filter, map, skip } from 'rxjs/operators'
import { Buffer } from 'buffer'
import { createRandomPrivateKey } from './crypto.js'
import { NoiseState } from './noise-state.js'
import { validateInit } from './validation.js'
import { deserialize } from './messages/MessageFactory.js'
import { IWireMessage } from './messages/IWireMessage.js'
import { BufferReader, BufferWriter } from './messages/buf.js'
import { CommandoMessage } from './messages/CommandoMessage.js'
import { PongMessage } from './messages/PongMessage.js'
import { PingMessage } from './messages/PingMessage.js'

import {
  LnWebSocketOptions,
  HANDSHAKE_STATE,
  READ_STATE,
  MessageType,
  JsonRpcRequest,
  JsonRpcSuccessResponse,
  JsonRpcErrorResponse,
  Logger
} from './types'

const DEFAULT_RECONNECT_ATTEMPTS = 5

class LnMessage {
  public noise: NoiseState
  public remoteNodePublicKey: string
  public publicKey: string
  public privateKey: string
  public wsUrl: string
  public socket: WebSocket | null
  public connected$: BehaviorSubject<boolean>
  public connecting: boolean
  public decryptedMsgs$: Observable<Buffer>
  public commandoMsgs$: Observable<
    (JsonRpcSuccessResponse | JsonRpcErrorResponse) & { reqId: string }
  >
  public Buffer: BufferConstructor

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

    const { remoteNodePublicKey, wsProxy, privateKey, ip, port = 9735, logger } = options

    this._ls = Buffer.from(privateKey || createRandomPrivateKey(), 'hex')
    this._es = Buffer.from(createRandomPrivateKey(), 'hex')

    this.noise = new NoiseState({
      ls: this._ls,
      es: this._es
    })

    this.remoteNodePublicKey = remoteNodePublicKey
    this.publicKey = this.noise.lpk.toString('hex')
    this.privateKey = this._ls.toString('hex')
    this.wsUrl = wsProxy ? `${wsProxy}/${ip}:${port}` : `wss://${remoteNodePublicKey}@${ip}:${port}`
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
    if (this.connected$.getValue()) {
      return true
    }

    this.connecting = true
    this._log('info', `Initiating connection to node ${this.remoteNodePublicKey}`)
    this._attemptReconnect = attemptReconnect
    this._attemptedReconnects += 1
    this.socket = new WebSocket(this.wsUrl)
    this.socket.binaryType = 'arraybuffer'

    this.socket.onopen = async () => {
      this._log('info', 'WebSocket is connected')
      this._log('info', 'Creating Act1 message')
      const msg = await this.noise.initiatorAct1(Buffer.from(this.remoteNodePublicKey, 'hex'))

      if (this.socket) {
        this._log('info', 'Sending Act1 message')
        this.socket.send(msg)
        this._handshakeState = HANDSHAKE_STATE.AWAITING_RESPONDER_REPLY
      }
    }

    this.socket.onclose = async () => {
      this._log('error', 'WebSocket is closed')
      this._log('info', `Attempted reconnects: ${this._attemptedReconnects}`)

      this.connected$.next(false)

      if (this._attemptReconnect && this._attemptedReconnects < DEFAULT_RECONNECT_ATTEMPTS) {
        this.connecting = true
        this._log('info', 'Waiting to reconnect')
        await new Promise((resolve) => setTimeout(resolve, (this._attemptedReconnects || 1) * 1000))
        this.connect()
      }
    }

    this.socket.onerror = (err) => {
      this._log('error', `WebSocket error: ${JSON.stringify(err)}`)
    }

    this.socket.onmessage = this.queueMessage.bind(this)

    return firstValueFrom(this.connected$.pipe(skip(1)))
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
              readMore = await this._processResponderReply()
              break
          }
        } else {
          switch (this._readState) {
            case READ_STATE.READY_FOR_LEN:
              readMore = await this._processPacketLength()
              break
            case READ_STATE.READY_FOR_BODY:
              readMore = await this._processPacketBody()
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

  private async _processResponderReply() {
    // read 50 bytes
    const data = this._messageBuffer.readBytes(50)

    if (data.byteLength !== 50) {
      throw new Error('Invalid message received from remote node')
    }

    // process reply
    this._log('info', 'Validating message as part of Act2')
    await this.noise.initiatorAct2(data)

    // create final act of the handshake
    this._log('info', 'Creating reply for Act3')
    const reply = await this.noise.initiatorAct3()

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

  private async _processPacketLength() {
    const LEN_CIPHER_BYTES = 2
    const LEN_MAC_BYTES = 16

    try {
      // Try to read the length cipher bytes and the length MAC bytes
      // If we cannot read the 18 bytes, the attempt to process the
      // message will abort.
      const lc = this._messageBuffer.readBytes(LEN_CIPHER_BYTES + LEN_MAC_BYTES)
      if (!lc) return false

      // Decrypt the length including the MAC
      const l = await this.noise.decryptLength(lc)

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

  private async _processPacketBody() {
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
      const m = await this.noise.decryptMessage(c)

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

      this._log('info', `Message type is: ${typeName || 'unknown'}`)

      if (type === MessageType.CommandoResponseContinues) {
        this._log(
          'info',
          'Received a partial commando message, caching it to join with other parts'
        )

        this._partialCommandoMsgs[requestId] = this._partialCommandoMsgs[requestId]
          ? Buffer.concat([
              this._partialCommandoMsgs[requestId],
              message.subarray(0, decrypted.byteLength - 16)
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
          const reply = await this.noise.encryptMessage((payload as IWireMessage).serialize())

          if (this.socket) {
            this._log('info', 'Sending Init message reply')
            this.socket.send(reply)
            this._log('info', 'Connected and ready to send messages!')
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
          const pong = await this.noise.encryptMessage(pongMessage)

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
  }: JsonRpcRequest & { rune: string; reqId?: string }): Promise<JsonRpcSuccessResponse['result']> {
    this._log('info', `Commando request method: ${method} params: ${JSON.stringify(params)}`)

    // not connected and not initiating a connection currently
    if (!this.connected$.getValue() && !this.connecting) {
      this._log('info', 'No socket connection, so creating one now')
      await this.connect()
    } else {
      this._log('info', 'Ensuring we have a connection before making request')
      // ensure that we are connected before making any requests
      await firstValueFrom(this.connected$.pipe(filter((connected) => connected === true)))
    }

    const writer = new BufferWriter()

    if (!reqId) {
      // create random id to match request with response
      const idBytes = Buffer.allocUnsafe(8)
      const id = window.crypto.getRandomValues(idBytes)
      reqId = id.toString('hex')
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
    const message = await this.noise.encryptMessage(writer.toBuffer())

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
