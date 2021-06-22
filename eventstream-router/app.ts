import { argv, bot, fs, log, path } from "../botbase";
import { RecentChangeStreamEvent } from "./RecentChangeStreamEvent";
import { createLogStream, stringifyObject } from "../utils";
import EventSource = require("./EventSource");

// TODO: improve logging

/**
 * REGISTER ROUTES
 *
 * A route should default export a class extending Route, which defines the
 * filter and worker methods. The worker should be idempotent, that is, it
 * must handle the scenario of the same event being passed to it multiple times,
 * which could occur due to reconnections.
 *
 * NOTE: Route files should NOT contain any process.chdir() statements!
 * Avoid executing code at the top level, put any required initializations
 * in the class init() method, which can be async.
 *
 */
export abstract class Route {
	name: string;
	log: ((msg: any) => void);

	init(): void | Promise<void> {
		this.log = createLogStream('./' + this.name + '.out');
	}

	filter(data: RecentChangeStreamEvent): boolean {
		return true;
	}

	abstract worker(data: RecentChangeStreamEvent);
}

export class RouteValidator {
	name: string;
	worker: ((data: RecentChangeStreamEvent) => any);
	filter: ((data: RecentChangeStreamEvent) => boolean);
	init: (() => any);
	isValid: boolean;
	ready: Promise<void>;

	constructor(name) {
		this.name = name;
	}

	validate(file: string) {
		let route;
		try {
			let routeCls = require(file).default;
			route = new routeCls();
			route.name = this.name;
		} catch (e) {
			log(`[E] Invalid route "${file}": require failed`);
			log(e);
			this.isValid = false;
			return;
		}
		this.worker = route.worker.bind(route);
		this.filter = route.filter.bind(route);
		this.init = route.init.bind(route);

		if (typeof this.filter !== 'function' || typeof this.worker !== 'function') {
			log(`[E] Invalid route ${route.name}: filter or worker is not a function`);
			this.isValid = false;
			return;
		}
		this.ready = new Promise((resolve, reject) => {
			if (typeof this.init !== 'function') {
				resolve();
				debug(`[i] Initialized ${route.name} with no initializer`);
			} else {
				Promise.resolve(this.init()).then(() => {
					resolve();
					debug(`[S] Initialized ${route.name}`);
				}, (err) => {
					reject();
					logError(err, route.name);
				});
			}
		});
		this.isValid = true;
		return this;
	}
}

// XXX: consider using Redis rather than to NFS since this does a write every 1 second
export class LastSeen {

	// Number of milliseconds after which lastSeenTs is to be saved to file
	readonly updateInterval = 1000;
	ts: number;
	file: string;

	constructor(filePath: string) {
		this.file = filePath;
		setInterval(() => this.write(), this.updateInterval);
	}

	read() {
		try {
			return parseInt(fs.readFileSync(this.file).toString());
		} catch (e) {
			return NaN;
		}
	}

	write() {
		fs.writeFile(this.file, String(this.ts), err => err && console.log(err));
	}

	get() {
		return new bot.date(
			((typeof this.ts === 'number') ? this.ts : this.read())
			* 1000
		);
	}
}
export function getRoutes(routesFile: string): RouteValidator[] {
	// For development, specify a file as "-r filename" and only that route will be
	// registered, otherwise all files in routes.json are registered.
	let files: Record<string, string> = argv.r ? {[path.basename(argv.r)]: argv.r} : require(routesFile);
	return Object.entries(files).map(([name, file]) => {
		return new RouteValidator(name).validate(file);
	}).filter(route => {
		return route.isValid;
	});
}

const routerLog = createLogStream('./routerlog.out');

function addToRouterLog(routeName: string, data: RecentChangeStreamEvent) {
	let catNote = '';
	if (data.type === 'categorize') {
		let page = pageFromCategoryEvent(data);
		if (page) {
			catNote = (page.added ? '+' : '–') + page.title + '@';
		}
	}
	routerLog(`Routing to ${routeName}: ${catNote}${data.title}@${data.wiki}`);
}

async function main(routes: RouteValidator[], lastSeen: LastSeen) {
	log('[S] Restarted main');

	const ts = lastSeen.get();
	const tsUsable = ts.isValid() && new bot.date().subtract(7, 'days').isBefore(ts);
	log(`[i] lastSeenTs: ${ts}: ${tsUsable}`);

	let since = !argv.fromNow && tsUsable ? ts : new bot.date();
	let stream = new EventSource(
		`https://stream.wikimedia.org/v2/stream/recentchange?since=${since.toISOString()}`, {
			headers: {
				'User-Agent': bot.options.userAgent
			}
		});

	stream.onopen = function () {
		// EventStreams API drops connection every 15 minutes ([[phab:T242767]])
		// So this will be invoked every time that happens.
		log(`[i] Reconnected`);
	}

	stream.onerror = function (evt) {
		if (evt.type === 'error' && evt.message === undefined) {
			// The every 15 minute connection drop?
			return; // EventSource automatically reconnects. No unnecessary logging.
		}
		log(`[W] Event source encountered error:`);
		logError(evt);

		if (evt.status === 429) { // Too Many Requests, the underlying library doesn't reconnect by itself
			stream.close(); // just to be safe that there aren't two parallel connections
			bot.sleep(5000).then(() => {
				return start(routes, lastSeen); // restart
			});
		}
		// TODO: handle other errors, ensure auto-reconnection
	}

	stream.onmessage = function (event) {
		let data: RecentChangeStreamEvent = JSON.parse(event.data);
		lastSeen.ts = data.timestamp;
		for (let route of routes) {
			// the filter method is only invoked after the init(), so that init()
			// can change the filter function
			route.ready.then(() => {
				try {
					if (route.filter(data)) {
						addToRouterLog(route.name, data);
						route.worker(data);
					}
				} catch (e) {
					logError(e, route.name);
				}
			});
		}
	}
}

export async function start(routes: RouteValidator[], lastSeen: LastSeen) {
	await main(routes, lastSeen).catch(err => {
		logError(err);
		start(routes, lastSeen);
	});
}

export function logError(err, task?) {
	let taskFmt = task ? `[${task}]` : '';
	let stringified;
	if (err.stack) {
		log(`${taskFmt} ${err.stack}`);
	} else if (stringified = stringifyObject(err)) {
		log(`${taskFmt} ${stringified}`);
	} else {
		log(`${taskFmt}`);
		console.log(err);
	}
}

export function pageFromCategoryEvent(data: RecentChangeStreamEvent) {
	let match = /^\[\[:(.*?)\]\] (added|removed)/.exec(data.comment);
	if (!match) {
		return null;
	}
	return {
		title: match[1],
		added: match[2] === 'added',
		removed: match[2] === 'removed'
	};
}

export function debug(msg) {
	if (argv.debug) {
		log(msg);
	}
}
