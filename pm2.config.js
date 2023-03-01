const path = require('path'); 
require('dotenv').config({ path: path.join(__dirname, '.env') })

module.exports = {
  apps: [{
    name: 'webhookproxy',
    script: 'index.mjs',
    watch: false,
    ignore_watch: ["node_modules", "db", ".git"],
    output: './out-0.log',
    error: './out-1.log',
    merge_logs: true,
    env: {
      ...process.env,
      DEBUG: 'xummproxy*'
    }
  }]
}
