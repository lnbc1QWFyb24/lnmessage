import { BehaviorSubject, Subject } from 'rxjs'
import { filter, take } from 'rxjs/operators'
import { createRandomPrivateKey } from './crypto'
import { NoiseState } from './noise-state'
import { LnWebSocketOptions, HANDSHAKE_STATE, MessageTypes } from './types'
import { validateInit } from './validation'

class LnWebSocket {
  public noise: NoiseState
  public wsUrl: string
  public socket: WebSocket
  public connected$: BehaviorSubject<boolean>
  public decryptedMessages$: Subject<Buffer>
  private handshakeState: HANDSHAKE_STATE

  constructor(options: LnWebSocketOptions) {
    validateInit(options)

    const { remoteNodePublicKey, wsProxy, privateKey, ip, port } = options
    const rpk = Buffer.from(remoteNodePublicKey, 'hex')
    const ls = Buffer.from(privateKey || createRandomPrivateKey(), 'hex')
    const es = Buffer.from(createRandomPrivateKey(), 'hex')

    this.noise = new NoiseState({
      ls,
      es
    })

    this.wsUrl = wsProxy ? `${wsProxy}/${ip}:${port}` : `wss://${remoteNodePublicKey}@${ip}:${port}`
    this.socket = new WebSocket(this.wsUrl)
    this.connected$ = new BehaviorSubject<boolean>(false)
    this.handshakeState = HANDSHAKE_STATE.INITIATOR_INITIATING
    this.decryptedMessages$ = new Subject<Buffer>()

    this.socket.onopen = async () => {
      const msg = await this.noise.initiatorAct1(rpk)
      this.socket.send(msg)
      this.handshakeState = HANDSHAKE_STATE.AWAITING_RESPONDER_REPLY
    }

    this.socket.onclose = () => {
      this.connected$.next(false)
      console.log('socket closed')
    }

    this.socket.onerror = (err) => console.log('Socket error:', err)
    this.socket.onmessage = this.handleMessage
  }

  async handleMessage(ev: MessageEvent) {
    const { data } = ev as { data: Blob }
    const arrayBuffer = await data.arrayBuffer()
    const message = Buffer.from(arrayBuffer)

    switch (this.handshakeState) {
      case HANDSHAKE_STATE.INITIATOR_INITIATING:
        throw new Error('Received data before intialised')

      case HANDSHAKE_STATE.AWAITING_RESPONDER_REPLY: {
        if (message.length !== 50) {
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
        this.handshakeState = HANDSHAKE_STATE.READY
        break
      }

      case HANDSHAKE_STATE.READY: {
        const LEN_CIPHER_BYTES = 2
        const LEN_MAC_BYTES = 16
        const len = await this.noise.decryptLength(
          message.subarray(0, LEN_CIPHER_BYTES + LEN_MAC_BYTES)
        )

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

            this.socket.send(reply)
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

            this.socket.send(pong)
            break
          }

          case MessageTypes.COMMANDO_RESPONSE: {
            console.log({ result: JSON.parse(payload.subarray(8).toString()) })
          }
        }

        this.decryptedMessages$.next(decrypted)
      }
    }
  }

  commando({
    method,
    params = [],
    rune
  }: {
    method: string
    params?: string[] | unknown
    rune: string
  }) {
    return new Promise((res, rej) => {
      this.connected$
        .pipe(
          filter((connected) => connected === true),
          take(1)
        )
        .subscribe(async () => {
          const msg = await this.noise.encryptMessage(
            Buffer.concat([
              Buffer.from('4c4f', 'hex'),
              Buffer.from([0, 0, 0, 0, 0, 0, 0, 0]),
              Buffer.from(JSON.stringify({ rune, method, params, id: window.crypto.randomUUID() }))
            ])
          )

          this.socket.send(msg)

          // @TODO - listen for result and resolve or reject
        })
    })
  }
}

export default LnWebSocket
