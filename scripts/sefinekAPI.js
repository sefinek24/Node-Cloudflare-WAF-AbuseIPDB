const { axios } = require('../services/axios.js');
const { readReportedIPs, updateSefinekAPIInCSV } = require('./csv.js');
const log = require('./log.js');

const SEFINEK_API_URL = `${process.env.NODE_ENV === 'production' ? 'https://api.sefinek.net' : 'http://127.0.0.1:4010'}/api/v2/cloudflare-waf-abuseipdb/post`;

module.exports = async () => {
	const reportedIPs = readReportedIPs();
	if (reportedIPs.length === 0) {
		log('info', 'No reported IPs to send to Sefinek API.');
		return;
	}

	try {
		const res = await axios.post(SEFINEK_API_URL, {
			reportedIPs: reportedIPs.map(ip => ({
				rayId: ip.rayId,
				ip: ip.ip,
				endpoint: ip.endpoint,
				action: ip.action,
				country: ip.country
			}))
		});

		log('info', `Logs (${res.data.count}) sent to Sefinek API. Status: ${res.status}`);

		reportedIPs.forEach(ip => {
			updateSefinekAPIInCSV(ip.rayId, true);
		});

	} catch (err) {
		log('error', `Failed to send logs to Sefinek API. Error: ${err.message}`);
	}
};
