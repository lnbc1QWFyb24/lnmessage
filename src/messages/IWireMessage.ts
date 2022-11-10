import { MessageType } from '../types.js'

export interface IWireMessage {
  type: MessageType
  serialize(): Buffer
}
