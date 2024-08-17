require('dotenv').config();
const axios = require('axios');
const PAYLOAD = require('./scripts/payload.js');
const generateComment = require('./scripts/generateComment.js');
const isImageRequest = require('./scripts/isImageRequest.js');
const headers = require('./scripts/headers.js');
const { logToCSV, readReportedIPs } = require('./scripts/csv.js');
const formatDelay = require('./scripts/formatDelay.js');
const log = require('./scripts/log.js');

const TIME_WINDOW_MS = 20 * 60 * 1000;
const COOLDOWN_MS = 2000;
const BLOCK_TIME_MS = 5 * 60 * 60 * 1000; // 5h
const exceptedRuleIds = new Set(['fa01280809254f82978e827892db4e46']);

const fetchBlockedIPs = async () => {
	try {
		const response = await axios.post('https://api.cloudflare.com/client/v4/graphql', PAYLOAD, { headers: headers.CLOUDFLARE });
		if (response.data?.data) {
			const events = response.data.data.viewer.zones[0].firewallEventsAdaptive;
			log('info', `Fetched ${events.length} events from Cloudflare`);
			return events;
		} else {
			throw new Error(`Failed to retrieve data from Cloudflare (status ${response.status}). Missing permissions? Check your token. The required permission is Zone.Analytics.Read.`);
		}
	} catch (err) {
		if (err.response) {
			log('error', `${err.response.status} HTTP ERROR (Cloudflare)\n${JSON.stringify(err.response.data, null, 2)}`);
		} else if (err.request) {
			log('error', 'No response received from Cloudflare');
		} else {
			log('error', `Unknown error with Cloudflare. ${err.message}`);
		}

		return null;
	}
};

const shouldReportDomain = (domain, reportedIPs) => {
	const lastReport = reportedIPs.find(entry => entry.domain === domain);
	return !lastReport || (Date.now() - lastReport.timestamp.getTime()) > TIME_WINDOW_MS;
};

const isIPBlockedRecently = (ip, blockedIPs) => {
	const lastBlockTime = blockedIPs.get(ip);
	return lastBlockTime && (Date.now() - lastBlockTime) < BLOCK_TIME_MS;
};

const reportIP = async (event, url, country, blockedIPs, cycleErrorCounts) => {
	try {
		await axios.post('https://api.abuseipdb.com/api/v2/report', {
			ip: event.clientIP,
			categories: '19',
			comment: generateComment(event)
		}, { headers: headers.ABUSEIPDB });

		logToCSV(new Date(), event.rayName, event.clientIP, url, 'Reported', country);
		log('info', `Reported: ${event.clientIP}; URL: ${url}`);
		return true;
	} catch (err) {
		if (err.response) {
			if (err.response.status === 429) {
				blockedIPs.set(event.clientIP, Date.now());
				logToCSV(new Date(), event.rayName, event.clientIP, url, 'Blocked - 429 Too Many Requests', event.clientCountryName);
				log('warn', `Rate limited (429) while reporting: ${event.clientIP}; URL: ${url}; (Will retry after 5 hours)`);
				cycleErrorCounts.blocked++;
			} else {
				log('error', `Error ${err.response.status} while reporting: ${event.clientIP}; URL: ${url}; Message: ${err.response.data.message}`);
				cycleErrorCounts.otherErrors++;
			}
		} else if (err.request) {
			log('error', `No response from AbuseIPDB while reporting: ${event.clientIP}; URL: ${url}`);
			cycleErrorCounts.noResponse++;
		} else {
			log('error', `Unknown error: ${err.message} while reporting: ${event.clientIP}; URL: ${url}`);
			cycleErrorCounts.otherErrors++;
		}

		return false;
	}
};

(async () => {
	log('info', 'Starting IP reporting process...');

	const reportedIPs = readReportedIPs();
	const skippedRayIds = new Set(reportedIPs.filter(ip => ip.action.startsWith('Skipped')).map(ip => ip.rayid));
	const blockedIPs = new Map(reportedIPs.filter(ip => ip.action.includes('429')).map(ip => [ip.ip, ip.timestamp.getTime()]));

	while (true) {
		log('info', '===================== New Reporting Cycle =====================');

		let cycleImageSkippedCount = 0, cycleProcessedCount = 0, cycleReportedCount = 0, cycleSkippedCount = 0;
		const cycleErrorCounts = { blocked: 0, noResponse: 0, otherErrors: 0 };

		const blockedIPEvents = await fetchBlockedIPs();
		if (blockedIPEvents) {
			for (const event of blockedIPEvents) {
				cycleProcessedCount++;

				if (skippedRayIds.has(event.rayName) || isIPBlockedRecently(event.clientIP, blockedIPs)) {
					cycleSkippedCount++;
					continue;
				}

				const url = `${event.clientRequestHTTPHost}${event.clientRequestPath}`;
				const country = event.clientCountryName;

				if (isImageRequest(event.clientRequestPath)) {
					skippedRayIds.add(event.rayName);
					logToCSV(new Date(), event.rayName, event.clientIP, url, 'Skipped - Image Request', country);
					log('info', `Skipping: ${event.clientIP}; URL: ${url}; (Image request detected)`);
					cycleImageSkippedCount++;
					continue;
				}

				if (!exceptedRuleIds.has(event.ruleId) && shouldReportDomain(event.clientRequestHTTPHost, reportedIPs)) {
					const wasReported = await reportIP(event, url, country, blockedIPs, cycleErrorCounts);
					if (wasReported) {
						cycleReportedCount++;
						await new Promise(resolve => setTimeout(resolve, COOLDOWN_MS));
					}
				} else {
					skippedRayIds.add(event.rayName);
					logToCSV(new Date(), event.rayName, event.clientIP, url, 'Skipped - Already Reported', country);
					log('info', `Skipping: ${event.clientIP} (domain ${event.clientRequestHTTPHost}); URL: ${url}; (Already reported recently)`);
					cycleSkippedCount++;
				}
			}
		}

		log('info', 'Cycle Summary:');
		log('info', `- Total IPs processed: ${cycleProcessedCount}`);
		log('info', `- Reported IPs: ${cycleReportedCount}`);
		log('info', `- Skipped IPs: ${cycleSkippedCount}`);
		log('info', `- Skipped due to Image Requests: ${cycleImageSkippedCount}`);
		log('info', `- 429 Too Many Requests: ${cycleErrorCounts.blocked}`);
		log('info', `- No response errors: ${cycleErrorCounts.noResponse}`);
		log('info', `- Other errors: ${cycleErrorCounts.otherErrors}`);
		log('info', '==================== End of Reporting Cycle ====================');

		const delay = process.env.NODE_ENV === 'production' ? 2 * 60 * 60 * 1000 : 10 * 1000;
		log('info', `Waiting ${formatDelay(delay)}...`);
		await new Promise(resolve => setTimeout(resolve, delay));
	}
})();