const axios = require('axios');
const { version } = require('../package.json');

axios.defaults.headers.common['User-Agent'] = `Mozilla/5.0 (compatible; CF-WAF-AbuseIPDB/${version}; +https://github.com/sefinek24/Node-Cloudflare-WAF-AbuseIPDB)`;
axios.defaults.timeout = 12000;

module.exports = { axios, moduleVersion: version };