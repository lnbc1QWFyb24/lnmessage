import { BehaviorSubject, Subject } from 'rxjs'
import { filter, take } from 'rxjs/operators'
import { createRandomPrivateKey } from './crypto'
import { NoiseState } from './noise-state'
import { HANDSHAKE_STATE, MessageTypes } from './types'
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
   * The IP address of the remote node
   */
  ip: string
  /**
   * The port of the remote node. Defaults to 9735
   */
  port: string
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
  public noise: NoiseState
  public wsUrl: string
  public socket: WebSocket
  public connected$: BehaviorSubject<boolean>
  public decryptedMessages$: Subject<Buffer>()
  private handshakeState: HANDSHAKE_STATE

  constructor(options: LnWebSocketOptions) {
    // @TODO - validate options

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
        throw new Error('Commando received data before intiialized')

      case HANDSHAKE_STATE.AWAITING_RESPONDER_REPLY: {
        if (message.length !== 50) {
          console.error('Invalid message received from remote node')
          return
        }
        console.log('initiatorAct2')
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
            console.log('RECEIVED A PING!')
            const numPongBytes = payload.readUInt16BE()
            const pong = await this.noise.encryptMessage(
              Buffer.concat([
                Buffer.from(MessageTypes.PONG, 'hex'),
                Buffer.from(numPongBytes.toString(16), 'hex'),
                Buffer.from(new Array(numPongBytes).fill(0))
              ])
            )

            console.log('sending a pong')
            this.socket.send(pong)
            break
          }

          case MessageTypes.PONG: {
            console.log('RECEIVED A PONG!')
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
