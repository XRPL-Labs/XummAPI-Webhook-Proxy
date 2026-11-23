// node --test test/*.test.mjs
// The queue reader (reader.mjs): reads with a time limit, a connection that is made again when it gives no answer,
// every message handled once.
// First with a fake client and fake timers. Then with the real client library against a small fake Redis server on a
// local socket (it can stop answering without a close, and it can end its connections). No Redis, no database.
import test from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import {EventEmitter} from 'node:events'
import {readFile} from 'node:fs/promises'
import ioredis from 'ioredis'
import {createReader, connectionOptions, settingsFrom} from '../reader.mjs'

const CHANNEL = 'PAYLOADS_WEBHOOK'
const tick = () => new Promise(resolve => setImmediate(resolve))
const settle = async () => { for (let i = 0; i < 5; i++) await tick() }

// ---- Fake timers and clock: advance(seconds) runs what is due, in order
const fakeTime = () => {
  let now = 1_000_000
  let serial = 0
  const waiting = new Map()
  const setTimer = (fn, ms) => { waiting.set(++serial, {fn, at: now + ms}); return serial }
  const clearTimer = id => { waiting.delete(id) }
  const advance = async seconds => {
    const end = now + seconds * 1000
    await settle()
    for (;;) {
      const due = [...waiting.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0]
      if (!due) break
      waiting.delete(due[0])
      now = due[1].at
      due[1].fn()
      await settle()
    }
    now = end
    await settle()
  }
  return {setTimer, clearTimer, advance, clock: () => now, pending: () => waiting.size}
}

// ---- Fake client: the part of the client library that the reader uses. Every read waits for the test:
// answer(value) / fail(error) settle the oldest read that waits.
const fakeClient = (status = 'ready') => {
  const client = new EventEmitter()
  client.status = status
  client.reads = []
  client.disconnects = []
  client.blpop = (key, seconds) => new Promise((resolve, reject) => { client.reads.push({key, seconds, resolve, reject, done: false}) })
  const next = () => client.reads.find(r => !r.done)
  client.waiting = () => client.reads.filter(r => !r.done).length
  client.answer = async value => { const r = next(); r.done = true; r.resolve(value); await settle() }
  client.fail = async error => { const r = next(); r.done = true; r.reject(error); await settle() }
  // As the library: the connection ends, the read that waits stays (it is sent again when the client is ready)
  client.disconnect = reconnect => { client.disconnects.push(reconnect); client.status = 'reconnecting' }
  client.ready = async () => { client.status = 'ready'; client.emit('ready'); await settle() }
  return client
}

