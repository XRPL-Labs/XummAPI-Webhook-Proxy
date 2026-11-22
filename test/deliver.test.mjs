// node --test test/
import test from 'node:test'
import assert from 'node:assert/strict'
import {publicAddress, publicLookup, validUrl, protectedRefused, sameHost} from '../resolve.mjs'
import {deliver, maxRedirects, redirectRefused} from '../deliver.mjs'

const notPublic = [
  '127.0.0.1', '127.1.2.3', '10.0.0.1', '10.133.0.10', '172.16.0.1', '192.168.1.1', '169.254.169.254', '0.0.0.0',
  '100.64.0.1', '198.18.0.1', '192.0.2.1', '224.0.0.1', '240.0.0.1', '255.255.255.255',
  '::1', '::', 'fe80::1', 'fd00::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', '::ffff:169.254.169.254',
  '64:ff9b::7f00:1', '2002:7f00:1::', 'not an address', '',
]
const isPublic = ['8.8.8.8', '1.1.1.1', '164.92.156.104', '2606:4700::1111', '::ffff:8.8.8.8']

test('publicAddress: only global unicast addresses', () => {
  for (const a of notPublic) assert.equal(publicAddress(a), false, a)
  for (const a of isPublic) assert.equal(publicAddress(a), true, a)
})

test('validUrl: refuses what is not a public http(s) destination, in any notation', async () => {
  const refusedUrls = [
    'http://127.0.0.1/', 'http://127.0.0.1:6500/x', 'http://[::1]/', 'http://[::ffff:127.0.0.1]/', 'http://[::ffff:7f00:1]/',
    'http://0.0.0.0/', 'http://[::]/', 'http://169.254.169.254/metadata/v1.json', 'http://10.133.0.10:3306/',
    'http://2130706433/', 'http://0x7f000001/', 'http://0x7f.1/', 'http://127.1/', 'http://017700000001/',
    'http://localhost/', 'http://localhost.:80/', 'https://user:pass@8.8.8.8/', 'http://user@8.8.8.8/',
    'file:///etc/passwd', 'ftp://8.8.8.8/', 'gopher://8.8.8.8/', '/relative', './relative', 'http://', 'not a url', '',
  ]
  for (const u of refusedUrls) assert.equal(await validUrl(u), false, u)
  for (const u of ['http://8.8.8.8/', 'https://1.1.1.1:8443/hook?a=b', 'https://[2606:4700::1111]/']) assert.equal(await validUrl(u), true, u)
})

test('publicLookup: a name that resolves to a local address is refused at connect time', async () => {
  const err = await new Promise(resolve => publicLookup('localhost', {all: true}, e => resolve(e)))
  assert.equal(err?.code, 'EDESTNOTPUBLIC')
})

// A fake HTTP client: answers per URL, records every request
const client = answers => {
  const seen = []
  const fetch = async (url, options) => {
    seen.push({url, method: options.method, body: options.body, headers: options.headers, redirect: options.redirect, hasAgent: typeof options.agent === 'function', size: options.size})
    const a = answers[url] || {status: 200}
    return {status: a.status, headers: {get: name => (name === 'location' ? a.location || null : null)}}
  }
  return {fetch, seen}
}
const request = {method: 'post', headers: {'content-type': 'application/json', 'x-xumm-payload': 'p'}, body: '{}'}

test('deliver: no redirect: one request, redirects are never followed by the HTTP client', async () => {
  const {fetch, seen} = client({})
  const call = await deliver('https://8.8.8.8/hook', request, {fetch})
  assert.equal(call.status, 200)
  assert.equal(seen.length, 1)
  assert.deepEqual({redirect: seen[0].redirect, hasAgent: seen[0].hasAgent, method: seen[0].method, body: seen[0].body}, {redirect: 'manual', hasAgent: true, method: 'post', body: '{}'})
  assert.ok(seen[0].size > 0)
})

test('deliver: a redirect to a local address is refused, no request is made to it', async () => {
  for (const location of ['http://127.0.0.1/', 'http://169.254.169.254/metadata/v1.json', 'http://10.133.0.10:3306/', 'http://[::ffff:127.0.0.1]/', 'http://localhost:6500/', 'file:///etc/passwd']) {
    for (const status of [301, 302, 303, 307, 308]) {
      const {fetch, seen} = client({'https://8.8.8.8/w': {status, location}})
      await assert.rejects(deliver('https://8.8.8.8/w', request, {fetch}), e => e.message === redirectRefused, status + ' ' + location)
      assert.deepEqual(seen.map(s => s.url), ['https://8.8.8.8/w'], status + ' ' + location)
    }
  }
})

test('deliver: a redirect to another host is not followed, also when that host is public', async () => {
  const {fetch, seen} = client({'https://8.8.8.8/a': {status: 307, location: 'https://1.1.1.1/b'}})
  await assert.rejects(deliver('https://8.8.8.8/a', request, {fetch, protect: {}}), e => e.message === redirectRefused)
  assert.deepEqual(seen.map(s => s.url), ['https://8.8.8.8/a'])
})

test('deliver: a chain on the same host that ends at a local address stops before the local hop', async () => {
  const {fetch, seen} = client({'https://8.8.8.8/a': {status: 307, location: '/b'}, 'https://8.8.8.8/b': {status: 302, location: 'http://10.0.0.5/'}})
  await assert.rejects(deliver('https://8.8.8.8/a', request, {fetch, protect: {}}), e => e.message === redirectRefused)
  assert.deepEqual(seen.map(s => s.url), ['https://8.8.8.8/a', 'https://8.8.8.8/b'])
})

