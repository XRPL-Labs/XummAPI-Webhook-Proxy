// import tx2 from 'tx2'
// const metric = tx2.metric({
//   name: 'Current requests'
// })

import debug from 'debug'
const log = debug('xummproxy:send-fetch')
import crypto from 'crypto'

import {query} from './database.mjs'
import {validUrl} from './resolve.mjs'
import fetch from 'node-fetch'

// let destructing = false

// process.on('SIGINT', function () {
//   destructing = true
// })

let currentCalls = 0

const timeout = 15_000 // ms

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
    setTimeout(function () {
      send(url, data, payload, secret, nextAttempt)
    }, nextTimeout * 1000)
  }
}

const urlInvalid = async (url) => {
  const urlResponseError = await query(`
    SELECT
      url
    FROM (
      SELECT
        count(1) c, url
      FROM
        calls
      WHERE
        response_code = 404
        AND
        attempt = 5
        AND
        moment > DATE_SUB(NOW(), INTERVAL 1 HOUR)
      GROUP BY
        url
      ORDER BY
        count(1) DESC
    ) G1
    WHERE
      c >= 10
      AND
      url = :url
  `, {
    url
  })

  return Array.isArray(urlResponseError) && urlResponseError.length > 0
}

const send = async (url, data, payload, secret, attempt = 1) => {
  const skipUrl = await urlInvalid(url)
  if (skipUrl) {
    log('Skipping URL', url)
    query(`
      INSERT INTO calls (
        payload, url, response_code, response_message, attempt, error
      ) VALUES (
        :payload, SUBSTR(:url, 1, 125), 999, 'Skipped, exceeding 404 limits on similar URL in past hour', 10, 'Skipped, exceeding 404 limits on similar URL in past hour'
      )
    `, { payload, url, })
    return
  }

  log('Calling webhook', { url, data })

  if (attempt === 1) {
    currentCalls++
    // if (!destructing) {
    //   metric.set(currentCalls)
    // }
  }

  try {
    if (!(await validUrl(url))) {
      throw new Error('Invalid URL')
    }

    const controller = new AbortController()
    const id = setTimeout(() => {
      scheduleRetry(url, data, payload, secret, attempt + 1)
      controller.abort()
    }, timeout)

    const body = JSON.stringify(data || {})
    const now = String(Math.round(new Date() / 1000))
    const signature = crypto.createHmac('sha1', secret.replace('-', '')).update(now + body).digest('hex')
  
    const call = await fetch(url, {
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
      signal: controller.signal
    })

    clearTimeout(id)

    const callReturnCode = await call.status
    // const callReturnText = call.headers.join(`\n`).trim() + `\n----\nBody:\n` + (await call.text()).trim()
    const callReturnText = Object.keys({...call.headers.raw()}).map(k => `${k}: ${{...call.headers.raw()}[k]}`).join(`\n`).trim() +
      `\nBody:\n` +
      (await call.text()).trim()

    if (
      callReturnCode !== 200 &&
      callReturnCode !== 201 &&
      callReturnCode !== 204
    ) {
      scheduleRetry(url, data, payload, secret, attempt + 1)
    }

    log({ payload, c: callReturnCode, t: callReturnText.replace(/[ \t\r\n]{1,}/g, ' ').slice(0, 200) })

    query(`
      INSERT INTO calls (
        payload, url, response_code, response_message, attempt
      ) VALUES (
        :payload, SUBSTR(:url, 1, 125), :callReturnCode, SUBSTR(:callReturnText, 1, 4500), :attempt
      )
    `, {
      payload, url, callReturnCode, callReturnText, attempt
    })
  } catch (e) {
    log('Call failed (caught)', { payload, url }, e.message)

    query(`
      INSERT INTO calls (
        payload, url, attempt, error
      ) VALUES (
        :payload, :url, :attempt, SUBSTR(:error, 1, 100)
      )
    `, {
      payload, url, attempt, error: e.message
    })
  }

  currentCalls--
  // if (!destructing) {
  //   metric.set(currentCalls)
  // }
}

export {
  send,
  currentCalls
}
