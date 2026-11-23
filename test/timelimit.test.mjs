// node --test test/*.test.mjs
// The time limit for one delivery and the size limit for the response body. No network: a fake HTTP client, and for
// the last tests the real HTTP client on a connection that exists in memory only.
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'http'
import {Readable, Duplex} from 'stream'
import nodeFetch from 'node-fetch'
import {deliver, deliverWithin, readBody, maxResponseBytes, deliveryTimeout, timeoutText} from '../deliver.mjs'
import {createLimiter} from '../limits.mjs'

const check = async () => true
const request = {method: 'post', headers: {'content-type': 'application/json'}, body: '{}'}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

// A response of the fake HTTP client
const response = (url, {status = 200, location = null, body} = {}) => ({
  url,
  status,
  headers: {get: name => (name === 'location' ? location : null), raw: () => ({})},
  body,
})
// A body that sends a first part and then nothing more: it never ends
const stalled = () => {
  const body = new Readable({read () {}})
  body.push('first part')
  return body
}
// A body that is far over the size limit (32 MB): counts what was taken from it
const huge = 32 * 1024 * 1024
const endless = () => {
  const made = {bytes: 0}
  const body = Readable.from((async function * () {
    while (made.bytes < huge) {
      made.bytes += 64 * 1024
      yield Buffer.alloc(64 * 1024, 97)
    }
  })())
  return {body, made}
}

test('the limits: 15 seconds for one delivery, 512 KB for the response body', () => {
  assert.equal(deliveryTimeout, 15_000)
  assert.equal(maxResponseBytes, 512 * 1024)
})

test('readBody: the text of the body', async () => {
  assert.equal(await readBody(response('https://example.com/', {body: Readable.from([Buffer.from('he'), Buffer.from('llo')])})), 'hello')
  assert.equal(await readBody(response('https://example.com/', {body: Readable.from(['text ', 'parts'])})), 'text parts')
  assert.equal(await readBody(response('https://example.com/', {body: Readable.from([])})), '')
  assert.equal(await readBody(response('https://example.com/', {body: null})), '')
  assert.equal(await readBody(response('https://example.com/')), '')
  // Exactly the limit is not over the limit
  assert.equal((await readBody(response('https://example.com/', {body: Readable.from([Buffer.alloc(1000, 97)])}), {maxBytes: 1000})).length, 1000)
})

test('readBody: a body over the limit is ended at the limit, the rest is not read', async () => {
  const {body, made} = endless()
  await assert.rejects(readBody(response('https://example.com/huge', {body})), e => e.message === `content size at https://example.com/huge over limit: ${maxResponseBytes}`)
  assert.equal(body.destroyed, true)
  // Not more than the limit and what was on its way
  assert.ok(made.bytes <= maxResponseBytes + 4 * 64 * 1024, String(made.bytes))

  const small = endless()
  await assert.rejects(readBody(response('https://example.com/huge', {body: small.body}), {maxBytes: 100}), /over limit: 100$/)
  assert.equal(small.made.bytes <= 4 * 64 * 1024, true)
})

test('readBody: the signal ends a body that does not finish', async () => {
  const controller = new AbortController()
  const body = stalled()
  setTimeout(() => controller.abort(), 30)
  await assert.rejects(readBody(response('https://example.com/', {body}), {signal: controller.signal}), e => e.message === timeoutText)
  assert.equal(body.destroyed, true)

  // A signal that was used before the read: nothing is read
  const late = stalled()
  await assert.rejects(readBody(response('https://example.com/', {body: late}), {signal: controller.signal}), e => e.message === timeoutText)
  assert.equal(late.destroyed, true)
})

test('deliverWithin: an answer in time, also a slow one: code, headers and text', async () => {
  const fetch = async (url, options) => {
    await sleep(80)
    assert.equal(options.signal.aborted, false)
    return response(url, {status: 201, body: Readable.from(['{"ok":', 'true}'])})
  }
  const call = await deliverWithin('https://example.com/hook', request, {fetch, check, timeout: 2000})
  assert.equal(call.status, 201)
  assert.equal(call.text, '{"ok":true}')
  assert.equal(typeof call.headers.raw, 'function')
})

