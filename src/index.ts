import { BehaviorSubject, firstValueFrom, Observable, Subject, timer } from 'rxjs'
import { filter, map, skip, takeUntil } from 'rxjs/operators'
import { Buffer } from 'buffer'
import { createRandomPrivateKey } from './crypto'
import { NoiseState } from './noise-state'
import { validateInit } from './validation'
import { deserialize } from './messages/MessageFactory'
import { IWireMessage } from './messages/IWireMessage'
import { BufferWriter } from './messages/buf'
import { CommandoMessage } from './messages/CommandoMessage'
import { PongMessage } from './messages/PongMessage'
import { PingMessage } from './messages/PingMessage'

import {
  LnWebSocketOptions,
  HANDSHAKE_STATE,
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
  public commandoMsgs$: Observable<JsonRpcSuccessResponse | JsonRpcErrorResponse>
  public Buffer: BufferConstructor

  private _handshakeState: HANDSHAKE_STATE
  private _decryptedMsgs$: Subject<Buffer>
  private _commandoMsgs$: Subject<CommandoMessage>
  private _multiPartMsg: { len: number; data: Buffer } | null
  private _partialCommandoMsg: Buffer | null
  private _attemptedReconnects: number
  private _logger: Logger | void
  private _disconnected: boolean

  constructor(options: LnWebSocketOptions) {
    validateInit(options)

    const { remoteNodePublicKey, wsProxy, privateKey, ip, port = 9735, logger } = options

    const ls = Buffer.from(privateKey || createRandomPrivateKey(), 'hex')
    const es = Buffer.from(createRandomPrivateKey(), 'hex')

    this.noise = new NoiseState({
      ls,
      es
    })

    this.remoteNodePublicKey = remoteNodePublicKey
    this.publicKey = this.noise.lpk.toString('hex')
    this.privateKey = ls.toString('hex')
    this.wsUrl = wsProxy ? `${wsProxy}/${ip}:${port}` : `wss://${remoteNodePublicKey}@${ip}:${port}`
    this.connected$ = new BehaviorSubject<boolean>(false)
    this.connecting = false
    this.Buffer = Buffer

    this._handshakeState = HANDSHAKE_STATE.INITIATOR_INITIATING
    this._decryptedMsgs$ = new Subject()
    this.decryptedMsgs$ = this._decryptedMsgs$.asObservable()
    this._commandoMsgs$ = new Subject()
    this.commandoMsgs$ = this._commandoMsgs$.asObservable().pipe(map(({ response }) => response))

    this._multiPartMsg = null
    this._partialCommandoMsg = null
    this._attemptedReconnects = 0
    this._logger = logger
  }

  async connect(): Promise<boolean> {
    if (this.connected$.getValue()) return true

    this._log('info', `Initiating connection to node ${this.remoteNodePublicKey}`)
    this.connecting = true
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
      this._log('info', 'WebSocket is closed')
      this.connected$.next(false)

      if (this._attemptedReconnects < DEFAULT_RECONNECT_ATTEMPTS && !this._disconnected) {
        this._log('info', 'Waiting to reconnect')
        await new Promise((resolve) => setTimeout(resolve, this._attemptedReconnects * 1000))
        this.connect()
      }
    }

    this.socket.onerror = (err) => {
      this._log('error', `WebSocket error: ${JSON.stringify(err)}`)
    }

    this.socket.onmessage = this.handleMessage.bind(this)

    return firstValueFrom(this.connected$.pipe(skip(1)))
  }

  disconnect() {
    this._log('info', 'Manually disconnecting from WebSocket')
    this._disconnected = true
    this.socket && this.socket.close()
    this.socket = null
  }

  async handleMessage(ev: MessageEvent) {
    try {
      const { data } = ev as { data: ArrayBuffer }
      let message = Buffer.from(data)

      this._log('info', `Received a message of length: ${message.length} bytes`)

      switch (this._handshakeState) {
        case HANDSHAKE_STATE.INITIATOR_INITIATING:
          this._log('error', 'Received data before intialised')

        case HANDSHAKE_STATE.AWAITING_RESPONDER_REPLY: {
          if (data.byteLength !== 50) {
            this._log('error', 'Invalid message received from remote node')
            return
          }

          // process reply
          this._log('info', 'Validating message as part of Act2')
          await this.noise.initiatorAct2(message)

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
          break
        }

        case HANDSHAKE_STATE.READY: {
          const LEN_CIPHER_BYTES = 2
          const LEN_MAC_BYTES = 16

          let len

          try {
            this._log('info', 'Decrypting message length')
            len = await this.noise.decryptLength(
              message.subarray(0, LEN_CIPHER_BYTES + LEN_MAC_BYTES)
            )
            this._log('info', `Message length: ${len} bytes`)

            if (len > data.byteLength) {
              // this means that the message is in multiple parts so cache it
              this._log('info', 'Message is first part of multi part message, so caching it')
              this._multiPartMsg = {
                len,
                data: message
              }

              return
            }
          } catch (error) {
            this._log('info', 'Received another part of a multipart message')
            // got another part of the multipart message since we cannot decrypt the length
            if (this._multiPartMsg) {
              this._log('info', 'Joining data parts')
              this._multiPartMsg.data = Buffer.concat([this._multiPartMsg.data, message])

              if (this._multiPartMsg.data.length >= this._multiPartMsg.len) {
                this._log('info', 'Complete message has been assembled')
                // we have the complete message
                message = this._multiPartMsg.data
                len = this._multiPartMsg.len

                this._multiPartMsg = null
              } else {
                return
              }
            } else {
              this._log(
                'warn',
                'Received a part of a message, but no message is cached to concat it to.'
              )
              return
            }
          }

          this._log('info', 'Decrypting message')
          let decrypted = await this.noise.decryptMessage(message.subarray(18, 18 + len + 16))
          const type = decrypted.readUInt16BE()

          const [typeName] = Object.entries(MessageType).find(([name, val]) => val === type) || []

          this._log('info', `Message type is: ${typeName || 'unknown'}`)

          if (type === MessageType.CommandoResponseContinues) {
            this._log(
              'info',
              'Received a partial commando message, caching it to join with other parts'
            )
            this._partialCommandoMsg = decrypted
            return
          }

          if (type === MessageType.CommandoResponse && this._partialCommandoMsg) {
            this._log(
              'info',
              'Received a final commando msg and we have a partial message to join it to. Joining now'
            )
            // join commando msg chunks
            decrypted = Buffer.concat([this._partialCommandoMsg, decrypted])
            this._partialCommandoMsg = null
          }

          // deserialise
          this._log('info', 'Deserialising payload')
          const payload = deserialize(decrypted, len)

          switch (payload.type) {
            case MessageType.Init: {
              this._log('info', 'Constructing Init message reply')
              const reply = await this.noise.encryptMessage((payload as IWireMessage).serialize())

              if (this.socket) {
                this._log('info', 'Sending Init message reply')
                this.socket.send(reply)
                this._log('info', 'Connected and ready to send messages!')
                this.connecting = false
                this._disconnected = false
                this._attemptedReconnects = 0
                this.connected$.next(true)
                this._startPingMessages()
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

            default:
              this._decryptedMsgs$.next(decrypted)
          }
        }
      }
    } catch (error) {
      this._log('error', `Error handling incoming message: ${(error as Error).message}`)
    }
  }

  async commando({
    method,
    params = [],
    rune
  }: JsonRpcRequest & { rune: string }): Promise<JsonRpcSuccessResponse['result']> {
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

    // create random id to match request with response
    const idBytes = Buffer.allocUnsafe(8)
    const id = window.crypto.getRandomValues(idBytes)
    const idHex = id.toString('hex')

    // write the type
    writer.writeUInt16BE(MessageType.CommandoRequest)

    // write the id
    writer.writeBytes(id)

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
        this._commandoMsgs$.pipe(filter((commandoMsg) => commandoMsg.id === idHex))
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

  /** Sends ping messages to ensure connection is open */
  _startPingMessages() {
    timer(30000, 30000)
      .pipe(takeUntil(this.connected$.pipe(filter((x) => !x))))
      .subscribe(async () => {
        this._log('info', 'Creating Ping message')

        const message = await this.noise.encryptMessage(new PingMessage().serialize())

        if (this.socket) {
          this._log('info', 'Sending Ping message')
          this.socket.send(message)
        }
      })
  }
}

export default LnMessage
