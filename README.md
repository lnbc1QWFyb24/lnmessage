# lnmessage

Talk to Lightning nodes from the Browser or NodeJS(after polyfill) apps.

## Features

- Connect to a lightning node via a WebSocket connection.
- Works in the Browser without any polyfilling.
- Works in NodeJS with a simple polyfill
- Initialise with a session secret to have a persistent node public key for the browser.
- Control a Core Lightning node via [Commando](https://lightning.readthedocs.io/lightning-commando.7.html) RPC calls.
- Automatic handling of ping messages to ensure constant connection to the node.
- Automatic decryption of all incoming messages. You can subscribe to a stream of decrypted messages and do whatever you like with them. The idea is that this library will eventually send and handle more than just init, ping and commando messages. In the mean time it can be extended pretty easily to handle any kind of Lightning messages.
- Automatic WebSocket re-connection handling.

## Installation

### Yarn

`yarn add lnmessage`

### NPM

`npm i lnmessage`

## Quickstart

```javascript
import Lnmessage from 'lnmessage'

async function connect() {
  // initialise the library
  const ln = new Lnmessage({
    // The public key of the node you would like to connect to
    remoteNodePublicKey: '02df5ffe895c778e10f7742a6c5b8a0cefbe9465df58b92fadeb883752c8107c8f',
    // Optional WebSocket proxy endpoint to connect through (see WebSocket Proxy section)
    wsProxy: 'wss://<WEBSOCKET_PROXY>',
    // The IP address of the node
    ip: '35.232.170.67',
    // The port of the node, defaults to 9735
    port: 9735,
    // Hex encoded private key string to use for the node local secret. Use this to persist the node public key across connections
    privateKey: 'd6a2eba36168cc31e97396a781a4dd46dd3648c001d3f4fde221d256e41715ea'
  })

  // initiate the connection to the remote node
  await ln.connect()

  // if you have connected to a Core Lightning node that you have a rune for....
  ln.commando({
    method: 'getinfo',
    params: [],
    rune: '<BASE64_RUNE>'
  })
}

connect()
```

## Initialisation

```typescript
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
  port?: number
  /**
   * A WebSocket proxy endpoint for the browser to connect to,
   * so that a server can create a direct connection to the node without the need for a tls certificate runnning on the remote node
   * or if the Lightning node implementation does not support WebSocket connections directly
   * Checkout https://github.com/clams-tech/lnsocket-proxy and https://github.com/jb55/ln-ws-proxy
   */
  wsProxy?: string
  /**
   * When connecting directly to a node, the protocol to use. Defaults to 'wss://'
   */
  wsProtocol?: 'ws:' | 'wss:'
  /**
   * 32 byte hex encoded private key to be used as the local node secret.
   * Use this to ensure a consistent local node identity across connection sessions
   */
  privateKey?: string
  /**
   Logger object to log info, warn, and error logs
   */
  logger?: Logger
}

const options: LnWebSocketOptions = {
  remoteNodePublicKey: '02df5ffe895c778e10f7742a6c5b8a0cefbe9465df58b92fadeb883752c8107c8f',
  wsProxy: 'wss://<WEBSOCKET_PROXY>',
  ip: '35.232.170.67',
  port: 9735,
  privateKey: 'd6a2eba36168cc31e97396a781a4dd46dd3648c001d3f4fde221d256e41715ea',
  logger: {
    info: console.log,
    warn: console.warn,
    error: console.error
  }
}

const ln = new Lnmessage(options)
```

## Connecting

```javascript
const connected = await ln.connect()

if (connected) {
  console.log('Connected and ready to send/receive messages')
}
```

## Commando RPC Requests

If you are connecting to a Core Ln node and you have a valid [rune](https://lightning.readthedocs.io/lightning-commando-rune.7.html) authentication token, you can use Lnmessage to securely call the node RPC server using the `commando` method.

```typescript
type CommandoRequest = {
  /**The RPC method you would like to call*/
  method: string
  /**The params to for the above method.
   * Can be an object with named parameters (like the -k options for the CLI)
   * or an array of ordered params. If no value is passed in it defaults to an
   * empty array
   */
  params?: unknown | unknown[]
  /**Base64 encoded rune token as outputted by the commando-rune cli command
   * If the rune does not have adequate permissions for this request an error will
   * be returned
   */
  rune: string
  /**Optional 8 byte hex encoded random string for matching the request to a response
   * Lnmessage will handle this automatically, but in some instances it is handy to know the
   * request id ahead of time
   */
  reqId?: string
}

// Basic Get Info request
const getInfoRequest: CommandoRequest = {
  method: 'getinfo',
  rune: '7jN2zKjkWlvncm_La3uZc9vLVGLu7xl9oBoun6pth7E9MA=='
}

const getInfoReponse = await ln.commando(getInfoRequest)

// Some helpers for creating a request id
function toHexString(byteArray: Uint8Array) {
  return byteArray.reduce((output, elem) => output + ('0' + elem.toString(16)).slice(-2), '')
}

function createRandomHex(length = 32) {
  const bytes = new Uint8Array(length)
  return toHexString(crypto.getRandomValues(bytes))
}

// 8 byte random hex string request id
const reqId = await createRandomHex(8)

// a request utilising the reqId param
const waitInvoiceRequest: CommandoRequest = {
  method: 'waitanyinvoice',
  params: { lastpay_index: lastPayIndex },
  rune: '7jN2zKjkWlvncm_La3uZc9vLVGLu7xl9oBoun6pth7E9MA==',
  reqId
}

const invoiceUpdate = await ln.commando(waitInvoiceRequest)
```

## API

RxJs Observables are used throughout the API and are indicated by a `$` at the end of the variable name. You do not need to use or understand RxJs to make use of these variables. Simply call the `subscribe` method on these variable and pass in a call back for all updates and then call the `unsubscribe` method on the returned object when you no longer want to receive updates.

```typescript
class Lnmessage {
  /**The underlying Noise protocol. Can be used if you want to play around with the low level Lightning transport protocol*/
  public noise: NoiseState
  /**The public key of the node that Lnmessage is connected to*/
  public remoteNodePublicKey: string
  /**The public key Lnmessage uses when connecting to a remote node
   * If you passed in a private key when initialising,
   * this public key will be derived from it and can be used for persistent identity
   * across session connections
   */
  public publicKey: string
  /**The private key that was either passed in on init or generated automatically
   * Reuse this when reconnecting for persistent id
   */
  public privateKey: string
  /**The url that the WebSocket will connect to. It uses the wsProxy option if provided
   * or otherwise will initiate a WebSocket connection directly to the node
   */
  public wsUrl: string
  /**The WebSocket instance*/
  public socket: WebSocket | null
  /**
   * Observable that indicates the current socket connection status
   * Can be either 'connected', 'connecting' or 'disconnected'.
   */
  public connectionStatus$: BehaviorSubject<ConnectionStatus>
  /**Observable stream of decypted messages. This can be used to extend Lnmessage
   * functionality so that it can handle other Lightning message types
   */
  public decryptedMsgs$: Observable<Buffer>
  /**Obserable stream of all commando response messages*/
  public commandoMsgs$: Observable<
    (JsonRpcSuccessResponse | JsonRpcErrorResponse) & { reqId: string }
  >
  /**Node JS Buffer instance, useful if handling decrypted messages manually*/
  public Buffer: BufferConstructor
  /**Connect to the remote node*/
  public connect(attemptReconnect = true): Promise<boolean>
  /**Disconnect from the remote node*/
  public disconnect(): void
  /**Commando requests*/
  public commando(request: CommandoRequest): Promise<JsonRpcSuccessResponse['result']>
}
```

## NodeJS Polyfill

Lnmessage is designed for the browser, but can be adapted to work in NodeJS apps with a simple polyfill:

1. Install `ws` dependency

**Yarn**
`yarn add ws`
`yarn add -D @types/ws`

**NPM**

`npm i ws`
`npm install --save-dev @types/ws`

2. Create a `polyfills.ts` file

```typescript
import WebSocket from 'ws'
import crypto from 'crypto'

if (!(<any>global).crypto) {
  ;(<any>global).crypto = crypto
}

if (!(<any>global).WebSocket) {
  ;(<any>global).WebSocket = WebSocket
}
```

3. Include polyfills.ts file in your tsconfig.json's includes section.
4. Import and initialise polyfills.ts at the start of your project.

## WebSocket Proxy

There are some limitations to connecting to Lightning nodes within a browser. Core Lightning nodes can be directly connected to if the [`experimental-websocket-port`](https://lightning.readthedocs.io/lightningd-config.5.html#experimental-options) option is set in the config. This will allow a direct connection to the node, but if you are running a browser app on https, then it will not allow a connection to a non SSL WebSocket endpoint, so you would need to setup SSL for your node. As far as I know LND nodes do not accept connections via WebSocket at this time.

So to simplify connecting to any Lightning node, you can go through a WebSocket proxy (see [Clams](https://github.com/clams-tech/lnsocket-proxy) and [jb55](https://github.com/jb55/ln-ws-proxy)'s WebSocket proxy server repos). Going through a proxy like this requires no trust in the server. The WebSocket connection is initated with the proxy, which then creates a regular TCP socket connection to the node. Then all messages are fully encrypted via the noise protocol, so the server only sees encrypted binary traffic that is simply proxied between the browser and the node. Currently only clearnet is supported, but I believe that the WebSocket proxy code could be modified to create a socket connection to a TOR only node to make this work.

## Current Limitations

- For Commando calls, `lnmessage` will handle matching requests with responses and in most cases this just works. For RPC calls where a large response is expected (`listinvoices`, `listpays` etc) it is recommended to `await` these calls without making other calls simultaneously. A proxy server socket connection may split the response in to multiple parts. This leads to the messages possibly getting scrambled if multiple requests are made at the same time.
- Most connections will need to be made via a WebSocket proxy server. See the WebSocket proxy section.
- Clearnet only. I am pretty sure that this will not work out of the box with TOR connections, but I still need to try it in a TOR browser to see if it works.

## Running Locally

### Install Deps

**Yarn** - `yarn`

**NPM** - `npm i`

### Build

**Yarn** - `yarn build`

**NPM** - `npm run build`

## Acknowledgments

- This library was inspired by [jb55](https://github.com/jb55)'s [lnsocket](https://github.com/jb55/lnsocket) library. Lnsocket is awesome, but I wanted something that was a bit more browser friendly and with a few more features.
- Most of the code comes from the [Node Lightning](https://github.com/altangent/node-lightning) project and has been modified to be browser friendly.
- The chacha encryption algorithm is a modified version of the [chacha](https://github.com/calvinmetcalf/chacha20poly1305) library.