test('deliverWithin: a body that stalls after the headers ends at the time limit', async () => {
  const body = stalled()
  let signal
  const fetch = async (url, options) => { signal = options.signal; return response(url, {body}) }
  const started = Date.now()
  await assert.rejects(deliverWithin('https://example.com/hook', request, {fetch, check, timeout: 60}), e => e.timeout === true && e.message === timeoutText)
  const took = Date.now() - started
  assert.ok(took >= 50 && took < 1000, String(took))
  assert.equal(body.destroyed, true)
  assert.equal(signal.aborted, true)
})

test('deliverWithin: no answer ends at the time limit, also when the client does not stop', async () => {
  // Follows the signal, like the real client
  const follows = (url, options) => new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('stopped by the signal'))))
  await assert.rejects(deliverWithin('https://example.com/hook', request, {fetch: follows, check, timeout: 40}), e => e.timeout === true && e.message === timeoutText)

  // Does not follow the signal, and a check that does not come back
  for (const options of [{fetch: () => new Promise(() => {}), check}, {fetch: async url => response(url), check: () => new Promise(() => {})}]) {
    const started = Date.now()
    await assert.rejects(deliverWithin('https://example.com/hook', request, {...options, timeout: 40}), e => e.timeout === true)
    assert.ok(Date.now() - started < 1000)
  }
})

test('deliverWithin: a body over the limit is an error, not a time limit', async () => {
  const {body, made} = endless()
  await assert.rejects(deliverWithin('https://example.com/huge', request, {fetch: async url => response(url, {body}), check, timeout: 5000, maxBytes: 200 * 1024}), e => e.timeout === undefined && /over limit: 204800$/.test(e.message))
  assert.equal(body.destroyed, true)
  assert.ok(made.bytes <= 200 * 1024 + 4 * 64 * 1024, String(made.bytes))
})

test('deliverWithin: errors of the delivery stay as they are (refused URL, failed request)', async () => {
  await assert.rejects(deliverWithin('http://127.0.0.1/', request, {fetch: async url => response(url)}), e => e.message === 'Invalid URL' && e.timeout === undefined)
  await assert.rejects(deliverWithin('https://example.com/hook', request, {fetch: async () => { throw new Error('request failed') }, check}), e => e.message === 'request failed' && e.timeout === undefined)
})

test('deliver: the body of a redirect is ended, followed or not', async () => {
  const bodies = {a: stalled(), b: stalled(), last: Readable.from(['ok'])}
  const answers = {
    'https://example.com/a': {status: 307, location: '/b', body: bodies.a},
    'https://example.com/b': {status: 302, location: '/c', body: bodies.b},
    'https://example.com/c': {status: 200, body: bodies.last},
  }
  const call = await deliverWithin('https://example.com/a', request, {fetch: async url => response(url, answers[url]), check, protect: {}, timeout: 2000})
  assert.equal(call.text, 'ok')
  assert.deepEqual([bodies.a.destroyed, bodies.b.destroyed], [true, true])

  // A redirect to another host is refused: its body is ended too
  const refused = stalled()
  await assert.rejects(deliver('https://example.com/a', request, {fetch: async url => response(url, {status: 307, location: 'https://example.org/', body: refused}), check, protect: {}}), /redirect/)
  assert.equal(refused.destroyed, true)
})

test('time limit and limits together: a stalled body frees its place at the time limit', async () => {
  const limiter = createLimiter({total: 10, perHost: 1})
  const bodies = []
  const stalls = async url => { const body = stalled(); bodies.push(body); return response(url, {body}) }
  const answers = async url => response(url, {body: Readable.from(['ok'])})

  const started = Date.now()
  const first = limiter.run('example.com', () => deliverWithin('https://example.com/stall', request, {fetch: stalls, check, timeout: 60}))
  // Waits for the only place of this host
  const second = limiter.run('example.com', () => deliverWithin('https://example.com/hook', request, {fetch: answers, check, timeout: 60}))
  assert.deepEqual(limiter.stats(), {running: 1, waiting: 1, hosts: 1})

  await assert.rejects(first, e => e.timeout === true)
  assert.equal((await second).text, 'ok')
  assert.ok(Date.now() - started < 1000)
  assert.equal(bodies[0].destroyed, true)
  assert.deepEqual(limiter.stats(), {running: 0, waiting: 0, hosts: 0})
})