test('deliver: a redirect to a public address is followed, with the method rules of before', async () => {
  for (const [status, method, body] of [[301, 'get', undefined], [302, 'get', undefined], [303, 'get', undefined], [307, 'post', '{}'], [308, 'post', '{}']]) {
    const {fetch, seen} = client({'http://8.8.8.8/hook': {status, location: 'https://8.8.8.8/hook'}})
    const call = await deliver('http://8.8.8.8/hook', request, {fetch})
    assert.equal(call.status, 200, String(status))
    assert.deepEqual(seen.map(s => [s.url, s.method, s.body]), [['http://8.8.8.8/hook', 'post', '{}'], ['https://8.8.8.8/hook', method, body]], String(status))
    assert.equal(seen[1].headers['x-xumm-payload'], 'p')
    assert.equal('content-type' in seen[1].headers, method === 'post')
  }
})

test('deliver: a relative redirect stays on the same host', async () => {
  const {fetch, seen} = client({'https://8.8.8.8/a/b': {status: 307, location: '../c'}})
  await deliver('https://8.8.8.8/a/b', request, {fetch})
  assert.deepEqual(seen.map(s => s.url), ['https://8.8.8.8/a/b', 'https://8.8.8.8/c'])
})

test('deliver: a redirect loop ends: the last redirect is the result', async () => {
  const {fetch, seen} = client({'https://8.8.8.8/loop': {status: 307, location: 'https://8.8.8.8/loop'}})
  const call = await deliver('https://8.8.8.8/loop', request, {fetch})
  assert.equal(call.status, 307)
  assert.equal(seen.length, maxRedirects + 1)
})

test('deliver: a first URL that is not public is refused without a request', async () => {
  const {fetch, seen} = client({})
  await assert.rejects(deliver('http://[::ffff:127.0.0.1]/', request, {fetch}), e => e.message === 'Invalid URL')
  assert.equal(seen.length, 0)
  assert.equal(redirectRefused, 'Invalid URL (redirect)')
})

const protect = {domains: 'example-corp.com, example-app.io', allowed: 'https://desk.example-corp.com/api/voucher/webhook, https://example-app.io/xapp/kyc'}

test('sameHost', () => {
  assert.equal(sameHost('http://a.example/x', 'https://A.example:8443/y'), true)
  assert.equal(sameHost('https://a.example/', 'https://www.a.example/'), false)
  assert.equal(sameHost('https://a.example/', 'not a url'), false)
})

test('protectedRefused: our own domains only for the exact first-party URLs', () => {
  for (const u of ['https://desk.example-corp.com/api/voucher/webhook', 'https://desk.example-corp.com/api/voucher/webhook/', 'https://desk.example-corp.com/api/voucher/webhook?x=1', 'https://EXAMPLE-app.io/xapp/kyc']) assert.equal(protectedRefused(u, protect), false, u)
  for (const u of ['https://desk.example-corp.com/', 'https://desk.example-corp.com/api/voucher', 'https://desk.example-corp.com/api/voucher/webhook/../../login', 'https://desk.example-corp.com/api/voucher/webhook%2f..%2f..%2flogin', 'http://desk.example-corp.com/api/voucher/webhook',
    'https://desk.example-corp.com:8443/api/voucher/webhook', 'https://metabase.example-corp.com/api/session/properties', 'https://example-corp.com/', 'https://a.b.example-corp.com/x', 'https://example-app.io/', 'https://example-app.io./xapp/other']) assert.equal(protectedRefused(u, protect), true, u)
  // Not ours: never refused by this rule
  for (const u of ['https://hooks.example.net/x', 'https://notexample-corp.com/', 'https://example-corp.com.evil.example/', 'not a url']) assert.equal(protectedRefused(u, protect), false, u)
  // No list in the configuration: nothing is protected
  assert.equal(protectedRefused('https://metabase.example-corp.com/', {}), false)
  assert.equal(protectedRefused('https://metabase.example-corp.com/', undefined), false)
})

test('deliver: a first URL on a protected domain is refused without a request, the exact first-party URL is delivered', async () => {
  const a = client({})
  await assert.rejects(deliver('https://metabase.example-corp.com/api/session/properties', request, {fetch: a.fetch, check: async () => true, protect}), e => e.message === 'Invalid URL')
  assert.equal(a.seen.length, 0)
  const b = client({})
  const call = await deliver('https://desk.example-corp.com/api/voucher/webhook', request, {fetch: b.fetch, check: async () => true, protect})
  assert.equal(call.status, 200)
  assert.equal(b.seen.length, 1)
})

test('deliver: a public URL that redirects to a protected domain is refused, no request reaches our site', async () => {
  for (const location of ['https://desk.example-corp.com/', 'https://desk.example-corp.com/api/voucher/webhook', 'https://metabase.example-corp.com/api/user/current']) {
    const {fetch, seen} = client({'https://tunnel.example.net/w': {status: 307, location}})
    await assert.rejects(deliver('https://tunnel.example.net/w', request, {fetch, check: async () => true, protect}), e => e.message === redirectRefused, location)
    assert.deepEqual(seen.map(s => s.url), ['https://tunnel.example.net/w'], location)
  }
})
