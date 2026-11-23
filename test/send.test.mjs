// node --test test/*.test.mjs
// send(): retries, the record of every attempt, the limits and the 404 skip list. A fake database, a fake delivery
// and fake timers: no network, no database.
import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'crypto'
import {createSender, hostOf, notFoundQuery} from '../send.mjs'
import {createLimiter} from '../limits.mjs'
import {timeoutText} from '../deliver.mjs'

const tick = () => new Promise(resolve => setImmediate(resolve))
const settle = async () => { for (let i = 0; i < 5; i++) await tick() }

// What the database does with 'url = :url' on this column: no difference for case and accents
const fold = text => String(text).normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()

// A fake of the table 'calls'. The SELECT of the skip list answers like a database that compares without case and
// accents (the least exact answer the real one can give): send() must still decide on the exact URL.
const database = () => {
  const rows = []
  const selects = []
  const query = async (sql, params) => {
    if (/^\s*INSERT INTO calls/.test(sql)) {
      const row = {payload: params.payload, url: String(params.url).slice(0, 125), attempt: params.attempt, response_code: null, error: null}
      if (sql.includes(':callReturnCode')) Object.assign(row, {response_code: params.callReturnCode, response_message: params.callReturnText})
      else if (sql.includes('999')) Object.assign(row, {response_code: 999, attempt: 10, error: 'Skipped, exceeding 404 limits on similar URL in past hour'})
      else row.error = String(params.error).slice(0, 100)
      rows.push(row)
      return {affectedRows: 1}
    }
    selects.push({sql, params})
    return rows.filter(r => r.response_code === 404 && r.attempt === 5 && fold(r.url) === fold(params.url)).map(r => ({payload: r.payload, url: r.url}))
  }
  return {rows, selects, query}
}

// Fake timers for the retries: run() fires what is scheduled, until nothing is left
const timers = () => {
  const waiting = []
  const delays = []
  const schedule = (fn, ms) => { waiting.push(fn); delays.push(ms) }
  const run = async () => {
    await settle()
    while (waiting.length > 0) {
      waiting.shift()()
      await settle()
    }
  }
  return {schedule, run, delays, waiting}
}

// A fake delivery: answer(url, request) gives {status, text, headers} or an Error to throw
const delivery = answer => {
  const seen = []
  const deliver = async (url, request, options) => {
    seen.push({url, request, options})
    const a = await answer(url, request)
    if (a instanceof Error) throw a
    return {status: a.status, headers: {raw: () => a.headers || {}}, text: a.text || ''}
  }
  return {deliver, seen}
}

const setup = (answer, limits = {total: 200, perHost: 20}, clock = Date.now) => {
  const db = database()
  const t = timers()
  const d = delivery(answer)
  const limiter = createLimiter(limits)
  const sender = createSender({query: db.query, deliver: d.deliver, limiter, schedule: t.schedule, clock})
  return {db, t, d, limiter, sender}
}

const A = '00000000-0000-4000-8000-00000000000a'
const B = '00000000-0000-4000-8000-00000000000b'
const job = (application, n = 1) => ({meta: {application_uuidv4: application, payload_uuidv4: `payload-${n}`}, payloadResponse: {signed: true}})
let serial = 0
const payloadId = () => `00000000-0000-4000-8000-${String(++serial).padStart(12, '0')}`

test('hostOf: the host of the destination, for the limit per host', () => {
  assert.equal(hostOf('https://Hooks.Example.com:8443/path?x=1'), 'hooks.example.com')
  assert.equal(hostOf('http://example.com./'), 'example.com')
  assert.equal(hostOf('https://[2001:db8::1]/'), '[2001:db8::1]')
  assert.equal(hostOf('not a url'), '')
  assert.equal(hostOf(undefined), '')
})

