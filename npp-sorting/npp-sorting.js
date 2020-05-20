process.chdir('./SDZeroBot/npp-sorting');

const {log, argv, bot, sql, utils} = require('../botbase');

(async function() {

	/* GET DATA FROM DATABASE */

	log('[i] Started');

	await bot.loginGetToken();

	var revidsTitles, tableInfo;
	if (argv.nodb) {
		revidsTitles = require('./revidsTitles');
		tableInfo = require('./tableInfo');
	} else {
		const result = await sql.queryBot(`
			SELECT page_title, rev_timestamp, page_latest, page_len, actor_name, user_editcount
			FROM pagetriage_page
			JOIN page on page_id = ptrp_page_id
			JOIN revision ON page_id = rev_page AND rev_parent_id = 0
			JOIN actor ON rev_actor = actor_id
			LEFT JOIN user ON user_id = actor_user
			WHERE page_namespace = 0
			AND page_is_redirect = 0
			AND ptrp_reviewed = 0
		`);
		sql.end();
		log('[S] Got DB query result');

		var formatDateString = function(str) {
			return str.slice(0, 4) + '-' + str.slice(4, 6) + '-' + str.slice(6, 8);
		};

		var rfdRedirects = new Set(await new bot.category('All redirects for discussion').pages()
			.then(pages => pages.map(pg => pg.title)));

		revidsTitles = {};
		tableInfo = {};
		result.forEach(row => {
			var pagename = row.page_title.replace(/_/g, ' ');
			if (rfdRedirects.has(pagename)) { // exclude RfD'd redirects 
				return;
			}
			revidsTitles[row.page_latest] = pagename
			tableInfo[pagename] = {
				creation_date: formatDateString(row.rev_timestamp),
				bytecount: row.page_len,
				creator: row.actor_name,
				creatorEdits: row.user_editcount || '',
			};
		});
		utils.saveObject('revidsTitles', revidsTitles);
		utils.saveObject('tableInfo', tableInfo);
	}

	var accessdate = new Date().toLocaleString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

	/* GET DATA FROM ORES */

	var pagelist = Object.keys(revidsTitles);
	if (argv.size) {
		pagelist = pagelist.slice(0, argv.size);
	}
	var chunks = utils.arrayChunk(pagelist, 50);
	var oresdata = {};

	if (argv.noores) {
		oresdata = require('./oresdata');
	} else {
		var errors = [];
		var queryOres = function(revids, i) {

			return bot.rawRequest({
				method: 'get',
				url: 'https://ores.wikimedia.org/v3/scores/enwiki/',
				params: {
					models: 'articlequality|draftquality|drafttopic',
					revids: revids.join('|')
				},
				responseType: 'json'
			}).then(function(json) {
				log(`[+][${i}/${chunks.length}] Ores API call ${i} succeeded.`);
				Object.entries(json.enwiki.scores).forEach(([revid, data]) => {
					if (data.articlequality.error) {
						errors.push(revid);
						return;
					}
					oresdata[revid] = {
						articlequality: data.articlequality.score.prediction,
						draftquality: data.draftquality.score.prediction,
						drafttopic: data.drafttopic.score.prediction,
					}
				});
			});

		};

		for (var i = 0; i < chunks.length; i++) {
			await queryOres(chunks[i], i+1); // sequential calls
		}

		utils.saveObject('oresdata', oresdata);
		utils.saveObject('errors', errors);
	}

	/* GET SHORT DESCRIPTIONS AND PAGE CONTENT */
	await bot.massQuery({
		action: 'query',
		titles: Object.values(revidsTitles),
		prop: 'revisions|description',
		rvprop: 'content'
	}).then(jsons => {
		var pages = jsons.reduce((pages, json) => pages.concat(json.query.pages), []);
		pages.forEach(page => {
			if (page.missing) {
				return;
			}
			var text = page.revisions[0].content;
			tableInfo[page.title].extract = TextExtractor.getExtract(text, 250, 500);
			// NOTE: additional processing of extracts at the end of createSubpage() function

			if (page.description) {
				tableInfo[page.title].shortdesc = page.description;
				// cut out noise
				if (page.description === 'Wikimedia list article') {
					tableInfo[page.title].shortdesc = '';
				} else if (page.description === 'Disambiguation page providing links to topics that could be referred to by the same search term') {
					tableInfo[page.title].shortdesc = 'Disambiguation page';
				}
			}
		});
		log(`[S] Found ${pages.filter(page => page.description).length} pages with short descriptions`);
	});
	


	/* GET DATA ABOUT PRIOR AFD */
	var afds = {};

	// Get existing AfDs to filter them out
	var currentAfds = new Set(await new bot.category('AfD debates').pages().then(pages => {
		return pages.map(pg => pg.title); 
	}));

	await bot.massQuery({
		action: 'query',
		titles: Object.values(revidsTitles).map(e => 'Wikipedia:Articles for deletion/' + e)
	}).then(jsons => {
		var pages = jsons.reduce((pages, json) => pages.concat(json.query.pages), []);
		pages.forEach(page => {
			if (!page.missing && !currentAfds.has(page)) {
				afds[page.title.slice('Wikipedia:Articles for deletion/'.length)] = 1;
			}
		});
		log(`[S] Fetched list of prior AfDs. Found ${Object.keys(afds).length} articles with AfDs`);
	});	



	/* PROCESS ORES DATA, SORT PAGES INTO TOPICS */

	var sorter = {
		"Unsorted/Unsorted*": []
	};

	Object.entries(oresdata).forEach(function([revid, ores]) {

		var title = revidsTitles[revid];
		if (!title) {
			log(`[E] revid ${revid} couldn't be matched to title`);
		}

		var topics = ores.drafttopic; // Array of topics
		var quality = ores.articlequality; // FA / GA / B / C / Start / Stub
		var issues = [];
		if (ores.draftquality !== 'OK') { // OK / vandalism / spam / attack
			issues.push('Possible ' + ores.draftquality);
		}
		if (afds[title]) {
			issues.push(`[[Wikipedia:Articles for deletion/${title}|Past AfD]]`);
		}
		issues = issues.join('<br>');

		var toInsert = { title, revid, quality, issues };

		if (topics.length) {

			topics = topics.map(t => t.replace(/\./g, '/'));

			topics.forEach(function(topic) {

				// Remove Asia.Asia* if Asia.South-Asia is present (example)
				if (topic.endsWith('*')) {
					var metatopic = topic.split('/').slice(0, -1).join('/');
					for (var i = 0; i < topics.length; i++) {
						if (topics[i] !== topic && topics[i].startsWith(metatopic)) {
							return;
						}
					}
				}

				if (sorter[topic]) {
					sorter[topic].push(toInsert);
				} else {
					sorter[topic] = [ toInsert ];
				}

			});
		} else {
			sorter["Unsorted/Unsorted*"].push(toInsert);
		}
	});

	// sorter: object mapping topic names to array of objects with page name and other ORES data
	utils.saveObject('sorter', sorter);



	/* FORMAT DATA TO BE SAVED ON THE WIKI */

	var isStarred = x => x.endsWith('*');
	var meta = x => x.split('/').slice(0, -1).join('/');

	var makeMainPage = function() {
		var count = Object.keys(revidsTitles).length;
		return bot.edit('User:SDZeroBot/NPP sorting', function(rev) {
			var text = rev.content;
			text = text.replace(/\{\{\/header.*\}\}/, 
				`{{/header|count=${count}|date=${accessdate}|ts=~~~~~}}`);

			var sorterKeys = Object.keys(sorter);

			// update category counts
			text.split('\n').forEach(line => {
				var match = line.match(/\[\[\/(.*?)\|.*?\]\]/);
				if (!match || !match[1]) {
					return;
				}
				var topic = match[1];
				var sorterKey = sorterKeys.find(e => e === topic || (isStarred(e) && meta(e) === topic));
				var count = sorter[sorterKey].length;
				text = text.replace(line, line.replace(/\(\d+\)/, `(${count})`));
			});

			return {
				text: text, 
				summary: 'Updating report'
			};
		});
	};
	await makeMainPage();


	/* TOPICAL SUBPAGES */

	var createSubpage = function(topic) {
		var pagetitle = topic;
		var content = '';
		if (isStarred(topic)) {
			pagetitle = meta(topic);
			if (pagetitle !== 'Unsorted') {
				content += `<div style="font-size:18px">See also the subpages:</div>\n` +
				`{{Special:PrefixIndex/User:SDZeroBot/NPP sorting/${pagetitle}/|stripprefix=1}}\n\n`;
			}
		}
		content += `{{User:SDZeroBot/NPP sorting/header|count=${sorter[topic].length}|date=${accessdate}|ts=~~~~~}}\n`;
		content += `
{| class="wikitable sortable"
|-
! scope="col" style="width: 5em;" | Created
! scope="col" style="width: 18em;" | Article
! scope="col" style="max-width: 28em;" | Extract 
! scope="col" style="width: 3em;" | Class
! scope="col" style="max-width: 14em;" | Creator (# edits)
! Notes
`;

		sorter[topic].forEach(function(page) {
			var tabledata = tableInfo[page.title];

			var editorString;
			if (tabledata.creatorEdits) {
				editorString = `[[Special:Contribs/${tabledata.creator}|${tabledata.creator}]] (${tabledata.creatorEdits})`;
			} else {
				// lowercase IPv6 address and split to 2 lines to reduce column width
				if (bot.util.isIPv6Address(tabledata.creator)) {
					var ip = tabledata.creator.toLowerCase();
					var idx = Math.round(ip.length / 2);
					ip = ip.slice(0, idx) + '<br>' + ip.slice(idx);
					editorString = `[[Special:Contribs/${tabledata.creator}|${ip}]]`;
				} else {
					editorString = `[[Special:Contribs/${tabledata.creator}|${tabledata.creator}]]`;
				}
			}

			var classString = page.quality;
			// fix sort values: put FA, GA at the top in sorted order
			if (classString === 'FA') {
				classString = `data-sort-value="A0"|FA`;
			} else if (classString === 'GA') {
				classString = `data-sort-value="A1"|GA`;
			}

			var articleString = `[[${page.title}]]`;
			if (tabledata.shortdesc) {
				articleString += ` <small>(${tabledata.shortdesc})</small>`;
			}

			content += `|-
| ${tabledata.creation_date}
| ${articleString}
| <small>${tabledata.extract || ''}</small>
| ${classString}
| ${editorString}
| ${page.issues}
`;
		});

		content += `|}\n<span style="font-style: italic; font-size: 85%;">Last updated by [[User:SDZeroBot|SDZeroBot]] <sup>''[[User:SD0001|operator]] / [[User talk:SD0001|talk]]''</sup> at ~~~~~</span>`;

		content = TextExtractor.sanitise(content);

		return bot.save('User:SDZeroBot/NPP sorting/' + pagetitle, content, 'Updating report');
	};

	bot.batchOperation(Object.keys(sorter), createSubpage, 1).then(() => {
		log('[i] Finished');
	});

})();

