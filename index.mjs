// import tx2 from 'tx2'
// const counter = tx2.counter({
//   name: 'Historic Requests'
// })

import {createSender} from './send.mjs'
import {query} from './database.mjs'
import {redis, channel as redisChannel} from './redis.mjs'
import {apiserver} from './apiserver.mjs'
import {handleMessage} from './queue.mjs'
import {createReader, settingsFrom} from './reader.mjs'
import {config} from './config.mjs'
import {errorTrace} from './logtext.mjs'

import debug from 'debug'
const log = debug('xummproxy')

// Limits for the deliveries at the same time: PROXY_CONFIG_MAX_DELIVERIES, PROXY_CONFIG_MAX_DELIVERIES_PER_HOST
const sender = createSender({query})

process.on('unhandledRejection', e => {
  console.log('An unhandledRejection occurred', errorTrace(e))
})

apiserver.start()

// The queue: read with a time limit, on a connection that is made again when it gives no answer (reader.mjs)
const reader = createReader({
  client: redis,
  channel: redisChannel,
  handle (message) {
    log('REDIS message received', { channel: redisChannel, bytes: String(message ?? '').length })
    // if (processing) {
    //   counter.inc()
    // }
    handleMessage(message, sender.send)
  },
  ...settingsFrom(config),
})

let processing = true
let readerStopped = false

process.on('SIGINT', function () {
  apiserver.close()

  if (processing) {
    log('Graceful Stop, unsubscribing from Redis and cleaning up...')
    // No new read of the queue. The read that waits is finished first: its message is still delivered.
    reader.stop().then(() => {
      readerStopped = true
    })
    setInterval(function () {
      log('Waiting for current calls to finish...', sender.pending(), sender.limiter.stats())
      if (sender.pending() < 1 && readerStopped) {
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

await reader.run()
