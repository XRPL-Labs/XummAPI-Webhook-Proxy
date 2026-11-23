// node --test test/*.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import {createLimiter, limitsFrom, defaultLimits} from '../limits.mjs'

// A task that ends when the test says so
const gate = () => {
  let open
  const wait = new Promise(resolve => { open = resolve })
  return {wait, open}
}
const tick = () => new Promise(resolve => setImmediate(resolve))

test('limitsFrom: the configuration, or the defaults', () => {
  assert.deepEqual(defaultLimits, {total: 200, perHost: 20})
  assert.deepEqual(limitsFrom({}), defaultLimits)
  assert.deepEqual(limitsFrom(undefined), defaultLimits)
  assert.deepEqual(limitsFrom({MAX_DELIVERIES: '50', MAX_DELIVERIES_PER_HOST: '5'}), {total: 50, perHost: 5})
  for (const bad of ['', '0', '-1', '1.5', 'many', null]) {
    assert.deepEqual(limitsFrom({MAX_DELIVERIES: bad, MAX_DELIVERIES_PER_HOST: bad}), defaultLimits, String(bad))
  }
})

test('limiter: the result and the error of the task, and the place is free afterwards', async () => {
  const limiter = createLimiter({total: 2, perHost: 1})
  assert.equal(await limiter.run('a.example.com', async () => 'done'), 'done')
  await assert.rejects(limiter.run('a.example.com', async () => { throw new Error('failed') }), /failed/)
  await assert.rejects(limiter.run('a.example.com', () => { throw new Error('failed at once') }), /failed at once/)
  assert.deepEqual(limiter.stats(), {running: 0, waiting: 0, hosts: 0})
  assert.equal(limiter.open('a.example.com'), true)
})

test('limiter: never more than the limit per host, and the tasks of one host start in order of arrival', async () => {
  const limiter = createLimiter({total: 100, perHost: 3})
  const started = []
  const gates = []
  let now = 0
  let most = 0
  const jobs = []
  for (let i = 0; i < 10; i++) {
    const g = gate()
    gates.push(g)
    jobs.push(limiter.run('slow.example.com', async () => {
      started.push(i)
      most = Math.max(most, ++now)
      await g.wait
      now--
    }))
  }
  await tick()
  assert.deepEqual(started, [0, 1, 2])
  assert.deepEqual(limiter.stats(), {running: 3, waiting: 7, hosts: 1})
  assert.equal(limiter.open('slow.example.com'), false)

  // Ends out of order: the next one to start is always the one that waits longest
  for (const i of [2, 0, 1, 5, 4, 3, 9, 8, 7, 6]) {
    gates[i].open()
    await tick()
  }
  await Promise.all(jobs)
  assert.deepEqual(started, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
  assert.equal(most, 3)
  assert.deepEqual(limiter.stats(), {running: 0, waiting: 0, hosts: 0})
})

test('limiter: many slow tasks for one host do not delay a task for another host', async () => {
  const limiter = createLimiter({total: 100, perHost: 4})
  const g = gate()
  let slowStarted = 0
  const slow = []
  for (let i = 0; i < 50; i++) slow.push(limiter.run('slow.example.com', async () => { slowStarted++; await g.wait }))
  await tick()
  assert.equal(slowStarted, 4)
  assert.equal(limiter.stats().waiting, 46)

  // The other host has a free place: it starts at once and ends while all the slow ones are still there
  assert.equal(limiter.open('other.example.org'), true)
  assert.equal(await limiter.run('other.example.org', async () => 'delivered'), 'delivered')
  assert.equal(slowStarted, 4)
  assert.deepEqual(limiter.stats(), {running: 4, waiting: 46, hosts: 1})

  g.open()
  await Promise.all(slow)
  assert.equal(slowStarted, 50)
  assert.deepEqual(limiter.stats(), {running: 0, waiting: 0, hosts: 0})
})

test('limiter: never more than the limit for all hosts together', async () => {
  const limiter = createLimiter({total: 5, perHost: 2})
  const gates = []
  let now = 0
  let most = 0
  const perHost = {}
  let mostPerHost = 0
  const jobs = []
  for (let i = 0; i < 40; i++) {
    const host = `h${i % 3}.example.com`
    const g = gate()
    gates.push(g)
    jobs.push(limiter.run(host, async () => {
      most = Math.max(most, ++now)
      perHost[host] = (perHost[host] || 0) + 1
      mostPerHost = Math.max(mostPerHost, perHost[host])
      await g.wait
      now--
      perHost[host]--
    }))
  }
  await tick()
  assert.deepEqual(limiter.stats(), {running: 5, waiting: 35, hosts: 3})
  for (const g of gates) {
    g.open()
    await tick()
  }
  await Promise.all(jobs)
  assert.equal(most, 5)
  assert.equal(mostPerHost, 2)
  assert.deepEqual(limiter.stats(), {running: 0, waiting: 0, hosts: 0})
})

test('limiter: at the limit for all hosts, the hosts that wait take turns', async () => {
  const limiter = createLimiter({total: 1, perHost: 1})
  const started = []
  const first = gate()
  const jobs = [limiter.run('first.example.com', () => first.wait)]
  // One host with many waiting tasks, then two hosts with one task each
  for (let i = 0; i < 5; i++) jobs.push(limiter.run('busy.example.com', async () => { started.push('busy' + i) }))
  jobs.push(limiter.run('b.example.org', async () => { started.push('b') }))
  jobs.push(limiter.run('c.example.org', async () => { started.push('c') }))
  await tick()
  assert.deepEqual(started, [])
  first.open()
  await Promise.all(jobs)
  // Not behind all the tasks of the busy host: after its first one
  assert.deepEqual(started, ['busy0', 'b', 'c', 'busy1', 'busy2', 'busy3', 'busy4'])
})

test('limiter: a long list of waiting tasks is worked off in order', async () => {
  const limiter = createLimiter({total: 3, perHost: 2})
  const order = []
  const jobs = []
  for (let i = 0; i < 5000; i++) jobs.push(limiter.run('busy.example.com', async () => { order.push(i) }))
  assert.equal(limiter.stats().waiting, 4998)
  await Promise.all(jobs)
  assert.equal(order.length, 5000)
  assert.ok(order.every((n, i) => n === i))
  assert.deepEqual(limiter.stats(), {running: 0, waiting: 0, hosts: 0})
})
