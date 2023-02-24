import { Buffer } from 'buffer'
import Chacha20 from './chacha20.js'
import Poly1305 from './poly1305.js'

class Cipher {
  private alen: number
  private clen: number
  private chacha: Chacha20
  private poly: Poly1305
  private tag: null | Buffer
  private _decrypt: boolean
  private _hasData: boolean

  constructor(key: Buffer, iv: Buffer, decrypt: boolean = false) {
    this.alen = 0
    this.clen = 0
    this.chacha = new Chacha20(key, iv)
    this.poly = new Poly1305(this.chacha.getBytes(64))
    this.tag = null
    this._decrypt = decrypt
    this._hasData = false
  }

  setAAD(aad: Buffer) {
    if (this._hasData) {
      throw new Error('Attempting to set AAD in unsupported state')
    }
    this.alen = aad.length
    this.poly.update(aad)
    const padding = Buffer.alloc(padAmount(this.alen))
    if (padding.length) {
      padding.fill(0)
      this.poly.update(padding)
    }
  }

  update(data: string | Buffer, inputEnc?: BufferEncoding, outputEnc?: BufferEncoding) {
    if (typeof data === 'string') {
      data = Buffer.from(data, inputEnc)
    }

    let outData = this._update(data) || Buffer.from('')

    return outputEnc ? outData.toString(outputEnc) : outData
  }

  final(outputEnc?: BufferEncoding) {
    let outData = this._final() || Buffer.from('')

    return outputEnc ? outData.toString(outputEnc) : outData
  }

  _update(chunk: Buffer) {
    if (!this._hasData) {
      this._hasData = true
    }

    const len = chunk.length

    if (!len) {
      return
    }

    this.clen += len
    const pad = this.chacha.getBytes(len)

    let i = -1
    while (++i < len) {
      pad[i] ^= chunk[i]
    }

    if (this._decrypt) {
      this.poly.update(chunk)
    } else {
      this.poly.update(pad)
    }

    return pad
  }

  _final() {
    if (this._decrypt && !this.tag) {
      throw new Error('Unsupported state or unable to authenticate data')
    }

    const padding = Buffer.alloc(padAmount(this.clen))

    if (padding.length) {
      padding.fill(0)
      this.poly.update(padding)
    }

    const lens = Buffer.alloc(16)
    lens.fill(0)
    lens.writeUInt32LE(this.alen, 0)
    lens.writeUInt32LE(this.clen, 8)

    const tag = this.poly.update(lens).finish()

    if (this._decrypt) {
      if (xorTest(tag, this.tag as Buffer)) {
        throw new Error('Unsupported state or unable to authenticate data')
      }
    } else {
      this.tag = tag
    }

    return tag
  }

  getAuthTag() {
    if (this._decrypt || this.tag === null) {
      return Buffer.from('')
    }
    return this.tag
  }

  setAuthTag(tag: Buffer) {
    if (this._decrypt) {
      this.tag = tag
    } else {
      throw new Error('Attempting to set auth tag in unsupported state')
    }
  }
}

function padAmount(len: number) {
  const rem = len % 16
  return rem ? 16 - rem : 0
}

function xorTest(a: Buffer, b: Buffer) {
  let out = 0

  if (a.length !== b.length) {
    out++
  }

  const len = Math.min(a.length, b.length)

  let i = -1
  while (++i < len) {
    out += a[i] ^ b[i]
  }

  return out
}

export function createDecipher(key: Buffer, iv: Buffer) {
  return new Cipher(key, iv, true)
}

export function createCipher(key: Buffer, iv: Buffer) {
  return new Cipher(key, iv)
}
