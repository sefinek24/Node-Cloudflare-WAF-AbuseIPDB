require('dotenv').config();

const axios = require('axios');
const PAYLOAD = require('./scripts/payload.js');
const generateComment = require('./scripts/generateComment.js');
const isImageRequest = require('./scripts/isImageRequest.js');
const headers = require('./scripts/headers.js');
const { logToCSV, readReportedIPs } = require('./scripts/csv.js');
const log = require('./scripts/log.js');

const TIME_WINDOW_MS = 20 * 60 * 1000;
const COOLDOWN_MS = 2000;
const BLOCK_TIME_MS = 5 * 60 * 60 * 1000; // 5h

const getBlockedIP = async () => {
	try {
		const res = await axios.post('https://api.cloudflare.com/client/v4/graphql', PAYLOAD, { headers: headers.CLOUDFLARE });
		if (!res.data?.data) return log('error', `Failed to retrieve data from Cloudflare (status ${res.status}). Missing permissions? Check your token. The required permission is Zone.Analytics.Read.`);

		log('info', `Fetched ${res.data.data.viewer.zones[0].firewallEventsAdaptive.length} events from Cloudflare`);
		return res.data;
	} catch (err) {
		if (err.response) {
			log('error', `${err.response.status} HTTP ERROR (api.cloudflare.com)\n${JSON.stringify(err.response.data, null, 2)}`);
		} else if (err.request) {
			log('error', 'No response received from Cloudflare');
		} else {
			log('error', `Unknown error with api.cloudflare.com. ${err.message}`);
		}

		return null;
	}
};

const reportBadIP = async (it, skippedRayIds, blockedIPs) => {
	const url = `${it.clientRequestHTTPHost}${it.clientRequestPath}`;
	const country = it.clientCountryName;

	if (isImageRequest(it.clientRequestPath)) {
		skippedRayIds.add(it.rayName);
		logToCSV(new Date(), it.rayName, it.clientIP, url, 'Skipped - Image Request', country);
		log('info', `Skipping: ${it.clientIP}; URL: ${url}; (Image request detected)`);
		return false;
	}

	try {
		await axios.post('https://api.abuseipdb.com/api/v2/report', {
			ip: it.clientIP,
			categories: '19',
			comment: generateComment(it)
		}, { headers: headers.ABUSEIPDB });

		logToCSV(new Date(), it.rayName, it.clientIP, url, 'Reported', country);
		log('info', `Reported: ${it.clientIP}; URL: ${url}`);
		return true;
	} catch (err) {
		if (err.response && err.response.status === 429) {
			blockedIPs.set(it.clientIP, Date.now());
			logToCSV(new Date(), it.rayName, it.clientIP, url, 'Blocked - 429 Too Many Requests', country);
			log('warn', `Rate limited (429) while reporting: ${it.clientIP}; URL: ${url}; (Will retry after 5 hours)`);
		} else {
			log('error', `${err.message} - IP: ${it.clientIP}; Domain: ${it.clientRequestHTTPHost}; URL: ${url}`);
		}

		return false;
	}
};

const exceptedRuleId = new Set(['fa01280809254f82978e827892db4e46']);

const shouldReportDomain = (domain, reportedIPs) => {
	const lastReport = reportedIPs.find(entry => entry.domain === domain);
	if (!lastReport) return true;
	const timeSinceLastReport = Date.now() - lastReport.timestamp.getTime();
	return timeSinceLastReport > TIME_WINDOW_MS;
};

const shouldSkipBlockedIP = (ip, blockedIPs) => {
	const lastBlock = blockedIPs.get(ip);
	if (!lastBlock) return false;
	const timeSinceLastBlock = Date.now() - lastBlock;
	return timeSinceLastBlock < BLOCK_TIME_MS;
};

(async () => {
	log('info', 'Starting IP reporting process...');

	const reportedIPs = readReportedIPs();
	const skippedRayIds = new Set(reportedIPs.filter(ip => ip.action.startsWith('Skipped')).map(ip => ip.rayid));
	const blockedIPs = new Map(reportedIPs.filter(ip => ip.action.includes('429')).map(ip => [ip.ip, ip.timestamp.getTime()]));

	while (true) {
		log('info', '===================== New Reporting Cycle =====================');

		const data = await getBlockedIP();

		if (data && data.data) {
			const ipBadList = data.data.viewer.zones[0].firewallEventsAdaptive;

			for (const i of ipBadList) {
				if (skippedRayIds.has(i.rayName) || shouldSkipBlockedIP(i.clientIP, blockedIPs)) continue;

				if (!exceptedRuleId.has(i.ruleId) && shouldReportDomain(i.clientRequestHTTPHost, reportedIPs)) {
					const reported = await reportBadIP(i, skippedRayIds, blockedIPs);
					if (reported) await new Promise(resolve => setTimeout(resolve, COOLDOWN_MS));
				} else if (!skippedRayIds.has(i.rayName)) {
					skippedRayIds.add(i.rayName);

					const url = `${i.clientRequestHTTPHost}${i.clientRequestPath}`;
					logToCSV(new Date(), i.rayName, i.clientIP, url, 'Skipped - Already Reported', i.clientCountryName);
					log('info', `Skipping: ${i.clientIP} (domain ${i.clientRequestHTTPHost}); URL: ${url}; (Already reported recently)`);
				}
			}
		}

		log('info', '==================== End of Reporting Cycle ====================');
		await new Promise(resolve => setTimeout(resolve, process.env.NODE_ENV === 'production' ? 2 * 60 * 60 * 1000 : 10 * 1000));
	}
})();