test('send: an answer with 200: one request, signed, one record, no retry', async () => {
  const {db, t, d, sender} = setup(() => ({status: 200, headers: {'content-type': ['text/plain']}, text: ' ok \n'}))
  const data = job(A)
  await sender.send('https://example.com/hook', data, 'p-1', 'aaaa-bbbb')
  assert.equal(d.seen.length, 1)
  const {request, options} = d.seen[0]
  assert.equal(request.method, 'post')
  assert.equal(request.body, JSON.stringify(data))
  assert.equal(request.application, A)
  assert.equal(options.timeout, 15_000)
  assert.equal(request.headers['x-xumm-attempt'], 1)
  assert.equal(request.headers['x-xumm-payload'], 'p-1')
  assert.equal(request.headers['user-agent'], 'xumm-webhook')
  assert.equal(request.headers['content-type'], 'application/json')
  const signature = crypto.createHmac('sha1', 'aaaabbbb').update(request.headers['x-xumm-request-timestamp'] + request.body).digest('hex')
  assert.equal(request.headers['x-xumm-request-signature'], signature)

  await settle()
  assert.deepEqual(db.rows, [{payload: 'p-1', url: 'https://example.com/hook', attempt: 1, response_code: 200, error: null, response_message: 'content-type: text/plain\nBody:\nok'}])
  assert.equal(t.waiting.length, 0)
  assert.equal(sender.pending(), 0)
})

test('send: 201 and 204 are not retried, every other code is: 5 attempts, after 10, 60, 600 and 600 seconds', async () => {
  for (const status of [201, 204]) {
    const {db, t, sender} = setup(() => ({status}))
    await sender.send('https://example.com/hook', job(A), 'p-1', '')
    await t.run()
    assert.deepEqual(db.rows.map(r => r.response_code), [status])
    assert.equal(sender.pending(), 0)
  }

  for (const status of [500, 404, 302, 202]) {
    const {db, t, d, sender} = setup(() => ({status}))
    await sender.send('https://example.com/hook', job(A), 'p-1', '')
    // The retry that is to come is counted: a graceful stop waits for it
    assert.equal(sender.pending(), 1)
    await t.run()
    assert.deepEqual(t.delays, [10_000, 60_000, 600_000, 600_000], String(status))
    assert.deepEqual(d.seen.map(s => s.request.headers['x-xumm-attempt']), [1, 2, 3, 4, 5])
    assert.deepEqual(db.rows.map(r => [r.response_code, r.attempt]), [1, 2, 3, 4, 5].map(n => [status, n]))
    assert.equal(sender.pending(), 0)
  }
})

test('send: the time limit is retried and recorded, another error is recorded and not retried (as before)', async () => {
  const limit = setup(() => Object.assign(new Error(timeoutText), {timeout: true}))
  await limit.sender.send('https://example.com/hook', job(A), 'p-1', '')
  await limit.t.run()
  assert.deepEqual(limit.t.delays, [10_000, 60_000, 600_000, 600_000])
  assert.deepEqual(limit.db.rows.map(r => [r.response_code, r.attempt, r.error]), [1, 2, 3, 4, 5].map(n => [null, n, 'The operation was aborted.']))
  assert.equal(limit.sender.pending(), 0)

  for (const message of ['Invalid URL', 'Invalid URL (redirect)', 'request to https://example.com/hook failed, reason: connect ECONNREFUSED', 'content size at https://example.com/hook over limit: 524288']) {
    const {db, t, sender} = setup(() => new Error(message))
    await sender.send('https://example.com/hook', job(A), 'p-1', '')
    await t.run()
    assert.deepEqual(t.delays, [])
    assert.deepEqual(db.rows.map(r => [r.response_code, r.attempt, r.error]), [[null, 1, message.slice(0, 100)]])
    assert.equal(sender.pending(), 0)
  }
})

test('send: a recovered destination: retries stop at the first good answer', async () => {
  let n = 0
  const {db, t, sender} = setup(() => ({status: ++n < 3 ? 503 : 200}))
  await sender.send('https://example.com/hook', job(A), 'p-1', '')
  await t.run()
  assert.deepEqual(db.rows.map(r => [r.response_code, r.attempt]), [[503, 1], [503, 2], [200, 3]])
  assert.deepEqual(t.delays, [10_000, 60_000])
  assert.equal(sender.pending(), 0)
})

test('send: a database that fails does not stop the delivery or the count', async () => {
  const t = timers()
  const d = delivery(() => ({status: 500}))
  const sender = createSender({query: async () => { throw new Error('database is away') }, deliver: d.deliver, limiter: createLimiter(), schedule: t.schedule})
  await sender.send('https://example.com/hook', job(A), 'p-1', '')
  await t.run()
  assert.equal(d.seen.length, 5)
  assert.equal(sender.pending(), 0)
})

// Ten payloads of one application that all end with a 404 on the last attempt
const tenNotFound = async (s, url, application) => {
  for (let i = 0; i < 10; i++) await s.sender.send(url, job(application), payloadId(), '')
  await s.t.run()
}

