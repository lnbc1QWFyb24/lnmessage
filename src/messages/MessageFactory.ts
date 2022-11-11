import { IWireMessage } from './IWireMessage.js'
import { InitMessage } from './InitMessage.js'
import { PingMessage } from './PingMessage.js'
import { PongMessage } from './PongMessage.js'
import { CommandoMessage } from './CommandoMessage.js'
import { MessageType } from '../types.js'

export function deserialize(buffer: Buffer): IWireMessage | { type: number } {
  const type = buffer.readUInt16BE(0)

  switch (type) {
    case MessageType.Init:
      return InitMessage.deserialize(buffer)
    case MessageType.Ping:
      return PingMessage.deserialize(buffer)
    case MessageType.Pong:
      return PongMessage.deserialize(buffer)
    case MessageType.CommandoResponse:
    case MessageType.CommandoResponseContinues:
      return CommandoMessage.deserialize(buffer)
  }

  return { type }
}
