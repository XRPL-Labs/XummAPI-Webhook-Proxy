import debug from 'debug'
import {errorCode} from './logtext.mjs'

const defaultLog = debug('xummproxy:reader')

// The text of an error of a read (an answer of the server, or of the client library), short and without a URL
const reason = e => String(e?.message ?? e).replace(/\b[a-z][a-z0-9+.-]*:\/\/\S*/gi, '(url)').slice(0, 120)

const positive = (value, fallback) => {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : fallback
}

/**
 * The connection of the queue reader (options for the Redis client).
 * - keepAlive: the first TCP keepalive probe after this time without traffic (ms). Without it the system default
 *   counts (hours), and a peer that is gone without a close is not seen for that long.
 * - A read that waits when the connection ends is sent again after the reconnect (autoResendUnfulfilledCommands),
 *   and waits for the connection without a limit on the attempts (maxRetriesPerRequest: null).
 * The reconnect itself is the one of the client library (its default retryStrategy).
 * PROXY_CONFIG_REDIS_KEEPALIVE: seconds, default 15.
 */
export const connectionOptions = (config = {}) => ({
  keepAlive: Math.round(positive(config.REDIS_KEEPALIVE, 15) * 1000),
  connectTimeout: 10_000,
  autoResendUnfulfilledCommands: true,
  maxRetriesPerRequest: null,
})

/**
 * The settings of the reader, from the configuration (all optional):
 * PROXY_CONFIG_QUEUE_READ_TIMEOUT   seconds one read waits for a message (default 10, whole seconds)
 * PROXY_CONFIG_QUEUE_READ_GRACE     seconds more without an answer before the connection is made again (default 10)
 * PROXY_CONFIG_QUEUE_SILENT_MINUTES minutes without any answer before the log line 'Queue reader silent' (default 5)
 */
export const settingsFrom = (config = {}) => ({
  timeout: Math.max(1, Math.round(positive(config.QUEUE_READ_TIMEOUT, 10))),
  grace: positive(config.QUEUE_READ_GRACE, 10),
  silentAfter: positive(config.QUEUE_SILENT_MINUTES, 5) * 60,
})

/**
 * Reads the queue (a Redis list), one message at a time, and gives every message to handle(), once.
 *
 * - One read is BLPOP with a time limit. The answer 'no message in this time' (null) is normal: the next read starts.
 *   So the server answers at least every `timeout` seconds, and the reader knows that the connection works.
 * - There is one read at a time, and a read is never given up: its answer, also a late one, is handled. A message
 *   that the reader received is handled once.
 * - No answer `grace` seconds after the time limit (while the client says it is connected): the connection is made
 *   again, with the reconnect of the client library (client.disconnect(true)). The client sends the read that waits
 *   again on the new connection, and the loop goes on.
 * - A read that fails (an error answer, a client that is closed) is logged and tried again, after 1 second and then
 *   with more time between the tries (30 seconds at most).
 * - stop(): no new read. The read that waits is finished first (its message is handled), for `timeout` + `grace`
 *   seconds at most.
 *
 * Log lines (no message content): 'Queue reader reconnected', 'Queue reader: no answer, connection reset',
 * 'Queue reader silent' (once for each time without answers that is longer than `silentAfter`), 'Queue read failed'.
 *
 * client: blpop(key, seconds), disconnect(reconnect), on(event, listener), status ('ready' when connected).
 * The other options are for the tests.
 */
export const createReader = ({
  client,
  channel,
  handle,
  timeout = 10, // seconds
  grace = 10, // seconds
  silentAfter = 5 * 60, // seconds
  retryAfter = 1, // seconds, after a read that failed
  log = defaultLog,
  clock = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) => {
  let running = false
  let ended = true
  let reading = false
  let watchdog = null
  let wake = null
  let lastAnswerAt = clock()
  let silentReported = false
  let connections = client.status === 'ready' ? 1 : 0
  const counts = {reads: 0, messages: 0, resets: 0, reconnects: 0, failures: 0}
  const endWaiters = []

  const connected = () => client.status === 'ready'

  const disarm = () => {
    if (watchdog !== null) {
      clearTimer(watchdog)
      watchdog = null
    }
  }

  const arm = () => {
    disarm()
    watchdog = setTimer(noAnswer, (timeout + grace) * 1000)
  }

  // One line for each time without answers
  const checkSilent = () => {
    const silentFor = clock() - lastAnswerAt
    if (!silentReported && silentFor >= silentAfter * 1000) {
      silentReported = true
      log('Queue reader silent', { minutes: Math.floor(silentFor / 60_000), connected: connected() })
    }
  }

  // The read that waits got no answer in time
  function noAnswer () {
    watchdog = null
    checkSilent()
    // Not connected: the client library is busy with the reconnect, the read waits for it
    if (connected()) {
      counts.resets++
      log('Queue reader: no answer, connection reset', { seconds: Math.round((clock() - lastAnswerAt) / 1000) })
      try {
        client.disconnect(true)
      } catch (e) {
        log('Queue reader: connection reset failed', errorCode(e))
      }
    }
    if (reading) arm()
  }

  // Connected (again): the client sends the read that waits now, so its time starts now
  client.on('ready', () => {
    connections++
    if (connections > 1) {
      counts.reconnects++
      log('Queue reader reconnected', { reconnects: counts.reconnects })
    }
    if (reading) arm()
  })

  const pause = seconds => new Promise(resolve => {
    const done = () => {
      wake = null
      resolve()
    }
    const timer = setTimer(done, seconds * 1000)
    wake = () => {
      clearTimer(timer)
      done()
    }
  })

  const answered = () => {
    lastAnswerAt = clock()
    silentReported = false
  }

  const run = async () => {
    if (running || !ended) return
    running = true
    ended = false
    lastAnswerAt = clock()
    let failed = 0

    while (running) {
      let answer
      reading = true
      counts.reads++
      arm()
      try {
        answer = await client.blpop(channel, timeout)
      } catch (e) {
        reading = false
        disarm()
        counts.failures++
        failed++
        log('Queue read failed', errorCode(e), reason(e))
        checkSilent()
        if (running) await pause(Math.min(retryAfter * 2 ** (failed - 1), 30))
        continue
      }
      reading = false
      disarm()
      failed = 0
      answered()

      // null: no message in this time. Read again.
      if (!Array.isArray(answer) || answer[0] !== channel) continue

      counts.messages++
      try {
        const result = handle(answer[1])
        if (typeof result?.catch === 'function') result.catch(e => log('Queue message not handled', errorCode(e)))
      } catch (e) {
        log('Queue message not handled', errorCode(e))
      }
    }

    ended = true
    endWaiters.splice(0).forEach(resolve => resolve())
  }

  /**
   * No new read. Resolves when the read that waits is finished, or after `timeout` + `grace` seconds when it gets no
   * answer (true: finished, false: not finished).
   */
  const stop = () => {
    running = false
    if (wake) wake()
    if (ended) return Promise.resolve(true)
    return new Promise(resolve => {
      const timer = setTimer(() => resolve(false), (timeout + grace) * 1000)
      endWaiters.push(() => {
        clearTimer(timer)
        resolve(true)
      })
    })
  }

  return {
    run,
    stop,
    stats: () => ({ ...counts, connected: connected(), running, reading }),
  }
}
