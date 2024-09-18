const { axios } = require('../services/axios.js');
const { readReportedIPs, updateSefinekAPIInCSV } = require('./csv.js');
const log = require('./log.js');
const clientIp = require('./clientIp.js');

const SEFINEK_API_URL = process.env.SEFINEK_API_URL || `${process.env.NODE_ENV === 'production' ? 'https://api.sefinek.net' : 'http://127.0.0.1:4010'}/api/v2/cloudflare-waf-abuseipdb/post`;

module.exports = async () => {
	const userIp = clientIp.getAddress();
	const reportedIPs = readReportedIPs().filter(x => x.status === 'REPORTED' && x.ip !== userIp && !x.sefinekAPI);
	if (reportedIPs.length === 0) return;

	const uniqueLogs = reportedIPs.reduce((acc, ip) => {
		if (acc.seen.has(ip.ip)) return acc;
		acc.seen.add(ip.ip);
		acc.logs.push(ip);
		return acc;
	}, { seen: new Set(), logs: [] }).logs;

	if (!uniqueLogs?.length) return log('log', 'No unique IPs to send to Sefinek API');

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
		}, {
			headers: { 'Authorization': process.env.SEFINEK_API_SECRET }
		});

		log('log', `Successfully sent ${res.data.count} logs to Sefinek API. Status: ${res.status}`);

		uniqueLogs.forEach(ip => updateSefinekAPIInCSV(ip.rayId, true));
	} catch (err) {
		log('error', `Failed to send logs to Sefinek API. Status: ${err.status}. Message: ${err.response?.data?.message || err.stack}`);
	}
};