// The real HTTP client (node-fetch on the http module) on a connection in memory: answer() writes the raw response.
// No network: the connection is never a socket, and a lookup of a name fails.
const memory = answer => {
  const connections = []
  class MemoryAgent extends http.Agent {
    constructor () {
      super({lookup: (hostname, options, callback) => callback(new Error('No network in the tests'))})
    }

    createConnection () {
      let seen = ''
      let answered = false
      const connection = new Duplex({
        read () {},
        write (chunk, encoding, callback) {
          seen += chunk
          if (!answered && seen.includes('\r\n\r\n')) {
            answered = true
            answer(connection, seen)
          }
          callback()
        },
      })
      connection.destroySoon = () => connection.destroy()
      for (const method of ['setTimeout', 'setNoDelay', 'setKeepAlive', 'ref', 'unref']) connection[method] = () => connection
      connections.push(connection)
      return connection
    }
  }
  const agent = new MemoryAgent()
  return {connections, fetch: (url, options) => nodeFetch(url, {...options, agent})}
}

test('real HTTP client: an answer is read, and its connection is closed', async () => {
  const {fetch, connections} = memory(connection => connection.push('HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 2\r\n\r\nok'))
  const call = await deliverWithin('http://example.com/hook', request, {fetch, check, timeout: 2000})
  assert.equal(call.status, 200)
  assert.equal(call.text, 'ok')
  assert.deepEqual(call.headers.raw(), {'content-type': ['text/plain'], 'content-length': ['2']})
  assert.deepEqual(connections.map(c => c.destroyed), [true])
})

test('real HTTP client: headers and then a body that stalls: ended at the time limit, the connection is closed', async () => {
  const {fetch, connections} = memory(connection => connection.push('HTTP/1.1 200 OK\r\nContent-Length: 999999999\r\n\r\nfirst part'))
  const started = Date.now()
  await assert.rejects(deliverWithin('http://example.com/hook', request, {fetch, check, timeout: 100}), e => e.timeout === true && e.message === timeoutText)
  assert.ok(Date.now() - started < 1000)
  assert.deepEqual(connections.map(c => c.destroyed), [true])
})

test('real HTTP client: no answer at all: ended at the time limit, the connection is closed', async () => {
  const {fetch, connections} = memory(() => {})
  await assert.rejects(deliverWithin('http://example.com/hook', request, {fetch, check, timeout: 100}), e => e.timeout === true && e.message === timeoutText)
  assert.deepEqual(connections.map(c => c.destroyed), [true])
})

test('real HTTP client: a body far over the size limit is ended at the limit, the connection is closed', async () => {
  let sent = 0
  const {fetch, connections} = memory(connection => {
    connection.push('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n')
    const part = Buffer.alloc(64 * 1024, 97)
    const more = () => {
      if (connection.destroyed || sent >= huge) return
      connection.push('10000\r\n')
      connection.push(part)
      connection.push('\r\n')
      sent += part.length
      setImmediate(more)
    }
    more()
  })
  await assert.rejects(deliverWithin('http://example.com/huge', request, {fetch, check, timeout: 5000}), e => e.timeout === undefined && e.message === `content size at http://example.com/huge over limit: ${maxResponseBytes}`)
  assert.deepEqual(connections.map(c => c.destroyed), [true])
  assert.ok(sent <= maxResponseBytes + 1024 * 1024, String(sent))
})

test('real HTTP client: a redirect with a body that stalls is followed, both connections are closed', async () => {
  const answers = {
    '/a': 'HTTP/1.1 307 Temporary Redirect\r\nLocation: /b\r\nContent-Length: 999999999\r\n\r\nfirst part',
    '/b': 'HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok',
  }
  const {fetch, connections} = memory((connection, seen) => connection.push(answers[seen.split(' ')[1]]))
  const call = await deliverWithin('http://example.com/a', request, {fetch, check, protect: {}, timeout: 2000})
  assert.equal(call.text, 'ok')
  assert.deepEqual(connections.map(c => c.destroyed), [true, true])
})
