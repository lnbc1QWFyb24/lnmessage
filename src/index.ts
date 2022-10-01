import { BehaviorSubject, firstValueFrom, Observable, Subject } from 'rxjs'
import { filter, map, skip } from 'rxjs/operators'
import { Buffer } from 'buffer'
import { createRandomPrivateKey } from './crypto'
import { NoiseState } from './noise-state'
import { validateInit } from './validation'

import {
  LnWebSocketOptions,
  HANDSHAKE_STATE,
  MessageType,
  JsonRpcRequest,
  JsonRpcSuccessResponse,
  JsonRpcErrorResponse
} from './types'
import { deserialize } from './messages/MessageFactory'
import { IWireMessage } from './messages/IWireMessage'
import { BufferWriter } from './messages/buf'
import { CommandoMessage } from './messages/CommandoMessage'

const DEFAULT_RECONNECT_ATTEMPTS = 5

class LnConnect {
  public noise: NoiseState
  public remoteNodePublicKey: string
  public publicKey: string
  public privateKey: string
  public wsUrl: string
  public socket: WebSocket
  public connected$: BehaviorSubject<boolean>
  public decryptedMsgs$: Observable<Buffer>
  public commandoMsgs$: Observable<JsonRpcSuccessResponse | JsonRpcErrorResponse>

  private _handshakeState: HANDSHAKE_STATE
  private _decryptedMsgs$: Subject<Buffer>
  private _commandoMsgs$: Subject<CommandoMessage>
  private _multiPartMsg: { len: number; data: Buffer } | null
  private _partialCommandoMsg: Buffer | null
  private _attemptedReconnects: number

  constructor(options: LnWebSocketOptions) {
    validateInit(options)

    const { remoteNodePublicKey, wsProxy, privateKey, ip, port = 9735 } = options

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

    this._handshakeState = HANDSHAKE_STATE.INITIATOR_INITIATING
    this._decryptedMsgs$ = new Subject()
    this.decryptedMsgs$ = this._decryptedMsgs$.asObservable()
    this._commandoMsgs$ = new Subject()
    this.commandoMsgs$ = this._commandoMsgs$.asObservable().pipe(map(({ response }) => response))

    this._multiPartMsg = null
    this._partialCommandoMsg = null
    this._attemptedReconnects = 0
  }

  async connect(): Promise<boolean> {
    this._attemptedReconnects += 1
    this.socket = new WebSocket(this.wsUrl)
    this.socket.binaryType = 'arraybuffer'

    this.socket.onopen = async () => {
      const msg = await this.noise.initiatorAct1(Buffer.from(this.remoteNodePublicKey, 'hex'))
      this.socket.send(msg)
      this._handshakeState = HANDSHAKE_STATE.AWAITING_RESPONDER_REPLY
    }

    this.socket.onclose = async () => {
      this.connected$.next(false)

      if (this._attemptedReconnects < DEFAULT_RECONNECT_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, this._attemptedReconnects * 1000))
        this.connect()
      }
    }

    this.socket.onerror = (err) => console.log('Socket error:', err)
    this.socket.onmessage = this.handleMessage.bind(this)

    return firstValueFrom(this.connected$.pipe(skip(1)))
  }

  disconnect() {
    // set so that will not attempt to reconnect
    this._attemptedReconnects = DEFAULT_RECONNECT_ATTEMPTS
    this.socket && this.socket.close()
  }

  async handleMessage(ev: MessageEvent) {
    try {
      const { data } = ev as { data: ArrayBuffer }
      let message = Buffer.from(data)

      switch (this._handshakeState) {
        case HANDSHAKE_STATE.INITIATOR_INITIATING:
          throw new Error('Received data before intialised')

        case HANDSHAKE_STATE.AWAITING_RESPONDER_REPLY: {
          if (data.byteLength !== 50) {
            console.error('Invalid message received from remote node')
            return
          }

          // process reply
          await this.noise.initiatorAct2(message)

          // create final act of the handshake
          const reply = await this.noise.initiatorAct3()

          // send final handshake
          this.socket.send(reply)

          // transition
          this._handshakeState = HANDSHAKE_STATE.READY
          break
        }

        case HANDSHAKE_STATE.READY: {
          const LEN_CIPHER_BYTES = 2
          const LEN_MAC_BYTES = 16

          let len

          try {
            len = await this.noise.decryptLength(
              message.subarray(0, LEN_CIPHER_BYTES + LEN_MAC_BYTES)
            )

            if (len > data.byteLength) {
              // this means that the message is in multiple parts so cache it
              this._multiPartMsg = {
                len,
                data: message
              }

              return
            }
          } catch (error) {
            // got another part of the multipart message since we cannot decrypt the length
            if (this._multiPartMsg) {
              this._multiPartMsg.data = Buffer.concat([this._multiPartMsg.data, message])

              if (this._multiPartMsg.data.length >= this._multiPartMsg.len) {
                // we have the complete message
                message = this._multiPartMsg.data
                len = this._multiPartMsg.len

                this._multiPartMsg = null
              } else {
                return
              }
            } else {
              console.warn(
                'Received a part of a message, but no message is cached to concat it to.'
              )
              return
            }
          }

          let decrypted = await this.noise.decryptMessage(message.subarray(18, 18 + len + 16))
          const type = decrypted.readUInt16BE()

          if (type === MessageType.CommandoResponseContinues) {
            this._partialCommandoMsg = decrypted
            return
          }

          if (type === MessageType.CommandoResponse && this._partialCommandoMsg) {
            // join commando msg chunks
            decrypted = Buffer.concat([this._partialCommandoMsg, decrypted])
            this._partialCommandoMsg = null
          }

          // deserialise
          const payload = deserialize(decrypted, len)

          switch (payload.type) {
            case MessageType.Init: {
              const reply = await this.noise.encryptMessage((payload as IWireMessage).serialize())

              this.socket.send(reply)
              this.connected$.next(true)
              this._attemptedReconnects = 0
              break
            }

            case MessageType.Ping: {
              const pong = await this.noise.encryptMessage((payload as IWireMessage).serialize())

              this.socket.send(pong)
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
      console.warn('Error handling incoming message:', error)
    }
  }

  async commando({
    method,
    params = [],
    rune
  }: JsonRpcRequest & { rune: string }): Promise<JsonRpcSuccessResponse['result']> {
    if (!this.socket) {
      // no connection, so initiate and wait for connection
      await this.connect()
    } else {
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

    const message = await this.noise.encryptMessage(writer.toBuffer())
    this.socket.send(message)

    const { response } = await firstValueFrom(
      this._commandoMsgs$.pipe(filter((commandoMsg) => commandoMsg.id === idHex))
    )

    const { result } = response as JsonRpcSuccessResponse
    const { error } = response as JsonRpcErrorResponse

    if (error) throw error

    return result
  }
}

export default LnConnect