class TextExtractor {

	/** 
	 * Get extract 
	 * @param {string} pagetext - full page text 
	 * @param {number} charLimit - cut off the extract at this many readable characters, or wherever 
	 * the sentence ends after this limit
	 * @param {number} hardUpperLimit - cut off the extract at this many readable characters even if 
	 * the sentence hasn't ended
	 */
	static getExtract(pagetext, charLimit, hardUpperLimit) {

		// remove any infoboxes - they occasionally contain text on a line not beginning with a | or *
		// thus not being adequately handled by the magic down below
		var wkt = new bot.wikitext(pagetext);
		wkt.parseTemplates();
		var infoboxes = wkt.templates.filter(t => /^[Ii]nfobox /.test(t.name));
		infoboxes.forEach(infobox => {
			pagetext = pagetext.replace(infobox.wikitext, '');
		});

		var extract = pagetext
			.replace(/<!--.*?-->/sg, '')
			// remove refs, including named ref definitions and named ref invocations
			.replace(/<ref.*?(?:\/>|<\/ref>)/sgi, '')
			// remove files: no ? to handle wikilinks in captions. No s flag to go along with that.
			.replace(/\[\[File:.*\]\]/gi, '') 
			// the magic
			.replace(/^\s*[{|}=*#:<!].*$/mg, '')
			// trim left to prepare for next step
			.trimLeft()
			// keep only the first paragraph
			.replace(/\n\n.*/s, '')
			.replace(/'''(.*?)'''/g, '$1')
			.replace(/\(\{\{[Ll]ang-.*?\}\}\)/, '')
			.trim();

		// We consider a period followed by a space or newline NOT followed by a lowercase char
		// as a sentence ending. Lowercase chars after period+space is generally use of an abbreviation
		var sentenceEnd = /\.\s(?![a-z])/g;

		if (extract.length > charLimit) {
			var match = sentenceEnd.exec(extract);
			while (match) {
				if (TextExtractor.effCharCount(extract.slice(0, match.index)) > charLimit) {
					extract = extract.slice(0, match.index + 1);
					break;
				} else {
					match = sentenceEnd.exec(extract);
				}
			}
		}

		if (TextExtractor.effCharCount(extract) > hardUpperLimit) {
			extract = extract.slice(0, hardUpperLimit) + ' ...';
		}

		return extract;
	}

	static effCharCount(text) {
		return text
			.replace(/\[\[:?(?:[^|\]]+?\|)?([^\]|]+?)\]\]/g, '$1')
			.replace(/''/g, '')
			.length;
	}

	/**
	 * Do away with some of the more bizarre stuff from page extracts that aren't worth 
	 * checking for on a per-page basis @param {string} content
	 */
	static sanitise(content) {
		return content.replace(/\[\[Category:.*?\]\]/gi, '')
			.replace(/\[\[Image:.*?\]\]/gi, '')
			.replace(/\{\{[sS]fn\|.*?\}\}/g, '')
			.replace(/\{\{r\|.*?\}\}/gi, '');
	}
}