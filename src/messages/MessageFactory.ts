import { InitMessage } from './InitMessage'
import { IWireMessage } from './IWireMessage'
import { PingMessage } from './PingMessage'
import { PongMessage } from './PongMessage'
import { MessageType } from '../types'
import { CommandoMessage } from './CommandoMessage'

export function deserialize(buffer: Buffer, len?: number): IWireMessage | { type: number } {
  const type = buffer.readUInt16BE(0)

  switch (type) {
    case MessageType.Init:
      return InitMessage.deserialize(buffer)
    case MessageType.Ping:
      return PingMessage.deserialize(buffer)
    case MessageType.Pong:
      return PongMessage.deserialize(buffer)
    case MessageType.CommandoResponse:
      return CommandoMessage.deserialize(buffer, len)
  }

  return { type }
}
