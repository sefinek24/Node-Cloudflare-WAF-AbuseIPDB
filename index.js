require('dotenv').config();

const { axios, moduleVersion } = require('./services/axios.js');
const { CYCLE_INTERVAL, REPORTED_IP_COOLDOWN_MS, MAX_URL_LENGTH, SUCCESS_COOLDOWN_MS, SEFINEK_API_INTERVAL, REPORT_TO_SEFINEK_API } = require('./config.js');
const PAYLOAD = require('./scripts/payload.js');
const generateComment = require('./scripts/generateComment.js');
const SefinekAPI = require('./scripts/sefinekAPI.js');
const isImageRequest = require('./scripts/isImageRequest.js');
const headers = require('./scripts/headers.js');
const { logToCSV, readReportedIPs, wasImageRequestLogged } = require('./scripts/csv.js');
const formatDelay = require('./scripts/formatDelay.js');
const clientIp = require('./scripts/clientIp.js');
const log = require('./scripts/log.js');

const fetchBlockedIPs = async () => {
	try {
		const { data, status } = await axios.post('https://api.cloudflare.com/client/v4/graphql', PAYLOAD(), { headers: headers.CLOUDFLARE });
		const events = data?.data?.viewer?.zones[0]?.firewallEventsAdaptive;
		if (events) {
			log('log', `Fetched ${events.length} events from Cloudflare`);
			return events;
		} else {
			log('error', `Failed to retrieve data from Cloudflare. Status: ${status}`, data?.errors);
			return null;
		}
	} catch (err) {
		log('error', err.response?.data ? `${err.response.status} HTTP ERROR (Cloudflare API)\n${JSON.stringify(err.response.data, null, 2)}` : `Unknown error with Cloudflare API: ${err.message}`);
		return null;
	}
};

const isIPReportedRecently = (rayId, ip, reportedIPs) => {
	const lastReport = reportedIPs.find(entry =>
		(entry.rayId === rayId || entry.ip === ip) &&
		(entry.action === 'REPORTED' || entry.action === 'TOO_MANY_REQUESTS')
	);

	if (lastReport) {
		const lastTimestamp = new Date(lastReport.timestamp).getTime();
		const currentTime = Date.now();
		const timeDifference = currentTime - lastTimestamp;
		if (timeDifference < REPORTED_IP_COOLDOWN_MS) return { recentlyReported: true, timeDifference };
	}

	return { recentlyReported: false };
};

const reportIP = async (event, country, hostname, endpoint, userAgent, cycleErrorCounts) => {
	const uri = `${hostname}${endpoint}`;
	if (!uri) {
		logToCSV(event.rayName, event.clientIP, country, hostname, endpoint, event.userAgent, event.action, 'MISSING_URI');
		log('warn', `Missing URL ${event.clientIP}; URI: ${uri}`);
		return false;
	}

	if (event.clientIP === clientIp.address) {
		logToCSV(event.rayName, event.clientIP, country, hostname, endpoint, event.userAgent, event.action, 'YOUR_IP_ADDRESS');
		log('log', `Your IP address (${event.clientIP}) was unexpectedly received from Cloudflare. URI: ${uri}; Ignoring...`);
		return false;
	}

	if (uri.length > MAX_URL_LENGTH) {
		logToCSV(event.rayName, event.clientIP, country, hostname, endpoint, event.userAgent, event.action, 'URI_TOO_LONG');
		log('log', `URL too long ${event.clientIP}; URI: ${uri}`);
		return false;
	}

	try {
		await axios.post('https://api.abuseipdb.com/api/v2/report', {
			ip: event.clientIP,
			categories: '19',
			comment: generateComment(event)
		}, { headers: headers.ABUSEIPDB });

		logToCSV(event.rayName, event.clientIP, country, hostname, endpoint, event.userAgent, event.action, 'REPORTED');
		log('log', `Reported ${event.clientIP}; URI: ${uri}`);

		return true;
	} catch (err) {
		if (err.response?.status === 429) {
			logToCSV(event.rayName, event.clientIP, country, hostname, endpoint, event.userAgent, event.action, 'TOO_MANY_REQUESTS');
			log('log', `429 for ${event.clientIP} (${event.rayName}); Endpoint: ${endpoint}`);
			cycleErrorCounts.blocked++;
		} else {
			log('error', `Error ${err.response?.status} while reporting ${event.clientIP}; URI: ${uri}; (${err.response?.data})`);
			cycleErrorCounts.otherErrors++;
		}

		return false;
	}
};

