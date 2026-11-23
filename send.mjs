// import tx2 from 'tx2'
// const metric = tx2.metric({
//   name: 'Current requests'
// })

import debug from 'debug'
const log = debug('xummproxy:send-fetch')
import crypto from 'crypto'

import {config} from './config.mjs'
import {deliverWithin, deliveryTimeout} from './deliver.mjs'
import {createLimiter, limitsFrom} from './limits.mjs'

// let destructing = false

// process.on('SIGINT', function () {
//   destructing = true
// })

// For one attempt, all of it: the request, the redirects and the read of the response (deliver.mjs)
const timeout = deliveryTimeout // 15 seconds

const skipFrom = 10 // answers with 404 on the last attempt, in the past hour
const hour = 60 * 60 * 1000

// The host of the destination: the key of the limit per host. A redirect stays on this host (deliver.mjs).
export const hostOf = url => {
  try {
    return new URL(String(url)).hostname.toLowerCase().replace(/\.+$/, '')
  } catch (e) {
    return '' // Not a URL: refused in deliver()
  }
}

/**
 * The 404 answers on the last attempt in the past hour, for this exact URL.
 * 'url = :url' follows the collation of the column (it does not see case and accents; it can use an index on url),
 * the comparison as bytes is the exact one.
 */
export const notFoundQuery = `
  SELECT
    payload, url
  FROM
    calls
  WHERE
    response_code = 404
    AND
    attempt = 5
    AND
    moment > DATE_SUB(NOW(), INTERVAL 1 HOUR)
    AND
    url = :url
    AND
    CAST(url AS BINARY) = CAST(:url AS BINARY)
`

/**
 * query: the database (database.mjs). The other options are for the tests.
 * Returns send() and pending(): the deliveries that are not finished (waiting, running, or with a retry to come).
 */
