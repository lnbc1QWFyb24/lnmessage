import { BehaviorSubject, firstValueFrom, Observable, Subject } from 'rxjs'
import { filter, map, tap } from 'rxjs/operators'
import { Buffer } from 'buffer'
import { createRandomPrivateKey } from './crypto'
import { NoiseState } from './noise-state'
import { validateInit } from './validation'

import {
  LnWebSocketOptions,
  HANDSHAKE_STATE,
  MessageTypes,
  JsonRpcRequest,
  JsonRpcSuccessResponse,
  JsonRpcErrorResponse
} from './types'

class LnConnect {
  public noise: NoiseState
  public remoteNodePublicKey: string
  public publicKey: string
  public wsUrl: string
  public socket: WebSocket
  public connected$: BehaviorSubject<boolean>
  public decryptedMsgs$: Observable<{ type: string; payload: Buffer; extension: Buffer }>
  public commandoMsgs$: Observable<JsonRpcSuccessResponse | JsonRpcErrorResponse>

  private _handshakeState: HANDSHAKE_STATE
  private _decryptedMsgs$: Subject<{ type: string; payload: Buffer; extension: Buffer }>
  private _commandoResponseListeners: Subject<JsonRpcSuccessResponse | JsonRpcErrorResponse>[]
  private _multiPartMsg: { len: number; data: Buffer } | null

  constructor(options: LnWebSocketOptions) {
    validateInit(options)

    const { remoteNodePublicKey, wsProxy, privateKey, ip, port } = options

    const ls = Buffer.from(privateKey || createRandomPrivateKey(), 'hex')
    const es = Buffer.from(createRandomPrivateKey(), 'hex')

    this.noise = new NoiseState({
      ls,
      es
    })

    this.remoteNodePublicKey = remoteNodePublicKey
    this.publicKey = this.noise.lpk.toString('hex')
    this.wsUrl = wsProxy ? `${wsProxy}/${ip}:${port}` : `wss://${remoteNodePublicKey}@${ip}:${port}`
    this.connected$ = new BehaviorSubject<boolean>(false)

    this._handshakeState = HANDSHAKE_STATE.INITIATOR_INITIATING
    this._decryptedMsgs$ = new Subject()

    this.decryptedMsgs$ = this._decryptedMsgs$.asObservable()

    this.commandoMsgs$ = this.decryptedMsgs$.pipe(
      filter(({ type }) => type === MessageTypes.COMMANDO_RESPONSE),
      map(({ payload }) => JSON.parse(payload.subarray(8).toString()))
    )

    this._multiPartMsg = null

    this._commandoResponseListeners = []

    this.commandoMsgs$.subscribe((msg) => {
      const listener$ = this._commandoResponseListeners.shift()
      listener$ && listener$.next(msg)
    })
  }

  async connect(): Promise<boolean> {
    const socket = new WebSocket(this.wsUrl)
    socket.binaryType = 'arraybuffer'

    socket.onopen = async () => {
      const msg = await this.noise.initiatorAct1(Buffer.from(this.remoteNodePublicKey, 'hex'))
      socket.send(msg.buffer)
      this._handshakeState = HANDSHAKE_STATE.AWAITING_RESPONDER_REPLY
    }

    socket.onclose = () => {
      this.connected$.next(false)
      console.log('socket closed')
    }

    socket.onerror = (err) => console.log('Socket error:', err)
    socket.onmessage = this.handleMessage.bind(this)

    this.socket = socket

    return firstValueFrom(this.connected$.pipe(filter((x) => !!x)))
  }

  disconnect() {
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
          this.socket.send(reply.buffer)

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

          console.log('decrypting message')
          const decrypted = await this.noise.decryptMessage(message.subarray(18, 18 + len + 16))

          const type = decrypted.subarray(0, 2).toString('hex')
          const payload = decrypted.subarray(2, len)
          const extension = decrypted.subarray(2 + len)

          switch (type) {
            case MessageTypes.INIT: {
              const globalFeatureslength = payload.readUInt16BE()
              const localFeaturesLength = payload.readUint16BE(2 + globalFeatureslength)
              const tlvs = payload.subarray(2 + globalFeatureslength + localFeaturesLength)
              const chainHash = tlvs.subarray(4, 4 + 32).toString('hex')

              const reply = await this.noise.encryptMessage(
                Buffer.from(`00100000000580082a6aa20120${chainHash}`, 'hex')
              )

              this.socket.send(reply.buffer)
              console.log('ready to send commando messages')
              this.connected$.next(true)
              break
            }

            case MessageTypes.PING: {
              const numPongBytes = payload.readUInt16BE()
              const pong = await this.noise.encryptMessage(
                Buffer.concat([
                  Buffer.from(MessageTypes.PONG, 'hex'),
                  Buffer.from(numPongBytes.toString(16), 'hex'),
                  Buffer.from(new Array(numPongBytes).fill(0))
                ])
              )

              this.socket.send(pong.buffer)
              break
            }

            default:
              this._decryptedMsgs$.next({ type, payload, extension })
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
    const listener$ = new Subject<JsonRpcSuccessResponse | JsonRpcErrorResponse>()

    if (!this.socket) {
      await this.connect()
    } else {
      await firstValueFrom(this.connected$.pipe(filter((connected) => connected === true)))
    }

    console.log('requesting:', { method, params })

    const msg = await this.noise.encryptMessage(
      Buffer.concat([
        Buffer.from('4c4f', 'hex'),
        Buffer.from([0, 0, 0, 0, 0, 0, 0, 0]),
        Buffer.from(
          JSON.stringify({
            rune,
            method,
            params,
            id: window.crypto.randomUUID(),
            jsonrpc: '2.0'
          })
        )
      ])
    )

    this.socket.send(msg.buffer)
    this._commandoResponseListeners.push(listener$)

    const response = await firstValueFrom(listener$)

    const { result } = response as JsonRpcSuccessResponse
    const { error } = response as JsonRpcErrorResponse

    if (error) throw error

    return result
  }
}

export default LnConnect