(async () => {
	log('log', 'Loading data, please wait...');
	await clientIp.fetchIPAddress();

	// Sefinek API
	if (REPORT_TO_SEFINEK_API && SEFINEK_API_INTERVAL && process.env.SEFINEK_API_SECRET) {
		setInterval(async () => await SefinekAPI(), SEFINEK_API_INTERVAL);
	}

	// Ready
	if (process.env.NODE_ENV === 'production') {
		try {
			process.send('ready');
		} catch (err) {
			log('log', `Failed to send ready signal to parent process. ${err.message}`);
		}
	}

	// AbuseIPDB
	let cycleId = 1;
	while (true) {
		log('log', `===================== New Reporting Cycle (v${moduleVersion}) =====================`);

		const blockedIPEvents = await fetchBlockedIPs();
		if (!blockedIPEvents) {
			log('warn', 'No events fetched, skipping cycle...');
			continue;
		}

		const userIp = clientIp.getAddress();
		if (!userIp) log('warn', `Your IP address is missing! Received: ${userIp}`);

		let cycleImageSkippedCount = 0, cycleProcessedCount = 0, cycleReportedCount = 0, cycleSkippedCount = 0;
		const cycleErrorCounts = { blocked: 0, noResponse: 0, otherErrors: 0 };
		let imageRequestLogged = false;

		for (const event of blockedIPEvents) {
			cycleProcessedCount++;
			const ip = event.clientIP;
			if (ip === userIp) {
				log('log', `The IP address ${ip} belongs to this machine. Ignoring...`);
				cycleSkippedCount++;
				continue;
			}

			const reportedIPs = readReportedIPs();
			const { recentlyReported, timeDifference } = isIPReportedRecently(event.rayName, ip, reportedIPs);
			if (recentlyReported) {
				const hoursAgo = Math.floor(timeDifference / (1000 * 60 * 60));
				const minutesAgo = Math.floor((timeDifference % (1000 * 60 * 60)) / (1000 * 60));
				const secondsAgo = Math.floor((timeDifference % (1000 * 60)) / 1000);
				log('log', `${ip} was reported or rate-limited ${hoursAgo}h ${minutesAgo}m ${secondsAgo}s ago. Skipping...`);
				cycleSkippedCount++;
				continue;
			}

			if (isImageRequest(event.clientRequestPath)) {
				cycleImageSkippedCount++;
				if (!wasImageRequestLogged(ip, reportedIPs)) {
					if (imageRequestLogged) continue;
					log('log', 'Skipping image requests in this cycle...');
					imageRequestLogged = true;
				}

				continue;
			}

			const wasReported = await reportIP(event, event.clientCountryName, event.clientRequestHTTPHost, event.clientRequestPath, event.userAgent, cycleErrorCounts);
			if (wasReported) {
				cycleReportedCount++;
				await new Promise(resolve => setTimeout(resolve, SUCCESS_COOLDOWN_MS));
			}
		}

		log('log', `Cycle Summary [${cycleId}]:`);
		log('log', `- Reported IPs: ${cycleReportedCount}`);
		log('log', `- Total IPs processed: ${cycleProcessedCount}`);
		log('log', `- Skipped IPs: ${cycleSkippedCount}`);
		log('log', `- Skipped due to Image Requests: ${cycleImageSkippedCount}`);
		log('log', `- 429 Too Many Requests: ${cycleErrorCounts.blocked}`);
		log('log', `- No response errors: ${cycleErrorCounts.noResponse}`);
		log('log', `- Other errors: ${cycleErrorCounts.otherErrors}`);
		log('log', '==================== End of Reporting Cycle ====================');

		log('log', `Waiting ${formatDelay(CYCLE_INTERVAL)}...`);
		cycleId++;
		await new Promise(resolve => setTimeout(resolve, CYCLE_INTERVAL));
	}
})();