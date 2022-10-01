# lnmessage

Talk to Lightning nodes from your browser.

## Features

- Connect to a lightning node via a WebSocket connection.
- Works in the browser without any polyfilling.
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

## Examples

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
