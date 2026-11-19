'use strict'

// Self-test: local server only, no external network, no real credentials.
const assert = require('node:assert')
const http = require('node:http')
const { run } = require('./main')

async function main() {
  const server = http.createServer((request, response) => {
    let raw = ''
    request.setEncoding('utf8')
    request.on('data', (chunk) => {
      raw += chunk
    })
    request.on('end', () => {
      let body = {}
      try {
        body = JSON.parse(raw || '{}')
      } catch {
        body = {}
      }
      if (request.url !== '/login') {
        response.writeHead(404).end('{}')
        return
      }
      if (body.username === 'bad-user') {
        response.writeHead(401, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ ok: false }))
        return
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ok: true }))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const baseUrl = `http://127.0.0.1:${address.port}`

  try {
    const summary = await run({
      baseUrl,
      loginPath: '/login',
      concurrency: 2,
      requestsPerSecond: 20,
      accounts: [
        { username: 'user-a', password: 'test-only-a' },
        { username: 'bad-user', password: 'test-only-b' },
        { username: 'user-c', password: 'test-only-c' },
      ],
    })
    assert.equal(summary.total, 3)
    assert.equal(summary.succeeded, 2)
    assert.equal(summary.failed, 1)
    assert.equal(summary.results[1].ok, false)
    assert.equal(summary.results[1].status, 401)
    for (const entry of summary.results) {
      assert.equal('password' in entry, false)
    }

    await assert.rejects(
      () =>
        run({
          baseUrl: 'https://example.com',
          accounts: [{ username: 'x', password: 'y' }],
        }),
      /authorized test target/,
    )
    process.stdout.write('bulk-login self-test passed\n')
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

main().catch((error) => {
  process.stderr.write(`${error && error.stack ? error.stack : String(error)}\n`)
  process.exit(1)
})
