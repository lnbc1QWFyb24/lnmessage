import { BufferReader } from './buf'
import { CommandoResponse, JsonRpcErrorResponse, MessageType } from '../types'

export class CommandoMessage {
  /**
   * Processes a buffer containing the message information. This method
   * will capture the id of the commando response as well as the payload
   */
  public static deserialize(buffer: Buffer, len?: number): CommandoMessage {
    const instance = new CommandoMessage()
    const reader = new BufferReader(buffer)

    // read the type bytes
    reader.readUInt16BE()

    instance.id = reader.readBytes(8).toString('hex')
    const json = reader.readBytes(len && len - 10).toString()

    try {
      instance.response = JSON.parse(json)
    } catch (error) {
      instance.response = {
        jsonrpc: '2.0',
        id: null,
        error: { code: 1, message: 'Could not parse json response' }
      } as JsonRpcErrorResponse
    }

    return instance
  }

  public type: MessageType = MessageType.CommandoResponse
  public id: string
  public response: CommandoResponse
}
