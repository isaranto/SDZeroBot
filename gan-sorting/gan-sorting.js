const {mwn, bot, log, argv, xdate, emailOnError} = require('../botbase');
const OresUtils = require('../OresUtils');
const TextExtractor = require('../TextExtractor')(bot);

(async function () {

	/* GET DATA FROM DATABASE */

	log('[i] Started');

	await bot.getTokensAndSiteInfo();

	let revidsTitles = {},
		tableInfo = {};

	let talkpages = (await new bot.category('Good article nominees awaiting review').pages())
		.map(page => page.title);

	let articles = talkpages.map(pg => pg.slice('Talk:'.length));


	/* GET CONTENT AND SHORTDESCS */

	for await (let data of bot.massQueryGen({
		"action": "query",
		"prop": "revisions|description",
		"rvprop": "ids|content",
		"rvsection": '0',
		"titles": articles
	})) {
		log(`[+] Got a page of the API response for article texts and descriptions`);
		let pages = data.query.pages;

		pages.forEach(pg => {
			try {
				if (pg.missing) {
					return;
				}
				revidsTitles[pg.revisions[0].revid] = pg.title;
				tableInfo[pg.title] = {
					shortdesc: pg.description,
					excerpt: TextExtractor.getExtract(pg.revisions[0].content, 300, 550)
				};
			} catch (e) {
				log(`[E] error in processing ${pg.title}`);
			}

		});
	}

	log('[S] Got articles');

	/* GET NOMINATION DATA */

	let counts = {
		old: 0,
		recent: 0,
		new: 0
	};

	for await (let data of bot.massQueryGen({
		"action": "query",
		"prop": "revisions",
		"rvprop": "content",
		"rvsection": "0",
		"titles": talkpages,
	})) {
		log(`[+] Got a page of the API response for talk page texts`);
		let pages = data.query.pages;
		pages.forEach(async pg => {
			if (pg.missing) {
				return;
			}
			let article = pg.title.slice('Talk:'.length);
			if (!tableInfo[article]) {
				log(`[E] no article found for talk page ${pg.title}`);
				return;
			}

			let text = pg.revisions[0].content;

			const getGATemplateFromText = function(text) {
				let wkt = new bot.wikitext(text);
				let template = wkt.parseTemplates({
					count: 1,
					namePredicate: name => name === 'GA nominee'
				})[0];
	
				if (!template) {
					template = wkt.parseTemplates({
						recursive: true
					}).find(t => t.name === 'GA nominee');
				}
				return template;
			};

			let template = getGATemplateFromText(text);
			
			if (!template) {
				// get whole page
				text = (await bot.read(pg.title)).revisions[0].content;
				template = getGATemplateFromText(text);

				if (!template) {
					log(`[E] No {{GA nominee}} on ${pg.title}`);
				}
				return;
			}

			tableInfo[article].date = template[1];
			tableInfo[article].nominator = template[2];

			let date = new xdate(template[1]);
			if (date.isAfter(new xdate().subtract(30, 'days'))) {
				tableInfo[article].class = 'new';
				counts.new++;
			} else if (date.isAfter(new xdate().subtract(90, 'days'))) {
				counts.recent++;
				tableInfo[article].class = 'recent';
			} else {
				counts.old++;
				tableInfo[article].class = 'old';
			}

		});
	}



	/* GET DATA FROM ORES */

	var pagelist = Object.keys(revidsTitles);
	if (argv.size) {
		pagelist = pagelist.slice(0, argv.size);
	}

	let oresdata = await OresUtils.queryRevisions(['drafttopic'], pagelist);


	/* PROCESS ORES DATA, SORT PAGES INTO TOPICS */

	/**
	 * sorter: Object with topic names as keys,
	 * array of page objects as values, each page object being
	 * {
	 * 	title: 'title of the page ,
	 *	revid: '972384329',
	 * }
	 * Populated through OresUtils.processTopicsForPage
	 */
	var sorter = {
		"Unsorted/Unsorted*": []
	};

	Object.entries(oresdata).forEach(function ([revid, ores]) {

		var title = revidsTitles[revid];
		if (!title) {
			log(`[E] revid ${revid} couldn't be matched to title`);
		}

		var topics = ores.drafttopic; // Array of topics
		var toInsert = { title, revid };

		OresUtils.processTopicsForPage(topics, sorter, toInsert);

	});

	/* FORMAT DATA TO BE SAVED ON THE WIKI */

	var isStarred = x => x.endsWith('*');
	var meta = x => x.split('/').slice(0, -1).join('/');

	var createSection = function (topic) {
		var pagetitle = topic;
		if (isStarred(topic)) {
			pagetitle = meta(topic);
		}
		var table = new mwn.table();
		table.addHeaders([
			{label: 'Date', class: 'date-header'},
			{label: 'Article', class: 'article-header'}, 
			{label: 'Excerpt', class: 'excerpt-header'},
			{label: 'Nominator', class: 'nominator-header'}
		]);

		sorter[topic].map(function (page) {
			var tabledata = tableInfo[page.title];

			let formatted_date = new xdate(tabledata.date).format('YYYY-MM-DD HH:mm');

			let row = [
				{ label: formatted_date || '[Failed to parse]', class: tabledata.class },
				`[[${page.title}]] ${tabledata.shortdesc ? `(<small>${tabledata.shortdesc}</small>)` : ''}`,
				tabledata.excerpt,
				tabledata.nominator || '[Failed to parse]'
			];

			row.class = tabledata.class;
			return row;

		}).sort(function (a, b) {
			// sort by date
			return a[0].label < b[0].label ? -1 : 1;

		}).forEach(function (row) {
			table.addRow(row);
		});

		return [pagetitle, table.getText()];
	};

	var makeMainPage = function () {
		var count = Object.keys(revidsTitles).length;

		var content = `{{/header|count=${count}|countold=${counts.old}|countrecent=${counts.recent}|countnew=${counts.new}|date=${new xdate().format('D MMMM YYYY')}|ts=~~~~~}}\n`;
		Object.keys(sorter).sort(OresUtils.sortTopics).forEach(topic => {
			var [sectionTitle, sectionText] = createSection(topic);
			content += `\n==${sectionTitle}==\n`;
			content += sectionText + '\n';
		});
		content += '\n{{reflist-talk}}';
		content = TextExtractor.finalSanitise(content);

		if (!argv.dry) {
			return bot.save('User:SDZeroBot/GAN sorting', content, 'Updating report');
		}

	}
	await makeMainPage();

	log(`[i] Finished`);

})().catch(err => emailOnError(err, 'gan-sorting'));


// const userFromSignature = function (sig) {
// 	let wkt = new bot.wikitext(sig);
// 	wkt.parseLinks();
// 	for (let link of wkt.links) {
// 		let title = new bot.title(link.target);
// 		if (title.namespace === 2 || title.namespace === 3) {
// 			return title.getMainText().split('/')[0];
// 		} else if (title.namespace === -1) {
// 			let splPgName = title.title.split('/')[0];
// 			if (splPgName === 'Contributions' || splPgName === 'Contribs') {
// 				return title.title.split('/')[1];
// 			}
// 		}
// 	}
// 	return null;
// };