const setup = (options = {}, status = 'ready') => {
  const time = fakeTime()
  const client = fakeClient(status)
  const handled = []
  const lines = []
  const log = (...args) => { lines.push(args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')) }
  const reader = createReader({client, channel: CHANNEL, handle: message => { handled.push(message) }, timeout: 10, grace: 10, silentAfter: 300, log, clock: time.clock, setTimer: time.setTimer, clearTimer: time.clearTimer, ...options})
  return {time, client, handled, lines, reader}
}

test('settings: defaults, values from the configuration, and the options of the connection', () => {
  assert.deepEqual(settingsFrom({}), {timeout: 10, grace: 10, silentAfter: 300})
  assert.deepEqual(settingsFrom(), {timeout: 10, grace: 10, silentAfter: 300})
  assert.deepEqual(settingsFrom({QUEUE_READ_TIMEOUT: '30', QUEUE_READ_GRACE: '15', QUEUE_SILENT_MINUTES: '2'}), {timeout: 30, grace: 15, silentAfter: 120})
  // A read never waits without a limit: no 0, no text, no negative value; whole seconds
  for (const value of ['0', '-5', 'abc', '', undefined, null]) assert.equal(settingsFrom({QUEUE_READ_TIMEOUT: value}).timeout, 10, String(value))
  assert.equal(settingsFrom({QUEUE_READ_TIMEOUT: '0.2'}).timeout, 1)
  assert.equal(settingsFrom({QUEUE_READ_TIMEOUT: '12.6'}).timeout, 13)

  assert.deepEqual(connectionOptions({}), {keepAlive: 15_000, connectTimeout: 10_000, autoResendUnfulfilledCommands: true, maxRetriesPerRequest: null})
  assert.equal(connectionOptions({REDIS_KEEPALIVE: '30'}).keepAlive, 30_000)
  for (const value of ['0', '-1', 'abc']) assert.equal(connectionOptions({REDIS_KEEPALIVE: value}).keepAlive, 15_000, value)
  // The reconnect is the one of the client library: no own strategy
  assert.equal('retryStrategy' in connectionOptions({}), false)
})

test('read: a read has a time limit; the answer "no message" starts the next read', async () => {
  const {client, handled, lines, reader, time} = setup()
  const running = reader.run()
  await settle()
  assert.equal(client.reads.length, 1)
  assert.deepEqual({key: client.reads[0].key, seconds: client.reads[0].seconds}, {key: CHANNEL, seconds: 10})

  for (let i = 0; i < 50; i++) {
    await time.advance(10)
    await client.answer(null)
  }
  assert.equal(client.reads.length, 51)
  assert.ok(client.reads.every(r => r.seconds === 10 && r.key === CHANNEL))
  assert.equal(client.waiting(), 1, 'one read at a time')
  assert.deepEqual(handled, [])
  assert.deepEqual(client.disconnects, [])
  assert.deepEqual(lines, [], 'a read without a message has no log line')

  // A message after all these: handled, and the loop goes on
  await client.answer([CHANNEL, 'm-1'])
  assert.deepEqual(handled, ['m-1'])
  assert.equal(client.waiting(), 1)

  const stopped = reader.stop()
  await client.answer(null)
  assert.equal(await stopped, true)
  await running
})

test('read: every message is handled once, in order; one read at a time', async () => {
  const {client, handled, reader} = setup()
  reader.run()
  await settle()
  const sent = []
  for (let i = 0; i < 200; i++) {
    assert.equal(client.waiting(), 1)
    if (i % 3 === 0) await client.answer(null)
    sent.push(`message-${i}`)
    await client.answer([CHANNEL, `message-${i}`])
  }
  assert.deepEqual(handled, sent)
  assert.equal(reader.stats().messages, 200)

  // An answer for another list is not handled (as before)
  await client.answer(['OTHER_LIST', 'x'])
  // A text that is the same as an earlier one is another message: handled again
  await client.answer([CHANNEL, 'message-0'])
  assert.deepEqual(handled, [...sent, 'message-0'])
  reader.stop()
  await client.answer(null)
})

test('read: an error in the handler does not end the loop, and the message is not read again', async () => {
  const lines = []
  let calls = 0
  const {client, reader} = setup({
    log: (...args) => { lines.push(args.join(' ')) },
    handle: message => {
      calls++
      if (message === 'throws') throw new TypeError('content-of-the-message')
      if (message === 'rejects') return Promise.reject(Object.assign(new Error('content-of-the-message'), {code: 'E_HANDLER'}))
    },
  })
  reader.run()
  await settle()
  await client.answer([CHANNEL, 'throws'])
  await client.answer([CHANNEL, 'rejects'])
  await client.answer([CHANNEL, 'fine'])
  assert.equal(calls, 3)
  assert.equal(client.waiting(), 1)
  assert.deepEqual(lines, ['Queue message not handled TypeError', 'Queue message not handled E_HANDLER'])
  reader.stop()
  await client.answer(null)
})

test('no answer: after the time limit and the grace time the connection is made again, the read goes on', async () => {
  const {client, handled, lines, reader, time} = setup()
  reader.run()
  await settle()
  await client.answer([CHANNEL, 'before'])

  // The connection stops answering. Nothing happens before 10 + 10 seconds.
  await time.advance(19.9)
  assert.deepEqual(client.disconnects, [])
  await time.advance(0.2)
  assert.deepEqual(client.disconnects, [true], 'the reconnect of the client library')
  assert.deepEqual(lines, ['Queue reader: no answer, connection reset {"seconds":20}'])
  assert.equal(client.reads.length, 2, 'no second read next to the one that waits')
  assert.equal(client.waiting(), 1)

  // While the library is busy with the reconnect: no second reset, also after a long time
  await time.advance(120)
  assert.deepEqual(client.disconnects, [true])

  // Connected again: one log line. The library sends the read that waits again: its answer is handled, once.
  await client.ready()
  assert.deepEqual(lines.slice(1), ['Queue reader reconnected {"reconnects":1}'])
  await client.answer([CHANNEL, 'after-1'])
  await client.answer(null)
  await client.answer([CHANNEL, 'after-2'])
  assert.deepEqual(handled, ['before', 'after-1', 'after-2'])
  assert.equal(client.reads.length, 5)
  assert.deepEqual(client.disconnects, [true])
  assert.deepEqual(reader.stats(), {reads: 5, messages: 3, resets: 1, reconnects: 1, failures: 0, connected: true, running: true, reading: true})
  reader.stop()
  await client.answer(null)
})

test('no answer: the time of a read starts again at a reconnect; a new connection that is silent too is made again', async () => {
  const {client, handled, lines, reader, time} = setup()
  reader.run()
  await settle()

  // The connection ends by itself (the library sees it) 15 seconds into a read, and is back 2 seconds later
  await time.advance(15)
  client.status = 'reconnecting'
  await time.advance(2)
  await client.ready()
  // 17 seconds after the read started, 0 after it was sent again: no reset at 20 seconds
  await time.advance(19)
  assert.deepEqual(client.disconnects, [])
  // This connection gives no answer: reset 20 seconds after it was ready
  await time.advance(1.1)
  assert.deepEqual(client.disconnects, [true])
  await client.ready()
  // And the next one is silent too
  await time.advance(20.1)
  assert.deepEqual(client.disconnects, [true, true])
  await client.ready()
  await client.answer([CHANNEL, 'm'])
  assert.deepEqual(handled, ['m'])
  assert.equal(client.reads.length, 2)
  assert.deepEqual(lines, [
    'Queue reader reconnected {"reconnects":1}',
    'Queue reader: no answer, connection reset {"seconds":37}',
    'Queue reader reconnected {"reconnects":2}',
    'Queue reader: no answer, connection reset {"seconds":57}',
    'Queue reader reconnected {"reconnects":3}',
  ])
  reader.stop()
  await client.answer(null)
})

test('no answer: a late answer of a read is still handled, once', async () => {
  const {client, handled, reader, time} = setup()
  reader.run()
  await settle()
  await time.advance(20.1)
  assert.deepEqual(client.disconnects, [true])
  // The answer was on its way: it comes before the connection is gone
  await client.answer([CHANNEL, 'late'])
  assert.deepEqual(handled, ['late'])
  await client.ready()
  await client.answer([CHANNEL, 'next'])
  assert.deepEqual(handled, ['late', 'next'])
  assert.equal(client.reads.length, 3)
  reader.stop()
  await client.answer(null)
})

test('silent: one log line when there was no answer for longer than the limit, again after the next answer', async () => {
  const {client, lines, reader, time} = setup({silentAfter: 300})
  reader.run()
  await settle()
  const silent = () => lines.filter(line => line.startsWith('Queue reader silent'))

  // Connected, and every new connection gives no answer
  for (let i = 0; i < 14; i++) {
    await time.advance(20.1)
    await client.ready()
  }
  assert.deepEqual(silent(), [], 'not before 5 minutes')
  for (let i = 0; i < 40; i++) {
    await time.advance(20.1)
    await client.ready()
  }
  assert.deepEqual(silent(), ['Queue reader silent {"minutes":5,"connected":true}'], 'one line')

  // An answer, then silence again: one more line
  await client.answer(null)
  for (let i = 0; i < 40; i++) {
    await time.advance(20.1)
    await client.ready()
  }
  assert.equal(silent().length, 2)
  assert.equal(silent()[1], 'Queue reader silent {"minutes":5,"connected":true}')

  // Normal traffic: no line
  await client.answer(null)
  const before = lines.length
  for (let i = 0; i < 100; i++) {
    await time.advance(10)
    await client.answer(i % 2 ? null : [CHANNEL, 'm'])
  }
  assert.equal(lines.length, before)
  reader.stop()
  await client.answer(null)
})

test('silent: not connected for a long time: no reset by the reader, one log line, the read goes on after the connect', async () => {
  const {client, handled, lines, reader, time} = setup({}, 'connecting')
  reader.run()
  await settle()
  await time.advance(900)
  assert.deepEqual(client.disconnects, [])
  assert.deepEqual(lines, ['Queue reader silent {"minutes":5,"connected":false}'])
  assert.equal(client.reads.length, 1)

  // The first connect is no reconnect
  await client.ready()
  assert.equal(lines.length, 1)
  await client.answer([CHANNEL, 'first'])
  assert.deepEqual(handled, ['first'])
  reader.stop()
  await client.answer(null)
})

test('a read that fails: logged without values, tried again with more time between the tries, messages after it are handled', async () => {
  const {client, handled, lines, reader, time} = setup()
  reader.run()
  await settle()

  await client.fail(Object.assign(new Error('Connection is closed.'), {name: 'Error'}))
  assert.equal(client.reads.length, 1, 'not at once')
  await time.advance(0.9)
  assert.equal(client.reads.length, 1)
  await time.advance(0.2)
  assert.equal(client.reads.length, 2, 'after 1 second')

  await client.fail(Object.assign(new Error('LOADING Redis is loading the dataset in memory'), {name: 'ReplyError'}))
  await time.advance(1.9)
  assert.equal(client.reads.length, 2)
  await time.advance(0.2)
  assert.equal(client.reads.length, 3, 'after 2 seconds')

  // Many failures: 4, 8, 16 and then 30 seconds between the tries at most
  for (const wait of [4, 8, 16, 30, 30, 30, 30, 30, 30, 30]) {
    await client.fail(Object.assign(new Error('connect ECONNREFUSED redis://user:value@redis.example:6379/0?x=value'), {code: 'ECONNREFUSED'}))
    const reads = client.reads.length
    await time.advance(wait - 0.1)
    assert.equal(client.reads.length, reads, `not before ${wait} seconds`)
    await time.advance(0.2)
    assert.equal(client.reads.length, reads + 1, `after ${wait} seconds`)
  }
  assert.equal(client.reads.length, 13)
  assert.equal(client.waiting(), 1)

  await client.answer([CHANNEL, 'after'])
  assert.deepEqual(handled, ['after'])
  // After a good read the time between the tries starts at 1 second again
  await client.fail(new Error('x'.repeat(500)))
  await time.advance(1.1)
  assert.equal(client.reads.length, 15)

  assert.equal(lines[0], 'Queue read failed Error Connection is closed.')
  assert.equal(lines[1], 'Queue read failed ReplyError LOADING Redis is loading the dataset in memory')
  // No URL in the text of an error, and a short text
  assert.equal(lines[2], 'Queue read failed ECONNREFUSED connect ECONNREFUSED (url)')
  assert.ok(lines.every(line => !line.includes('value') && line.length < 160))
  assert.deepEqual(client.disconnects, [], 'a failed read is no reason for a reset')
  reader.stop()
  await client.answer(null)
})

test('stop: no new read; the message of the read that waits is still handled; a read without an answer does not hold the stop', async () => {
  // The read that waits gets a message after stop()
  {
    const {client, handled, reader, time} = setup()
    const running = reader.run()
    await settle()
    let stopped = null
    reader.stop().then(value => { stopped = value })
    await time.advance(5)
    assert.equal(stopped, null, 'waits for the read')
    await client.answer([CHANNEL, 'last'])
    assert.equal(stopped, true)
    assert.deepEqual(handled, ['last'])
    assert.equal(client.reads.length, 1, 'no new read')
    await running
    assert.equal(time.pending(), 0, 'no timer left')
    assert.equal(await reader.stop(), true, 'stop again: stopped')
  }
  // No answer at all: stop() gives up after the time limit and the grace time
  {
    const {client, handled, reader, time} = setup({}, 'connecting')
    reader.run()
    await settle()
    let stopped = null
    reader.stop().then(value => { stopped = value })
    await time.advance(19.9)
    assert.equal(stopped, null)
    await time.advance(0.2)
    assert.equal(stopped, false)
    // A message that still comes is handled
    await client.ready()
    await client.answer([CHANNEL, 'very-late'])
    assert.deepEqual(handled, ['very-late'])
    assert.equal(client.reads.length, 1)
  }
  // Stop during the wait after a failed read: at once
  {
    const {client, reader, time} = setup()
    const running = reader.run()
    await settle()
    await client.fail(new Error('x'))
    assert.equal(await reader.stop(), true)
    await running
    assert.equal(client.reads.length, 1)
    assert.equal(time.pending(), 0)
  }
  // run() twice: one loop
  {
    const {client, reader} = setup()
    reader.run()
    reader.run()
    await settle()
    assert.equal(client.reads.length, 1)
    reader.stop()
    await client.answer(null)
  }
})

// ---- A fake Redis server on a local socket: INFO, BLPOP with a time limit, the list in memory.
// silence(): the connections of this moment get no answer any more, and are not closed (a peer that is gone).
// drop(): the connections of this moment are ended.
const fakeRedis = async () => {
  const list = []
  const waiters = [] // {socket, timer}: the reads that wait, the oldest first
  const sockets = new Set()
  const silent = new Set()
  const counts = {connections: 0, blpop: 0, popped: 0}

  const reply = (socket, text) => { if (!silent.has(socket) && !socket.destroyed) socket.write(text) }
  const bulk = text => `$${Buffer.byteLength(text)}\r\n${text}\r\n`
  const serve = () => {
    while (list.length > 0 && waiters.length > 0) {
      const waiter = waiters.shift()
      clearTimeout(waiter.timer)
      counts.popped++
      reply(waiter.socket, `*2\r\n${bulk(waiter.key)}${bulk(list.shift())}`)
    }
  }

  const command = (socket, args) => {
    const name = String(args[0]).toLowerCase()
    if (name === 'info') return reply(socket, bulk('# Server\r\nredis_version:7.0.0\r\nloading:0\r\n'))
    if (name === 'blpop') {
      counts.blpop++
      const waiter = {socket, key: args[1]}
      waiter.timer = setTimeout(() => {
        waiters.splice(waiters.indexOf(waiter), 1)
        reply(socket, '*-1\r\n')
      }, Number(args[2]) * 1000)
      waiters.push(waiter)
      return serve()
    }
    return reply(socket, '+OK\r\n')
  }

  const server = net.createServer(socket => {
    counts.connections++
    sockets.add(socket)
    let buffer = Buffer.alloc(0)
    socket.on('data', chunk => {
      if (silent.has(socket)) return
      buffer = Buffer.concat([buffer, chunk])
      // Commands: arrays of bulk strings
      for (;;) {
        const text = buffer.toString('latin1')
        const head = /^\*(\d+)\r\n/.exec(text)
        if (!head) return
        let at = head[0].length
        const args = []
        for (let i = 0; i < Number(head[1]); i++) {
          const size = /^\$(\d+)\r\n/.exec(text.slice(at))
          if (!size || text.length < at + size[0].length + Number(size[1]) + 2) return
          at += size[0].length
          args.push(text.slice(at, at + Number(size[1])))
          at += Number(size[1]) + 2
        }
        buffer = buffer.subarray(at)
        command(socket, args)
      }
    })
    const gone = () => {
      sockets.delete(socket)
      for (const waiter of waiters.filter(w => w.socket === socket)) {
        clearTimeout(waiter.timer)
        waiters.splice(waiters.indexOf(waiter), 1)
      }
    }
    socket.on('close', gone)
    socket.on('error', () => {})
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))

  return {
    port: server.address().port,
    counts,
    push: (...messages) => { list.push(...messages); serve() },
    length: () => list.length,
    // The reads of these connections are gone with them: they take no message
    silence: () => {
      for (const socket of sockets) {
        silent.add(socket)
        for (const waiter of waiters.filter(w => w.socket === socket)) {
          clearTimeout(waiter.timer)
          waiters.splice(waiters.indexOf(waiter), 1)
        }
      }
    },
    // As a server that ends a connection: its read is gone at once
    drop: () => {
      for (const socket of [...sockets]) {
        for (const waiter of waiters.filter(w => w.socket === socket)) {
          clearTimeout(waiter.timer)
          waiters.splice(waiters.indexOf(waiter), 1)
        }
        socket.destroy()
      }
    },
    close: () => new Promise(resolve => { for (const socket of sockets) socket.destroy(); server.close(resolve) }),
  }
}

const until = async (condition, text, ms = 5000) => {
  const end = Date.now() + ms
  while (!condition()) {
    if (Date.now() > end) assert.fail('not in time: ' + text)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

test('real client library: reads with a time limit, a connection that stops answering, a connection that ends: every message handled once', async () => {
  const server = await fakeRedis()
  const handled = []
  const lines = []
  // The options of the service (redis.mjs), with short times for the test
  const client = new ioredis({host: '127.0.0.1', port: server.port, ...connectionOptions({}), disconnectTimeout: 100})
  client.on('error', () => {})
  const reader = createReader({
    client, channel: CHANNEL, timeout: 0.2, grace: 0.2, silentAfter: 60,
    handle: message => { handled.push(message) },
    log: (...args) => { lines.push(args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')) },
  })
  const count = start => lines.filter(line => line.startsWith(start)).length

  try {
    const running = reader.run()

    // 1. Messages, and reads without a message in between
    server.push('a', 'b')
    await until(() => handled.length === 2, 'a, b')
    const reads = server.counts.blpop
    await until(() => server.counts.blpop >= reads + 4, 'the loop goes on without a message')
    assert.deepEqual(handled, ['a', 'b'])
    assert.equal(server.counts.connections, 1)
    assert.deepEqual(lines, [], 'no log line for normal reads')

    // 2. The connection stops answering, without a close. The reader makes a new one; messages after it are handled.
    server.silence()
    await until(() => server.counts.connections === 2 && client.status === 'ready', 'a new connection')
    assert.equal(count('Queue reader: no answer, connection reset'), 1)
    assert.equal(count('Queue reader reconnected'), 1)
    server.push('c', 'd')
    await until(() => handled.length === 4, 'c, d')

    // A message that was sent while the connection gave no answer waits in the list, and is handled after it
    server.silence()
    server.push('e')
    await until(() => handled.length === 5, 'e')
    assert.equal(server.counts.connections, 3)

    // 3. The server ends the connection: the library connects again, the read goes on
    server.drop()
    server.push('f')
    await until(() => handled.length === 6, 'f')
    assert.equal(server.counts.connections, 4)
    server.push('g', 'h', 'i')
    await until(() => handled.length === 9, 'g, h, i')

    // Every message once, in order, and nothing left in the list
    await new Promise(resolve => setTimeout(resolve, 500))
    assert.deepEqual(handled, ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'])
    assert.equal(server.length(), 0)
    assert.equal(server.counts.popped, 9)
    assert.equal(count('Queue reader reconnected'), 3)
    assert.equal(count('Queue reader: no answer, connection reset'), 2)
    assert.equal(count('Queue reader silent'), 0)
    assert.equal(lines.length, 5, lines.join('\n'))
    assert.deepEqual({messages: reader.stats().messages, resets: reader.stats().resets, reconnects: reader.stats().reconnects, failures: reader.stats().failures}, {messages: 9, resets: 2, reconnects: 3, failures: 0})

    // 4. Stop: the read that waits is finished, no read after it
    assert.equal(await reader.stop(), true)
    await running
    const after = server.counts.blpop
    server.push('not-read')
    await new Promise(resolve => setTimeout(resolve, 500))
    assert.equal(server.counts.blpop, after)
    assert.equal(server.length(), 1, 'a message after the stop stays in the list')
    assert.equal(handled.length, 9)
  } finally {
    reader.stop()
    client.disconnect()
    await server.close()
  }
})

test('source: the queue is read by the reader only, and the client of the service has its connection options', async () => {
  const source = async file => readFile(new URL(`../${file}`, import.meta.url), 'utf8')
  const index = await source('index.mjs')
  assert.doesNotMatch(index, /\.blpop\(/)
  assert.match(index, /createReader\(\{\s*client: redis,\s*channel: redisChannel,/)
  assert.match(index, /\.\.\.settingsFrom\(config\)/)
  assert.match(index, /^await reader\.run\(\)$/m)
  assert.match(index, /sender\.pending\(\) < 1 && readerStopped/)
  assert.match(await source('redis.mjs'), /\.\.\.connectionOptions\(config\)/)
  // One place with a read, and it has the time limit
  const reader = await source('reader.mjs')
  assert.deepEqual(reader.match(/\.blpop\([^)]*\)/g), ['.blpop(channel, timeout)'])
})
