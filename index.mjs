import {send, currentCalls} from './send.mjs'
import {redis, channel as redisChannel} from './redis.mjs'

import debug from 'debug'
const log = debug('xummproxy')

let processing = true

process.on('SIGINT', function () {
  if (processing) {
    log('Graceful Stop, unsubscribing from Redis and cleaning up...')
    // redis.unsubscribe(redisChannel)
    setInterval(function () {
      log('Waiting for current calls to finish...', currentCalls)
      if (currentCalls < 1) {
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
          send(data.url, data.data, data.payload)
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
