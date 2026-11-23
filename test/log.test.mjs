// node --test test/*.test.mjs
// The log: a line has the payload id, the host of the destination, the attempt, the status code, the time and sizes.
// It has no URL path or query, no header values, no request or response body and no key material.
// A fake database, a fake delivery and fake timers: no network, no database.
import test from 'node:test'
import assert from 'node:assert/strict'
import util from 'node:util'
import debug from 'debug'
import {createSender} from '../send.mjs'
import {createLimiter} from '../limits.mjs'
import {handleMessage} from '../queue.mjs'
import {hostOf, withoutUrlDetails, errorCode, errorText, errorTrace} from '../logtext.mjs'

// Every line of the debug log of this process, as text (objects in full depth)
const lines = []
debug.enable('xummproxy*')
debug.log = (...args) => { lines.push(args.map(a => (typeof a === 'string' ? a : util.inspect(a, {depth: null, breakLength: Infinity}))).join(' ')) }
const logged = () => lines.join('\n')
const clear = () => { lines.length = 0 }

const tick = () => new Promise(resolve => setImmediate(resolve))
const settle = async () => { for (let i = 0; i < 5; i++) await tick() }

// Values that must never be in a log line
const marks = ['KEYMARK', 'USERMARK', 'PATHMARK', 'QUERYMARK', 'HEADERMARK', 'BODYMARK', 'CREDMARK', 'SQLMARK', 'RAWMARK']
const assertClean = text => { for (const mark of marks) assert.equal(text.includes(mark), false, `${mark} is in the log:\n${text}`) }

const payload = '00000000-0000-4000-8000-0000000000aa'
const application = '00000000-0000-4000-8000-00000000000a'
const url = 'https://Hooks.Example.com:8443/PATHMARK/hook?token=QUERYMARK#frag-QUERYMARK'
const secret = 'KEYMARK-0000-4000-8000-KEYMARK'
const data = {
  meta: {application_uuidv4: application, payload_uuidv4: payload},
  custom_meta: {blob: {note: 'BODYMARK'}},
  payloadResponse: {signed: true, txid: 'BODYMARK'},
  userToken: {user_token: 'USERMARK', token_issued: 1, token_expiration: 2},
}

const timers = () => {
  const waiting = []
  const schedule = fn => { waiting.push(fn) }
  const run = async () => {
    await settle()
    while (waiting.length > 0) {
      waiting.shift()()
      await settle()
    }
  }
  return {schedule, run}
}

const sender = (answer, query = async () => []) => {
  const t = timers()
  const seen = []
  const deliver = async (target, request) => {
    seen.push({target, request})
    const a = await answer(target, request)
    if (a instanceof Error) throw a
    return {status: a.status, headers: {raw: () => a.headers || {}}, text: a.text || ''}
  }
  const s = createSender({query, deliver, limiter: createLimiter({total: 200, perHost: 20}), schedule: t.schedule})
  return {s, t, seen}
}

test('logtext: the host of a URL, and a text without the details of a URL', () => {
  assert.equal(hostOf(url), 'hooks.example.com')
  assert.equal(hostOf('https://user:CREDMARK@example.com/x'), 'example.com')
  assert.equal(hostOf('not a url'), '')

  assert.equal(withoutUrlDetails(`request to ${url} failed, reason: connect ECONNREFUSED 192.0.2.1:8443`), 'request to https://hooks.example.com:8443 failed, reason: connect ECONNREFUSED 192.0.2.1:8443')
  assert.equal(withoutUrlDetails('content size at https://user:CREDMARK@example.com/PATHMARK?a=QUERYMARK over limit: 524288'), 'content size at https://example.com over limit: 524288')
  assert.equal(withoutUrlDetails('at http://[2001:db8::1]:81/PATHMARK?q=QUERYMARK, and wss://example.org/PATHMARK'), 'at http://[2001:db8::1]:81 and wss://example.org')
  assert.equal(withoutUrlDetails('HTTPS://EXAMPLE.COM/PATHMARK'), 'https://example.com')
  assert.equal(withoutUrlDetails('no url: Invalid URL (redirect)'), 'no url: Invalid URL (redirect)')
  assert.equal(withoutUrlDetails('http://%/PATHMARK'), '(url)')
  assert.equal(withoutUrlDetails('x'.repeat(1000)).length, 300)
  assert.equal(withoutUrlDetails(undefined), '')

  assert.equal(errorText(new Error(`request to ${url} failed`)), 'request to https://hooks.example.com:8443 failed')
  assert.equal(errorText('plain text'), 'plain text')
  assert.equal(errorCode(Object.assign(new Error('Duplicate entry SQLMARK'), {code: 'ER_DUP_ENTRY', sql: 'INSERT SQLMARK'})), 'ER_DUP_ENTRY')
  assert.equal(errorCode(Object.assign(new Error('x'), {type: 'system'})), 'system')
  assert.equal(errorCode(new TypeError('SQLMARK')), 'TypeError')
  assert.equal(errorCode(undefined), 'Error')

  // The stack keeps its file positions
  const trace = errorTrace(Object.assign(new Error(`request to ${url} failed`), {sql: 'INSERT SQLMARK'}))
  assertClean(trace)
  assert.match(trace, /^Error: request to https:\/\/hooks\.example\.com:8443 failed\n\s+at /)
  assert.match(trace, /log\.test\.mjs:\d+:\d+/)
})