test('skip list: after ten 404 answers on the last attempt, the same application and URL is skipped and recorded', async () => {
  const s = setup(() => ({status: 404}))
  const url = 'https://example.com/hook'
  await tenNotFound(s, url, A)
  assert.equal(s.d.seen.length, 50)
  assert.equal(s.db.rows.filter(r => r.response_code === 404 && r.attempt === 5).length, 10)

  await s.sender.send(url, job(A), 'p-next', '')
  await s.t.run()
  // No request, and the same record as before
  assert.equal(s.d.seen.length, 50)
  assert.deepEqual(s.db.rows.at(-1), {payload: 'p-next', url, attempt: 10, response_code: 999, error: 'Skipped, exceeding 404 limits on similar URL in past hour'})
  assert.equal(s.t.waiting.length, 0)
  assert.equal(s.sender.pending(), 0)
})

test('skip list: nine 404 answers are not enough, and only the last attempt counts', async () => {
  const s = setup(() => ({status: 404}))
  const url = 'https://example.com/hook'
  for (let i = 0; i < 9; i++) await s.sender.send(url, job(A), payloadId(), '')
  await s.t.run()
  await s.sender.send(url, job(A), 'p-next', '')
  assert.equal(s.d.seen.length, 46)
  assert.equal(s.db.rows.some(r => r.response_code === 999), false)
  await s.t.run()
})

test('skip list: the 404 answers of one application do not skip another application on the same URL', async () => {
  const s = setup((url, request) => ({status: request.application === A ? 404 : 200}))
  const url = 'https://example.com/hook'
  await tenNotFound(s, url, A)

  await s.sender.send(url, job(B), 'p-b', '')
  assert.equal(s.d.seen.at(-1).request.application, B)
  assert.deepEqual(s.db.rows.at(-1), {payload: 'p-b', url, attempt: 1, response_code: 200, error: null, response_message: '\nBody:\n'})

  // The application with the 404 answers itself is skipped
  await s.sender.send(url, job(A), 'p-a', '')
  assert.equal(s.db.rows.at(-1).response_code, 999)
  assert.equal(s.sender.pending(), 0)
})

test('skip list: a URL that differs in case or accents only is another URL', async () => {
  const s = setup(() => ({status: 404}))
  const url = 'https://example.com/hook'
  await tenNotFound(s, url, A)

  for (const [application, other] of [[A, 'https://example.com/Hook'], [A, 'https://example.com/HOOK'], [A, 'https://example.com/hòok'], [B, 'https://example.com/Hook'], [A, 'https://example.com/hook/'], [A, 'https://example.com/hook?x=1']]) {
    const before = s.d.seen.length
    await s.sender.send(other, job(application), payloadId(), '')
    assert.equal(s.d.seen.length, before + 1, other)
    assert.equal(s.d.seen.at(-1).url, other)
    assert.equal(s.db.rows.at(-1).response_code, 404, other)
  }

  // And the other way: ten 404 answers on the URL with other case do not skip the exact URL of another application
  const t = setup(() => ({status: 404}))
  await tenNotFound(t, 'https://example.com/Hook', A)
  const before = t.d.seen.length
  await t.sender.send(url, job(B), 'p-b', '')
  await t.sender.send(url, job(A), 'p-a', '')
  assert.equal(t.d.seen.length, before + 2)
  assert.equal(t.db.rows.some(r => r.response_code === 999), false)
})

test('skip list: a job without an application is not skipped, and a retry that is skipped is counted off', async () => {
  const s = setup(() => ({status: 404}))
  const url = 'https://example.com/hook'
  await tenNotFound(s, url, A)

  // Also not by the 404 answers of other jobs without an application
  for (let i = 0; i < 10; i++) await s.sender.send(url, {meta: {}}, payloadId(), '')
  await s.t.run()
  const before = s.d.seen.length
  await s.sender.send(url, {meta: {}}, 'p-none', '')
  await s.sender.send(url, {}, 'p-none-2', '')
  assert.equal(s.d.seen.length, before + 2)
  s.t.waiting.length = 0

  // The first attempt of this payload was made before the URL was on the list; its retry is skipped
  const count = s.sender.pending()
  await s.sender.send(url, job(A), 'p-retry', '', 3)
  assert.equal(s.db.rows.at(-1).response_code, 999)
  assert.equal(s.sender.pending(), count - 1)
})

