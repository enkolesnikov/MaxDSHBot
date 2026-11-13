/**
 * Minimal local HTTPS server for lib/transport.mjs contract tests.
 *
 * The transport client always speaks HTTPS and verifies certificates, so the
 * only way to exercise real request/response behaviour without contacting MAX
 * is a loopback HTTPS server with a throwaway self-signed certificate. The
 * certificate is generated once per test process with the system `openssl`
 * binary into a private temp dir and removed immediately afterwards; nothing
 * is written into the repository.
 *
 * When `openssl` is unavailable the helper returns `null` from
 * `loadTlsCredentials()` and the network tests skip themselves (pure-function
 * tests still run).
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import https from 'node:https'

let credentialsPromise

/**
 * Generate (once) a self-signed certificate valid for localhost/127.0.0.1.
 * @returns {Promise<{key: string, cert: string}|null>}
 */
export function loadTlsCredentials() {
  credentialsPromise ??= (async () => {
    try {
      execFileSync('openssl', ['version'], { stdio: 'ignore' })
    } catch {
      return null
    }
    const dir = mkdtempSync(join(tmpdir(), 'dsh-max-tls-'))
    const keyPath = join(dir, 'key.pem')
    const certPath = join(dir, 'cert.pem')
    try {
      execFileSync(
        'openssl',
        [
          'req', '-x509',
          '-newkey', 'rsa:2048',
          '-sha256',
          '-nodes',
          '-days', '2',
          '-keyout', keyPath,
          '-out', certPath,
          '-subj', '/CN=localhost',
          '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
          '-addext', 'basicConstraints=critical,CA:TRUE',
          '-addext', 'keyUsage=critical,keyCertSign,digitalSignature,keyEncipherment',
          '-addext', 'extendedKeyUsage=serverAuth',
        ],
        { stdio: 'ignore' },
      )
      return { key: readFileSync(keyPath, 'utf8'), cert: readFileSync(certPath, 'utf8') }
    } catch {
      return null
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })()
  return credentialsPromise
}

/**
 * Start a loopback HTTPS server on an ephemeral port.
 *
 * @param {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => unknown} handler
 * @param {{key: string, cert: string}|null} [credentials]
 * @returns {Promise<{
 *   url: string,
 *   port: number,
 *   server: import('node:https').Server,
 *   connectionCount: () => number,
 *   close: () => Promise<void>,
 * }>}
 */
export async function startHttpsServer(handler, credentials = null) {
  const creds = credentials ?? (await loadTlsCredentials())
  if (!creds) throw new Error('openssl is required to generate the local transport test certificate')
  const sockets = new Set()
  const server = https.createServer(creds, (req, res) => {
    Promise.resolve()
      .then(() => handler(req, res))
      .catch((error) => {
        if (res.headersSent) {
          res.destroy(error)
          return
        }
        res.statusCode = 500
        res.end(String(error?.stack ?? error))
      })
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const { port } = server.address()
  return {
    url: `https://localhost:${port}`,
    port,
    server,
    connectionCount: () => sockets.size,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve())
        // Download tests intentionally abort a response mid-stream.
        server.closeAllConnections?.()
      }),
  }
}

/** Collect the full request body as a Buffer. */
export function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

/** Write a JSON response (with optional extra headers). */
export function sendJson(res, status, body, headers = {}) {
  const payload = Buffer.from(JSON.stringify(body), 'utf8')
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': String(payload.length),
    ...headers,
  })
  res.end(payload)
}
