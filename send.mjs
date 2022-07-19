// import tx2 from 'tx2'
// const metric = tx2.metric({
//   name: 'Current requests'
// })

import debug from 'debug'
const log = debug('xummproxy:send-fetch')

import {query} from './database.mjs'
import {validUrl} from './resolve.mjs'
import fetch from 'node-fetch'

// let destructing = false

// process.on('SIGINT', function () {
//   destructing = true
// })

let currentCalls = 0

const timeout = 15_000 // ms

const scheduleRetry = async (url, data, payload, nextAttempt) => {
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
      send(url, data, payload, nextAttempt)
    }, nextTimeout * 1000)
  }
}

const send = async (url, data, payload, attempt = 1) => {
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
      scheduleRetry(url, data, payload, attempt + 1)
      controller.abort()
    }, timeout)
  
    const call = await fetch(url, {
      method: 'post',
      headers: {
        'content-type': 'application/json;charset=UTF-8',
        'user-agent': 'xumm-webhook',
        'x-xumm-attempt': attempt,
        'x-xumm-payload': payload
      },
      body: JSON.stringify(data || {}),
      signal: controller.signal
    })

    clearTimeout(id)

    const callReturnCode = await call.status
    const callReturnText = await call.text()

    if (callReturnCode !== 200) {
      scheduleRetry(url, data, payload, attempt + 1)
    }

    log({ payload, c: callReturnCode, t: callReturnText.trim().replace(/[ \t\r\n]{2,}/g, ' ').slice(0, 200) })

    query(`
      INSERT INTO calls (
        payload, url, response_code, response_message, attempt
      ) VALUES (
        :payload, SUBSTR(:url, 1, 125), :callReturnCode, SUBSTR(:callReturnText, 1, 250), :attempt
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