test('skip list: what is kept in memory about a payload is dropped after two hours', async () => {
  let now = 1_000_000
  const s = setup(() => ({status: 404}), undefined, () => now)
  const url = 'https://example.com/hook'
  await tenNotFound(s, url, A)

  // Within the two hours: skipped
  now += 60 * 60 * 1000
  let before = s.d.seen.length
  await s.sender.send(url, job(A), 'p-skipped', '')
  assert.equal(s.d.seen.length, before)
  assert.equal(s.db.rows.at(-1).response_code, 999)

  // Three hours later another payload ends with a 404: the old ones are dropped. This fake database has no clock
  // and still gives the ten old rows: they do not count any more.
  now += 3 * 60 * 60 * 1000
  await s.sender.send('https://example.org/other', job(B), payloadId(), '', 5)
  before = s.d.seen.length
  await s.sender.send(url, job(A), 'p-again', '')
  assert.equal(s.d.seen.length, before + 1)
  assert.equal(s.db.rows.at(-1).response_code, 404)
})

test('skip list: the query compares the URL as bytes and asks for this URL only', () => {
  assert.match(notFoundQuery, /CAST\(url AS BINARY\) = CAST\(:url AS BINARY\)/)
  assert.match(notFoundQuery, /response_code = 404\s+AND\s+attempt = 5\s+AND\s+moment > DATE_SUB\(NOW\(\), INTERVAL 1 HOUR\)/)
  assert.doesNotMatch(notFoundQuery, /GROUP BY/i)
})

test('limits: slow deliveries for one host wait their turn and do not delay another host', async () => {
  let release
  const hold = new Promise(resolve => { release = resolve })
  const s = setup(async url => {
    if (hostOf(url) === 'slow.example.com') await hold
    return {status: 200}
  }, {total: 100, perHost: 4})

  const slow = []
  for (let i = 0; i < 12; i++) slow.push(s.sender.send(`https://slow.example.com/hook/${i}`, job(A), `p-slow-${i}`, ''))
  await settle()
  // 4 run, 8 wait: all of them count as not finished
  assert.equal(s.d.seen.length, 4)
  assert.deepEqual(s.limiter.stats(), {running: 4, waiting: 8, hosts: 1})
  assert.equal(s.sender.pending(), 12)

  // Another host, also of the same application: delivered at once
  await s.sender.send('https://other.example.org/hook', job(B), 'p-other', '')
  await s.sender.send('https://third.example.org/hook', job(A), 'p-third', '')
  assert.deepEqual(s.db.rows.map(r => [r.payload, r.response_code]), [['p-other', 200], ['p-third', 200]])
  assert.equal(s.d.seen.length, 6)
  assert.equal(s.sender.pending(), 12)

  release()
  await Promise.all(slow)
  await settle()
  // Nothing is lost, and the waiting ones were sent in order of arrival
  assert.deepEqual(s.d.seen.filter(x => hostOf(x.url) === 'slow.example.com').map(x => x.request.headers['x-xumm-payload']), Array.from({length: 12}, (_, i) => `p-slow-${i}`))
  assert.equal(s.db.rows.filter(r => r.response_code === 200).length, 14)
  assert.equal(s.sender.pending(), 0)
  assert.deepEqual(s.limiter.stats(), {running: 0, waiting: 0, hosts: 0})
})

test('limits: the limit for all hosts together, and a retry takes a place like a first attempt', async () => {
  let now = 0
  let most = 0
  const gates = []
  const s = setup(async () => {
    most = Math.max(most, ++now)
    await new Promise(resolve => gates.push(resolve))
    now--
    return {status: 500}
  }, {total: 3, perHost: 2})

  const jobs = []
  for (let i = 0; i < 10; i++) jobs.push(s.sender.send(`https://h${i}.example.com/hook`, job(A), `p-${i}`, ''))
  await settle()
  assert.deepEqual(s.limiter.stats(), {running: 3, waiting: 7, hosts: 3})
  assert.equal(s.sender.pending(), 10)

  // Every attempt ends with a 500: first attempts and retries go through the same limits
  for (let round = 0; round < 200 && s.sender.pending() > 0; round++) {
    while (gates.length > 0) gates.shift()()
    await settle()
    while (s.t.waiting.length > 0) s.t.waiting.shift()()
    await settle()
  }
  await Promise.all(jobs)
  assert.equal(most, 3)
  assert.equal(s.d.seen.length, 50)
  assert.equal(s.sender.pending(), 0)
  assert.deepEqual(s.limiter.stats(), {running: 0, waiting: 0, hosts: 0})
})
