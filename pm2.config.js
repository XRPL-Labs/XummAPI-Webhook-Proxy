const path = require('path'); 
require('dotenv').config({ path: path.join(__dirname, '.env') })

module.exports = {
  apps: [{
    name: 'webhookproxy',
    script: 'index.mjs',
    watch: false,
    instances: 1,
    exec_mode: 'cluster',
    ignore_watch: ["node_modules", "db", ".git"],
    env: {
      ...process.env,
      DEBUG: 'xummproxy*'
    }
  }]
}
