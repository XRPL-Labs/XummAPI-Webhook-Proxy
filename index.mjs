// import tx2 from 'tx2'
// const counter = tx2.counter({
//   name: 'Historic Requests'
// })

import {createSender} from './send.mjs'
import {query} from './database.mjs'
import {redis, channel as redisChannel} from './redis.mjs'
import {apiserver} from './apiserver.mjs'

import debug from 'debug'
const log = debug('xummproxy')

// Limits for the deliveries at the same time: PROXY_CONFIG_MAX_DELIVERIES, PROXY_CONFIG_MAX_DELIVERIES_PER_HOST
const sender = createSender({query})

process.on('unhandledRejection', e => {
  console.log('An unhandledRejection occurred', e)
})

apiserver.start()

let processing = true

process.on('SIGINT', function () {
  apiserver.close()

  if (processing) {
    log('Graceful Stop, unsubscribing from Redis and cleaning up...')
    // redis.unsubscribe(redisChannel)
    setInterval(function () {
      log('Waiting for current calls to finish...', sender.pending(), sender.limiter.stats())
      if (sender.pending() < 1) {
        log('Ended. Shutting down in 3 sec.')

        setTimeout(function () {
          process.exit(0)
        }, 3000)
      }
    }, 3000)
  }

  processing = false

  return false
})

while (processing) {
  log('BLPOP')
  const [channel, message] = await redis.blpop(redisChannel, 0)
  log('REDIS message received', { channel, message })
  if (redisChannel === channel) {
    try {
      const data = JSON.parse(message)
      if (typeof data.url === 'string' && typeof data.payload === 'string') {
        if (typeof data.data === 'object' && data) {
          log('Valid REDIS message, process...', data)
          // if (processing) {
          //   counter.inc()
          // }
          sender.send(data.url, data.data, data.payload, data?.secret || '')
        } else {
          log('Invalid message, missing data object')
        }
      } else {
        log('Invalid message, missing url/payload')
      }
    } catch (e) {
      log('Error decoding REDIS message', e.message)
    }
  }
}
