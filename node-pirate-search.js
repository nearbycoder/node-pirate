var request = require('request');
var cheerio = require('cheerio');
var Table = require('cli-table');
var colors = require('colors');
var inquirer = require("inquirer");
var _ = require('lodash');
var program = require('commander');

program
	.usage('[options]')
  .description('Search for shows by title, category and filter by seeders or leachers')
	.option('-t, --title, <n>', 'Search by title name')
	.option('-c, --category, <n>', 'Select type (movies, audio, games, app)')
	.option('-o, --order, <n>', 'Select order results by top seeders or leachers(s, l)')
	.parse(process.argv);

var argv = program;
var titlePrompt = {
	type: 'input',
	name: 'title',
	message: 'Please enter a title to search for?',
};
var categoryPrompt = {
	type: 'input',
	name: 'category',
	message: 'Please enter a category to search for?(movies, audio, games, app)',
	default: 'all'
};

var orderPrompt = {
	type: 'input',
	name: 'order',
	message: 'Would you like to order results by top seeders or leachers?(s or l)',
	default: 'none'
};

var prompts = [];

if(_.isUndefined(argv.title)){
	prompts.push(titlePrompt);
}

if(_.isUndefined(argv.category)){
	prompts.push(categoryPrompt);
}

if(_.isUndefined(argv.order)){
	prompts.push(orderPrompt);
}

if(prompts.length){
	inquirer.prompt(prompts, function(answers){
		Search(_.assign(argv,answers))
	});
}else{
	Search(argv);
}

function Search(argv){
	switch(argv.category) {
		case 'movies':
			var searchType = 200;
		break;
		case 'audio':
			var searchType = 100;
		break;
		case 'games':
			var searchType = 400;
		break;
		case 'app':
			var searchType = 300;
		break;
		default:
			var searchType = 0;
		break;
	}

	switch(argv.order) {
		case 's':
			var order = 7;
		break;
		case 'l':
			var order = 9;
		break;
		default:
			var order = 99;
		break;
	}
	// Let's scrape Anchorman 2
	url = 'https://thepiratebay.la/search/'+ encodeURI(argv.title) +'/0/'+ order +'/' + searchType;
	request(url, function(error, response, html){
		if(!error){
			var $ = cheerio.load(html);

			var title, release, rating;
			var json = [];
			var x = 0;
			var table = new Table({
			  head: ['Type'.green, 'Name'.green, 'Id'.green, 'Seeders'.green, 'Leachers'.green, 'Filesize'.green, 'Upload Date'.green],
			  style: { 'padding-left': 0, 'padding-right': 0 }
			});
			$('.detName').each(function(){
				
        var data = $(this);
        var type = data.parent().parent().find('.vertTh').children('center').children('a').text();
        var title = data.children('.detLink').text();
        var seeders = data.parent().next().text();
        var leachers = data.parent().next().next().text();
        var id = data.children('.detLink').attr('href').split('/')[2]
        var info = data.parent().children('.detDesc').text().split(',');
        var filesize = info[1].replace(" Size ", "");
        var uploaddate = info[0].replace("Uploaded ", "");

        if(x%2 == 0){
        	table.push([type.green, title.green, id.green, seeders.green, leachers.green, filesize.green, uploaddate.green]);
				}else{
					table.push([type.blue, title.blue, id.blue, seeders.blue, leachers.blue, filesize.blue, uploaddate.blue]);
				}
        x = x +1;
      })
		}

		

		console.log(table.toString());

	})
}