export const createSender = ({
  query,
  deliver = deliverWithin,
  limiter = createLimiter(limitsFrom(config)),
  schedule = setTimeout,
  clock = Date.now,
}) => {
  let currentCalls = 0

  // A failed write of the log must not end the delivery
  const record = (sql, params) => Promise.resolve().then(() => query(sql, params)).catch(e => {
    log('Not recorded', { payload: params?.payload }, e.message)
  })

  const scheduleRetry = async (url, data, payload, secret, nextAttempt) => {
    if (nextAttempt < 6) {
      currentCalls++
      // if (!destructing) {
      //   metric.set(currentCalls)
      // }
      const nextTimeout =  nextAttempt < 3
        ? 10
        : nextAttempt > 3
          ? 600
          : 60
      log('Schedule next attempt + in (sec)', { payload, nextAttempt, nextTimeout })
      schedule(function () {
        send(url, data, payload, secret, nextAttempt)
      }, nextTimeout * 1000)
    }
  }

  // The table has no application: the application of a payload that ended with a 404 is kept here, for two hours
  // (the query looks back one hour). After a restart it is empty: nothing is skipped until there are new 404 answers.
  const notFound = new Map() // payload: {application, at}

  const noteNotFound = (payload, application) => {
    const now = clock()
    for (const [key, value] of notFound) {
      if (now - value.at < 2 * hour) break
      notFound.delete(key)
    }
    notFound.delete(payload)
    notFound.set(payload, { application, at: now })
  }

  /**
   * The skip list is per application and per exact URL: only the 404 answers to this application's own payloads
   * count, on a URL that is the same in every byte. A job without an application is never skipped, and a check that
   * fails skips nothing.
   */
  const urlInvalid = async (url, application) => {
    if (application === '') return false
    try {
      const rows = await query(notFoundQuery, { url })
      if (!Array.isArray(rows)) return false
      return rows.filter(row => row.url === url && notFound.get(row.payload)?.application === application).length >= skipFrom
    } catch (e) {
      log('Skip list not checked', { url }, e.message)
      return false
    }
  }

  // One attempt. It has a place of the limits (limits.mjs) from the start to the end.
  const attemptDelivery = async (url, data, payload, secret, attempt) => {
    const application = String(data?.meta?.application_uuidv4 || '')

    const skipUrl = await urlInvalid(url, application)
    if (skipUrl) {
      log('Skipping URL', url)
      record(`
        INSERT INTO calls (
          payload, url, response_code, response_message, attempt, error
        ) VALUES (
          :payload, SUBSTR(:url, 1, 125), 999, 'Skipped, exceeding 404 limits on similar URL in past hour', 10, 'Skipped, exceeding 404 limits on similar URL in past hour'
        )
      `, { payload, url, })
      return
    }

    log('Calling webhook', { url, data })

    try {
      const body = JSON.stringify(data || {})
      const now = String(Math.round(new Date() / 1000))
      const signature = crypto.createHmac('sha1', secret.replace('-', '')).update(now + body).digest('hex')

      // Public destinations only, also for every redirect: see deliver.mjs
      const call = await deliver(url, {
        method: 'post',
        headers: {
          // 'content-type': 'application/json;charset=UTF-8',
          'content-type': 'application/json',
          'user-agent': 'xumm-webhook',
          'x-xumm-attempt': attempt,
          'x-xumm-payload': payload,
          'x-xumm-request-timestamp': now,
          'x-xumm-request-signature': signature,
        },
        body,
        // The application of this webhook (set by the backend): for destinations on our own domains
        application: data?.meta?.application_uuidv4
      }, { timeout })

      const callReturnCode = call.status
      // const callReturnText = call.headers.join(`\n`).trim() + `\n----\nBody:\n` + (await call.text()).trim()
      const callReturnText = Object.keys({...call.headers.raw()}).map(k => `${k}: ${{...call.headers.raw()}[k]}`).join(`\n`).trim() +
        `\nBody:\n` +
        call.text.trim()

      if (
        callReturnCode !== 200 &&
        callReturnCode !== 201 &&
        callReturnCode !== 204
      ) {
        scheduleRetry(url, data, payload, secret, attempt + 1)
      }

      log({ payload, c: callReturnCode, t: callReturnText.replace(/[ \t\r\n]{1,}/g, ' ').slice(0, 200) })

      if (callReturnCode === 404 && attempt === 5) {
        noteNotFound(payload, application)
      }

      record(`
        INSERT INTO calls (
          payload, url, response_code, response_message, attempt
        ) VALUES (
          :payload, SUBSTR(:url, 1, 125), :callReturnCode, SUBSTR(:callReturnText, 1, 4500), :attempt
        )
      `, {
        payload, url, callReturnCode, callReturnText, attempt
      })
    } catch (e) {
      // The time limit (no answer in time, or a response that does not finish): retried as before
      if (e?.timeout) {
        scheduleRetry(url, data, payload, secret, attempt + 1)
      }

      log('Call failed (caught)', { payload, url }, e.message)

      record(`
        INSERT INTO calls (
          payload, url, attempt, error
        ) VALUES (
          :payload, SUBSTR(:url, 1, 125), :attempt, SUBSTR(:error, 1, 100)
        )
      `, {
        payload, url, attempt, error: e.message
      })
    }
  }

  const send = async (url, data, payload, secret, attempt = 1) => {
    // A first attempt counts from here, also while it waits for its turn. A retry counts from when it was scheduled.
    if (attempt === 1) {
      currentCalls++
      // if (!destructing) {
      //   metric.set(currentCalls)
      // }
    }

    try {
      const host = hostOf(url)
      if (!limiter.open(host)) {
        log('Waiting for a free place', { payload, host, ...limiter.stats() })
      }
      await limiter.run(host, () => attemptDelivery(url, data, payload, secret, attempt))
    } catch (e) {
      log('Attempt failed', { payload, url }, e.message)
    }

    currentCalls--
    // if (!destructing) {
    //   metric.set(currentCalls)
    // }
  }

  return {
    send,
    pending: () => currentCalls,
    limiter,
  }
}
