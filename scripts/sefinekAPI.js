const { axios } = require('../services/axios.js');
const { readReportedIPs, updateSefinekAPIInCSV } = require('./csv.js');
const log = require('./log.js');

const SEFINEK_API_URL = `${process.env.NODE_ENV === 'production' ? 'https://api.sefinek.net' : 'http://127.0.0.1:4010'}/api/v2/cloudflare-waf-abuseipdb/post`;

module.exports = async () => {
	const reportedIPs = readReportedIPs().filter(ip => ip.action === 'Reported' && ip.sefinekAPI === 'false');
	if (reportedIPs.length === 0) {
		return log('info', 'No reported IPs with action "Reported" and SefinekAPI false to send to Sefinek API');
	}

	const uniqueLogs = reportedIPs.reduce((acc, ip) => {
		if (!acc.seen.has(ip.ip)) {
			acc.seen.add(ip.ip);
			acc.logs.push(ip);
		}
		return acc;
	}, { seen: new Set(), logs: [] }).logs;

	if (uniqueLogs.length === 0) return log('info', 'No unique IPs to send');

	try {
		const res = await axios.post(SEFINEK_API_URL, {
			reportedIPs: uniqueLogs.map(ip => ({
				rayId: ip.rayId,
				ip: ip.ip,
				endpoint: ip.endpoint,
				useragent: ip.useragent.replace(/"/g, ''),
				action: ip.action,
				country: ip.country
			}))
		});

		log('info', `Logs (${res.data.count}) sent to Sefinek API. Status: ${res.status}`);

		uniqueLogs.forEach(ip => updateSefinekAPIInCSV(ip.rayId, true));
	} catch (err) {
		log('error', `Failed to send logs to Sefinek API. Error: ${err.message}`);
	}
};