test('queue: a valid message goes to send() as it is; the log has the payload id and the host only', () => {
  clear()
  const calls = []
  const send = (...args) => { calls.push(args) }
  assert.equal(handleMessage(JSON.stringify({url, payload, data, secret}), send), true)
  assert.deepEqual(calls, [[url, data, payload, secret]])
  // No key: an empty one, as before
  assert.equal(handleMessage(JSON.stringify({url, payload, data}), send), true)
  assert.deepEqual(calls[1], [url, data, payload, ''])

  assertClean(logged())
  assert.equal(lines.length, 2)
  assert.ok(lines[0].includes('Valid REDIS message, process...'))
  assert.ok(lines[0].includes(payload))
  assert.ok(lines[0].includes("host: 'hooks.example.com'"))
})

test('queue: a message that is not valid is not sent, and is not in the log', () => {
  clear()
  const calls = []
  const send = (...args) => { calls.push(args) }
  for (const message of [
    'RAWMARK {"secret":"KEYMARK"',
    '{"url":"https://example.com/PATHMARK","payload":"p","data":{"x":"BODYMARK"},"secret":"KEYMARK"} RAWMARK',
    JSON.stringify({url, data, secret}),
    JSON.stringify({payload, data, secret}),
    JSON.stringify({url, payload, data: 'BODYMARK', secret}),
    JSON.stringify({url: 1, payload, data, secret}),
    'null', '"RAWMARK"', '', undefined, null,
  ]) {
    assert.equal(handleMessage(message, send), false, String(message))
  }
  assert.deepEqual(calls, [])
  assertClean(logged())
  assert.ok(lines.some(line => line.includes('Error decoding REDIS message')))
  assert.ok(lines.some(line => line.includes('Invalid message, missing url/payload')))
  assert.ok(lines.some(line => line.includes('Invalid message, missing data object')))
})

test('send: an answer: the log has payload, host, attempt, status, time and size; not the URL, headers, body or key', async () => {
  clear()
  const {s, t, seen} = sender(() => ({status: 200, headers: {'set-cookie': ['session=HEADERMARK'], 'x-api-key': ['HEADERMARK']}, text: '{"echo":"BODYMARK"}'}))
  await s.send(url, data, payload, secret)
  await t.run()

  // The request itself is as before: the full URL, the body, the signature
  assert.equal(seen.length, 1)
  assert.equal(seen[0].target, url)
  assert.equal(seen[0].request.body, JSON.stringify(data))

  assertClean(logged())
  const calling = lines.find(line => line.includes('Calling webhook'))
  assert.ok(calling.includes(payload) && calling.includes("host: 'hooks.example.com'") && calling.includes('attempt: 1'), calling)
  const called = lines.find(line => line.includes('Called'))
  assert.ok(called.includes(payload) && called.includes("host: 'hooks.example.com'") && called.includes('attempt: 1') && called.includes('c: 200'), called)
  assert.match(called, /ms: \d+/)
  assert.match(called, /bytes: 19\b/)
})

