const {fs, bot, log, enwikidb, emailOnError, mwn, utils, argv} = require('../botbase');
const TextExtractor = require('../TextExtractor')(bot);

(async function() {

log(`[i] Started`);

let tableInfo = {};

const startTs = new bot.date().subtract(6, 'months').add(7, 'days').format('YYYYMMDDHHmmss');	
const endTs = new bot.date().subtract(6, 'months').add(6, 'days').format('YYYYMMDDHHmmss');

const db = await new enwikidb().connect();
const result = argv.nodb ? JSON.parse(fs.readFileSync(__dirname + '/g13-1week-db.json').toString()) : 
await db.query(`
	SELECT DISTINCT page_namespace, page_title, rev_timestamp
	FROM page
	JOIN revision ON rev_id = page_latest
	WHERE page_namespace = 118
	AND page_is_redirect = 0
	AND rev_timestamp < "${startTs}"
	AND rev_timestamp > "${endTs}"

	UNION
	
	SELECT DISTINCT page_namespace, page_title, rev_timestamp
	FROM page
	JOIN revision ON rev_id = page_latest
	JOIN templatelinks ON tl_from = page_id 
	WHERE page_namespace = 2
	AND tl_title = "AFC_submission" 
	AND tl_namespace = 10
	AND page_is_redirect = 0
	AND rev_timestamp < "${startTs}"
	AND rev_timestamp > "${endTs}"
`);
db.end();
process.chdir(__dirname);
utils.saveObject('g13-1week-db', result);
log('[S] Got DB query result');

await bot.getTokensAndSiteInfo();

result.forEach(row => {
	let pagename = new bot.title(row.page_title, row.page_namespace).toText();
	tableInfo[pagename] = {
		ts: row.rev_timestamp
	};
});

log(`[i] Found ${Object.keys(tableInfo).length} pages`); 

// In theory, we can do request all the details of upto 500 pages in 1 API call, but 
// send in batches of 100 to avoid the slim possibility of hitting the max API response size limit
await bot.seriesBatchOperation(utils.arrayChunk(Object.keys(tableInfo), 100), async (pageSet) => {

	for await (let pg of bot.readGen(pageSet, {
		"prop": "revisions|description|templates|categories",
		"tltemplates": ["Template:COI", "Template:Undisclosed paid", "Template:Connected contributor"],
		"clcategories": ["Category:Rejected AfC submissions", "Category:Promising draft articles"],
		"tllimit": "max",
		"cllimt": "max"
	})) {
		if (pg.missing) {
			continue;
		}
		let text = pg.revisions[0].content;
		Object.assign(tableInfo[pg.title], {
			extract: TextExtractor.getExtract(text, 250, 500),
			desc: pg.description,
			coi: pg.templates && pg.templates.find(e => e.title === 'Template:COI' || e.title === 'Template:Connected contributor'),
			upe: pg.templates && pg.templates.find(e => e.title === 'Template:Undisclosed paid'),
			declines: text.match(/\{\{AFC submission\|d/g)?.length || 0,
			rejected: pg.categories && pg.categories.find(e => e.title === 'Category:Rejected AfC submissions'),
			promising: pg.categories && pg.categories.find(e => e.title === 'Category:Promising draft articles'),
			unsourced: /<ref>/.test(text) || /\{\{([Ss]fn|[Hh]arv)/.test(text)
		});
	}

}, 0, 1);

let table = new mwn.table();
table.addHeaders([
	{label: 'Last edit', style: 'width: 5em'},
	{label: 'Draft', style: 'width: 15em'},
	{label: 'Excerpt' },
	{label: '# declines', style: 'width: 4em'},
	{label: 'Notes', style: 'width: 5em'}
]);

Object.entries(tableInfo).sort(([_title1, data1], [_title2, data2]) => { // eslint-disable-line no-unused-vars
	// Sorting: put promising drafts at the top, rejected ones at the bottom
	// Sort the rest by time
	if (data1.promising) return -1;
	if (data2.promising) return 1;
	if (data1.rejected) return 1;
	if (data2.rejected) return -1;
	return data1.ts < data2.ts ? -1 : 1;
}) 
.forEach(([title, data]) => {
	let notes = [];
	if (data.promising) {
		notes.push('promising');
	}
	if (data.coi) {
		notes.push('COI');
	}
	if (data.upe) {
		notes.push('Undisclosed-paid');
	}
	if (data.unsourced) {
		notes.push('unsourced');
	}
	if (data.rejected) {
		notes.push('rejected');
	}

	table.addRow([
		new bot.date(data.ts).format('YYYY-MM-DD HH:mm'),
		`[[${title}]] ${data.desc ? `(<small>${data.desc}</small>)` : ''}`,
		data.extract || '',
		data.declines || '',
		notes.join('<br>')
	]);
});


let page = new bot.page('User:SDZeroBot/G13 soon'),
	oldlinks = '';

try {
	oldlinks = (await page.history('timestamp|ids', 3)).map(rev => {
		let date = new bot.date(rev.timestamp).subtract(24, 'hours');
		return `[[Special:Permalink/${rev.revid}|${date.format('D MMMM')}]]`;
	}).join(' - ') + ' - {{history|2=older}}';	
} catch (e) {} // eslint-disable-line no-empty

let wikitext =
`{{/header|count=${Object.keys(tableInfo).length}|oldlinks=${oldlinks}|ts=~~~~~}}
${TextExtractor.finalSanitise(table.getText())}
`;

await page.save(wikitext, 'Updating').catch(async err => {
	if (err.code === 'spamblacklist') {
		for (let site of err.response.error.spamblacklist.matches) {
			wikitext = wikitext.replace(
				new RegExp('https?:\\/\\/' + site, 'g'),
				site
			);
		}
		await page.save(wikitext, 'Updating');
	} else {
		return Promise.reject(err);
	} 
});

log(`[i] Finished`);


})().catch(err => emailOnError(err, 'g13-1week'));