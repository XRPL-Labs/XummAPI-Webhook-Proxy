// import tx2 from 'tx2'
// const counter = tx2.counter({
//   name: 'Historic Requests'
// })

import {createSender} from './send.mjs'
import {query} from './database.mjs'
import {redis, channel as redisChannel} from './redis.mjs'
import {apiserver} from './apiserver.mjs'
import {handleMessage} from './queue.mjs'
import {errorTrace} from './logtext.mjs'

import debug from 'debug'
const log = debug('xummproxy')

// Limits for the deliveries at the same time: PROXY_CONFIG_MAX_DELIVERIES, PROXY_CONFIG_MAX_DELIVERIES_PER_HOST
const sender = createSender({query})

process.on('unhandledRejection', e => {
  console.log('An unhandledRejection occurred', errorTrace(e))
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
  log('REDIS message received', { channel, bytes: String(message ?? '').length })
  if (redisChannel === channel) {
    // if (processing) {
    //   counter.inc()
    // }
    handleMessage(message, sender.send)
  }
}