test('send: retries, an error of the HTTP client and the time limit: the log has host and reason, not the URL', async () => {
  clear()
  const answers = [
    {status: 500, headers: {'www-authenticate': ['Bearer HEADERMARK']}, text: 'BODYMARK'},
    Object.assign(new Error('The operation was aborted.'), {timeout: true}),
    {status: 404, text: 'BODYMARK'},
    {status: 302, headers: {location: ['https://example.com/PATHMARK?QUERYMARK']}},
    new Error(`request to ${url} failed, reason: connect ECONNREFUSED 192.0.2.1:8443`),
  ]
  let n = 0
  const {s, t, seen} = sender(() => answers[n++])
  await s.send(url, data, payload, secret)
  await t.run()
  assert.equal(seen.length, 5)
  assert.equal(s.pending(), 0)

  const text = logged()
  assertClean(text)
  for (const expected of ['c: 500', 'c: 404', 'c: 302', 'The operation was aborted.', 'request to https://hooks.example.com:8443 failed, reason: connect ECONNREFUSED 192.0.2.1:8443', 'nextAttempt: 5']) {
    assert.ok(text.includes(expected), expected)
  }
  assert.equal(lines.filter(line => line.includes('Calling webhook')).length, 5)
})

test('send: a job that fails before the request, and a database that fails: no values in the log', async () => {
  clear()
  // A key that is not a text ends the attempt before the request (as before)
  const first = sender(() => ({status: 200}))
  await first.s.send(url, data, payload, {key: 'KEYMARK'})
  await first.t.run()
  assert.equal(first.seen.length, 0)

  const failing = async () => { throw Object.assign(new Error("ER_PARSE_ERROR: near 'SQLMARK BODYMARK HEADERMARK'"), {code: 'ER_PARSE_ERROR', sql: 'INSERT SQLMARK'}) }
  const second = sender(() => ({status: 200, headers: {'set-cookie': ['HEADERMARK']}, text: 'BODYMARK'}), failing)
  await second.s.send(url, data, payload, secret)
  await second.t.run()
  assert.equal(second.seen.length, 1)

  const text = logged()
  assertClean(text)
  assert.ok(text.includes('Not recorded') && text.includes('Skip list not checked') && text.includes('ER_PARSE_ERROR'), text)
})

test('send: a destination on the skip list: the log has the payload id and the host', async () => {
  clear()
  // The table answers with ten 404 rows of this application for this URL
  const rows = []
  const query = async (sql, params) => {
    if (/^\s*INSERT INTO calls/.test(sql)) {
      if (sql.includes(':callReturnCode')) rows.push({payload: params.payload, url: params.url, code: params.callReturnCode, attempt: params.attempt})
      return {affectedRows: 1}
    }
    return rows.filter(r => r.code === 404 && r.attempt === 5 && r.url === params.url).map(r => ({payload: r.payload, url: r.url}))
  }
  const {s, t, seen} = sender(() => ({status: 404, text: 'BODYMARK'}), query)
  for (let i = 0; i < 10; i++) await s.send(url, data, `${payload}-${i}`, secret)
  await t.run()
  assert.equal(seen.length, 50)

  await s.send(url, data, payload, secret)
  await t.run()
  assert.equal(seen.length, 50)

  assertClean(logged())
  const skipped = lines.find(line => line.includes('Skipping URL'))
  assert.ok(skipped.includes(`'${payload}'`) && skipped.includes("host: 'hooks.example.com'"), skipped)
})

test('source: a log call gets ids, hosts, numbers and error labels only', async () => {
  const {readFile} = await import('node:fs/promises')
  // What a log call can have of a job or an error
  const allowed = [
    /\bhostOf\((?:data\.)?url\)/g, /\berror(?:Code|Text|Trace)\(e\)/g, /\breason\(e\)/g, /\be\?\.name\b/g, /\bdata\.payload\b/g,
    /\bString\(message \?\? ''\)\.length\b/g, /\bBuffer\.byteLength\(call\.text\)/g, /'[^']*'/g, /`[^`$]*`/g,
  ]
  for (const file of ['index.mjs', 'queue.mjs', 'send.mjs', 'reader.mjs']) {
    const source = await readFile(new URL(`../${file}`, import.meta.url), 'utf8')
    const calls = source.split('\n').filter(line => /^\s*(log|console\.log)\(/.test(line))
    assert.ok(calls.length > 0, file)
    for (const call of calls) {
      const rest = allowed.reduce((text, expression) => text.replace(expression, ''), call)
      assert.doesNotMatch(rest, /\b(url|message|data|secret|body|signature|headers|call|callReturnText|text|e)\b/, `${file}: ${call.trim()}`)
    }
  }
})
