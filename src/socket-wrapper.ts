import type { Socket } from 'net'
import type { Buffer } from 'buffer'

//**Wraps a TCP socket with the WebSocket API */
class SocketWrapper {
  public onopen?: () => void
  public onclose?: () => void
  public onerror?: (error: { message: string }) => void
  public onmessage?: (event: { data: ArrayBuffer }) => void
  public send: (message: Buffer) => void
  public close: () => void

  constructor(connection: string, socket: Socket) {
    socket.on('connect', () => {
      this.onopen && this.onopen()
    })

    socket.on('close', () => {
      this.onclose && this.onclose()
    })

    socket.on('error', (error) => {
      this.onerror && this.onerror(error)
    })

    socket.on('data', (data) => {
      this.onmessage && this.onmessage({ data })
    })

    this.send = (message: Buffer) => {
      socket.write(message)
    }

    this.close = () => {
      socket.removeAllListeners()
      socket.destroy()
    }

    const url = new URL(connection)
    const { host } = url
    const [nodeIP, port] = host.split(':')

    socket.connect(parseInt(port), nodeIP)
  }
}

export default SocketWrapper
