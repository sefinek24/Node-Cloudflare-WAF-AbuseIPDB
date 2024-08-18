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
const REPORTED_IP_COOLDOWN_MS = 7 * 60 * 60 * 1000;
const MAX_URL_LENGTH = 2000;
const MAIN_DELAY = process.env.NODE_ENV === 'production' ? 4 * 60 * 60 * 1000 : 8 * 1000;

const fetchBlockedIPs = async () => {
	try {
		const res = await axios.post('https://api.cloudflare.com/client/v4/graphql', PAYLOAD(), { headers: headers.CLOUDFLARE });
		if (res.data?.data) {
			const events = res.data.data.viewer.zones[0].firewallEventsAdaptive;
			log('info', `Fetched ${events.length} events from Cloudflare`);
			return events;
		} else {
			console.log(res.data?.errors);
			throw new Error(`Failed to retrieve data from Cloudflare. Status: ${res.status}`);
		}
	} catch (err) {
		log('error', err.response?.data ? `${err.response.status} HTTP ERROR (Cloudflare API)\n${JSON.stringify(err.response.data, null, 2)}` : `Unknown error with Cloudflare API: ${err.message}`);
		return null;
	}
};

const isIPReportedRecently = (ip, reportedIPs) => {
	const lastReport = reportedIPs.find(entry => entry.ip === ip && (entry.action === 'Reported' || entry.action.startsWith('Failed')));
	if (!lastReport) return false;

	const lastTimestamp = new Date(lastReport.timestamp).getTime();
	const currentTime = Date.now();

	return (currentTime - lastTimestamp) < REPORTED_IP_COOLDOWN_MS;
};

const reportIP = async (event, url, country, cycleErrorCounts) => {
	if (!url) {
		logToCSV(event.rayName, event.clientIP, url, 'Failed - Missing URL', country);
		log('warn', `Error while reporting: ${event.clientIP}; URI: ${url}; (Missing URL)`);
		return false;
	}

	if (url.length > MAX_URL_LENGTH) {
		logToCSV(event.rayName, event.clientIP, url, 'Failed - URL too long', country);
		log('warn', `Error 422 while reporting: ${event.clientIP}; URI: ${url}; (URL too long)`);
		return false;
	}

	try {
		await axios.post('https://api.abuseipdb.com/api/v2/report', {
			ip: event.clientIP,
			categories: '19',
			comment: generateComment(event)
		}, { headers: headers.ABUSEIPDB });

		logToCSV(event.rayName, event.clientIP, url, 'Reported', country);
		log('info', `Reported: ${event.clientIP}; URI: ${url}`);

		return true;
	} catch (err) {
		if (err.response) {
			if (err.response.status === 429) {
				logToCSV(event.rayName, event.clientIP, url, 'Failed - 429 Too Many Requests', country);
				log('info', `Rate limited (429) while reporting: ${event.clientIP}; URI: ${url};`);
				cycleErrorCounts.blocked++;
			} else {
				log('error', `Error ${err.response.status} while reporting: ${event.clientIP}; URI: ${url}; (${err.response.data})`);
				cycleErrorCounts.otherErrors++;
			}
		} else {
			log('error', `No response from AbuseIPDB while reporting: ${event.clientIP}; URI: ${url}`);
			cycleErrorCounts.noResponse++;
		}
		return false;
	}
};

(async () => {
	try {
		process.send('ready');
	} catch (err) {
		log('info', `Failed to send ready signal to parent process. ${err.message}`);
	}

	log('info', 'Starting IP reporting process...');
	let cycleId = 1;

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

			if (isIPReportedRecently(ip, reportedIPs)) {
				log('info', `IP ${ip} was reported or rate-limited recently. Skipping...`);
				cycleSkippedCount++;
				continue;
			}

			if (isImageRequest(event.clientRequestPath)) {
				cycleImageSkippedCount++;
				if (!wasImageRequestLogged(ip, reportedIPs)) {
					logToCSV(event.rayName, ip, url, 'Skipped - Image Request', country);

					if (imageRequestLogged) break;
					log('info', 'Skipping image requests in this cycle...');
					imageRequestLogged = true;
				}

				continue;
			}

			const wasReported = await reportIP(event, url, country, cycleErrorCounts);
			if (wasReported) {
				cycleReportedCount++;
				await new Promise(resolve => setTimeout(resolve, COOLDOWN_MS));
			}
		}

		log('info', `Cycle Summary [${cycleId}]:`);
		log('info', `- Total IPs processed: ${cycleProcessedCount}`);
		log('info', `- Reported IPs: ${cycleReportedCount}`);
		log('info', `- Skipped IPs: ${cycleSkippedCount}`);
		log('info', `- Skipped due to Image Requests: ${cycleImageSkippedCount}`);
		log('info', `- 429 Too Many Requests: ${cycleErrorCounts.blocked}`);
		log('info', `- No response errors: ${cycleErrorCounts.noResponse}`);
		log('info', `- Other errors: ${cycleErrorCounts.otherErrors}`);
		log('info', '==================== End of Reporting Cycle ====================');

		log('info', `Waiting ${formatDelay(MAIN_DELAY)}...`);
		cycleId++;
		await new Promise(resolve => setTimeout(resolve, MAIN_DELAY));
	}
})();