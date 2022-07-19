import {config} from './config.mjs'

import debug from 'debug'
const log = debug('xummproxy:config')

import ioredis from 'ioredis'

const channel = 'PAYLOADS_WEBHOOK'

const redis = new ioredis({
  host: config.REDIS_HOST,
  port: Number(config?.REDIS_PORT || 6379),
  password: config?.REDIS_PASSWORD || undefined,
  tls: Boolean(config?.REDIS_TLS || false),
  autoResendUnfulfilledCommands: true,
  maxRetriesPerRequest: null
})

redis.on('connect', _ => log('REDIS connected'))
redis.on('ready', _ => log('REDIS ready'))
redis.on('close', _ => log('REDIS closed'))
redis.on('error', e => log('REDIS { ERROR }', e.message))

export {
  redis,
  channel
}
