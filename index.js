require('dotenv').config();

const axios = require('axios');
const PAYLOAD = require('./scripts/payload.js');
const generateComment = require('./scripts/generateComment.js');
const isImageRequest = require('./scripts/isImageRequest.js');
const headers = require('./scripts/headers.js');
const { logToCSV, readReportedIPs, wasImageRequestLogged } = require('./scripts/csv.js');
const formatDelay = require('./scripts/formatDelay.js');
const log = require('./scripts/log.js');

const COOLDOWN_MS = 2000;
const BLOCK_TIME_MS = 5 * 60 * 60 * 1000;
const REPORTED_IP_COOLDOWN_MS = 7 * 60 * 60 * 1000;

const fetchBlockedIPs = async () => {
	try {
		const res = await axios.post('https://api.cloudflare.com/client/v4/graphql', PAYLOAD(), { headers: headers.CLOUDFLARE });
		if (res.data?.data) {
			const events = res.data.data.viewer.zones[0].firewallEventsAdaptive;
			log('info', `Fetched ${events.length} events from Cloudflare`);
			return events;
		} else {
			throw new Error(`Failed to retrieve data from Cloudflare. Status: ${res.status}`);
		}
	} catch (err) {
		log('error', err.response ? `${err.response.status} HTTP ERROR (Cloudflare API)\n${JSON.stringify(err.response.data, null, 2)}` : `Unknown error with Cloudflare API: ${err.message}`);
		return null;
	}
};

const isIPBlockedOrReportedRecently = (ip, reportedIPs) => {
	const lastReportOrBlock = reportedIPs.find(entry => entry.ip === ip);
	if (!lastReportOrBlock) return false;

	const lastTimestamp = new Date(lastReportOrBlock.timestamp).getTime();
	const currentTime = Date.now();

	return (currentTime - lastTimestamp) < REPORTED_IP_COOLDOWN_MS;
};

const reportIP = async (event, url, country, cycleErrorCounts) => {
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
				logToCSV(new Date(), event.rayName, event.clientIP, url, 'Blocked - 429 Too Many Requests', country);
				log('warn', `Rate limited (429) while reporting: ${event.clientIP}; URL: ${url}; (Will retry after 5 hours)`);
				cycleErrorCounts.blocked++;
			} else {
				log('error', `Error ${err.response.status} while reporting: ${event.clientIP}; URL: ${url}; Message: ${err.response.data.message}`);
				cycleErrorCounts.otherErrors++;
			}
		} else {
			log('error', `No response from AbuseIPDB while reporting: ${event.clientIP}; URL: ${url}`);
			cycleErrorCounts.noResponse++;
		}
		return false;
	}
};

(async () => {
	log('info', 'Starting IP reporting process...');

	while (true) {
		log('info', '===================== New Reporting Cycle =====================');

		const blockedIPEvents = await fetchBlockedIPs();
		if (!blockedIPEvents) {
			log('warn', 'No events fetched, skipping cycle...');
			continue;
		}

		const reportedIPs = readReportedIPs();
		let cycleImageSkippedCount = 0, cycleProcessedCount = 0, cycleReportedCount = 0, cycleSkippedCount = 0;
		const cycleErrorCounts = { blocked: 0, noResponse: 0, otherErrors: 0 };
		let imageRequestLogged = false;

		for (const event of blockedIPEvents) {
			cycleProcessedCount++;
			const ip = event.clientIP;
			const url = `${event.clientRequestHTTPHost}${event.clientRequestPath}`;
			const country = event.clientCountryName;

			if (isIPBlockedOrReportedRecently(ip, reportedIPs)) {
				cycleSkippedCount++;
				continue;
			}

			if (isImageRequest(event.clientRequestPath)) {
				cycleImageSkippedCount++;
				if (!wasImageRequestLogged(ip, reportedIPs)) {
					logToCSV(new Date(), event.rayName, ip, url, 'Skipped - Image Request', country);
					if (!imageRequestLogged) {
						log('info', 'Skipping image requests in this cycle.');
						imageRequestLogged = true;
					}
				}

				continue;
			}

			const wasReported = await reportIP(event, url, country, cycleErrorCounts);
			if (wasReported) {
				cycleReportedCount++;
				await new Promise(resolve => setTimeout(resolve, COOLDOWN_MS));
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