import {redis, channel} from './redis.mjs'

import debug from 'debug'
const log = debug('xummproxy:test')

setTimeout(function () {
  redis.rpush(channel, JSON.stringify({
    url: 'https://webhook.site/3ba50d49-56f1-4a5d-8fd5-ba75c5ded08f',
    payload: '3ba50d49-56f1-4a5d-8fd5-ba75c5ded08f',
    data: {
      someData: true,
      name: 'Wietse'
    }
  }))

  setTimeout(function () {
    redis.disconnect()
  }, 500)
}, 1500)
